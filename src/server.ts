import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { connectDatabase } from "./config/database";
import { handleSocketEvents, setSocketIOInstance } from "./events/socketEvents";
import { setMessagingDb } from "./lib/messaging.socket";
import mongoose from "mongoose";
import { Order } from "./models/Order";
import {
  emitSalesUpdated,
  emitCashUpdated,
  emitRegisterClosed,
} from "./events/socketEvents";

dotenv.config();

// ─── Shared order number generator (same logic as order.socket.ts) ────────────
// Used by the synchronous /internal/order-create HTTP endpoint
const generateOrderNumber = async (): Promise<string> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const count = await Order.countDocuments({ createdAt: { $gte: today } });
  return `#${String(count + 1).padStart(3, "0")}`;
};

const PORT = process.env.PORT || 8080;

const getOrigins = () => {
  const envOrigins = (
    process.env.CORS_ORIGIN ||
    process.env.ALLOWED_ORIGINS ||
    ""
  )
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const defaultOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://rendezvouscafe.vercel.app",
    "https://rendezvous-cafe.vercel.app",
    "http://localhost:8000",
    "http://localhost:8001",
    "http://192.168.1.18:8080",
    "http://192.168.1.18:8081",
    "http://192.168.1.18:3000",
    "http://192.168.1.18:3001",
    "http://192.168.1.15:8080",
    "http://192.168.1.15:8081",
    "http://192.168.1.15:3000",
    "http://192.168.1.15:3001",
  ];

  return Array.from(new Set([...envOrigins, ...defaultOrigins]));
};

const allowedOrigins = getOrigins();

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST"],
  credentials: true,
};

const app = express();
const httpServer = createServer(app);

app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.post("/internal/sales-updated", (req, res) => {
  try {
    // Optional: protect with a shared secret
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    emitSalesUpdated(io);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to emit" });
  }
});

app.post("/internal/order-status-changed", (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { orderId, orderNumber, queueStatus, sessionId } = req.body;

    if (sessionId) {
      const sessionRoom = `session:${sessionId}`;
      io.to(sessionRoom).emit("order:status:changed", {
        orderId,
        orderNumber,
        queueStatus,
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to emit order status" });
  }
});

app.post("/internal/cash-updated", (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    emitCashUpdated(io);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to emit" });
  }
});

app.post("/internal/register-closed", (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { cashierName, registerName, closedAt } = req.body;
    emitRegisterClosed(io, { cashierName, registerName, closedAt });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to emit" });
  }
});

// ─── Order Create (called by customer portal before PayMongo payment) ────────
// This is HTTP-based (not socket) so the order is guaranteed to be in MongoDB
// before the PayMongo source is created, eliminating the webhook race condition.
app.post("/internal/order-create", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const order = req.body;
    if (!order?.orderId || !order?.customerName) {
      return res
        .status(400)
        .json({ error: "orderId and customerName are required" });
    }

    const orderNumber = await generateOrderNumber();

    const savedOrder = await Order.create({
      ...order,
      orderNumber,
      queueStatus: "pending_payment",
      paymentStatus: "pending",
      createdAt: new Date(),
    });

    // Update table status if applicable
    if (order.tableNumber || order.tableId) {
      try {
        const db = mongoose.connection.db;
        if (db) {
          const tableQuery = order.tableId
            ? { tableId: order.tableId }
            : { tableId: order.tableNumber };
          await db.collection("tables").findOneAndUpdate(tableQuery, {
            $set: {
              status: "occupied",
              currentSessionId: order.sessionId || null,
              updatedAt: new Date(),
            },
          });
        }
      } catch (tableErr) {
        console.warn("[order-create] Failed to update table status:", tableErr);
      }
    }

    const savedOrderObj = savedOrder.toObject();

    // Notify POS — OR don't, if we want it to be invisible until paid.
    // We only emit order:queue:updated so the state is technically there,
    // but the QueueBoard will filter it out.
    io.to("pos:cashiers").emit("order:queue:updated", {
      orderId: savedOrderObj.orderId,
      queueStatus: "pending_payment",
      order: savedOrderObj,
    });
    // Removed io.to("pos:cashiers").emit("order:new", savedOrderObj);
    // This prevents the confusing toast appearing before payment is done.

    console.log(
      `✅ [order-create] ${savedOrder.orderId} (${orderNumber}) saved → pending_payment`,
    );
    res.json({ success: true, orderId: savedOrder.orderId, orderNumber });
  } catch (error: any) {
    // Handle duplicate orderId (idempotent — return existing order)
    if (error?.code === 11000) {
      const existing = await Order.findOne({ orderId: req.body?.orderId });
      if (existing) {
        return res.json({
          success: true,
          orderId: existing.orderId,
          orderNumber: existing.orderNumber,
        });
      }
    }
    console.error("❌ [order-create] Error:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// ─── Payment Confirmed (called by PayMongo webhook via customer portal) ───────
app.post("/internal/payment-confirmed", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orderId, paymentReference } = req.body;
    if (!orderId || !paymentReference) {
      return res
        .status(400)
        .json({ error: "orderId and paymentReference are required" });
    }

    const order = await Order.findOneAndUpdate(
      { orderId },
      {
        $set: {
          paymentStatus: "paid",
          paymentReference,
          queueStatus: "queueing",
          paidAt: new Date(),
          queueingAt: new Date(),
        },
      },
      { new: true },
    );

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Set table to occupied
    if (order.tableId) {
      try {
        const db = mongoose.connection.db;
        if (db) {
          await db
            .collection("tables")
            .findOneAndUpdate(
              { tableId: order.tableId },
              { $set: { status: "occupied", updatedAt: new Date() } },
            );
        }
      } catch (tableErr) {
        console.warn(
          "[payment-confirmed] Failed to update table status:",
          tableErr,
        );
      }
    }

    // Notify POS — order shows up in the queue and pops a toast
    io.to("pos:cashiers").emit("order:queue:updated", {
      orderId,
      queueStatus: "queueing",
      order: order.toObject(),
    });
    io.to("pos:cashiers").emit("order:new", order.toObject());

    // Notify customer socket room — trigger redirect to /order/waiting
    if (order.sessionId) {
      io.to(`session:${order.sessionId}`).emit("order:payment:success", {
        orderId,
        orderNumber: order.orderNumber,
        queueStatus: "queueing",
      });
    }

    console.log(
      `✅ [payment-confirmed] ${orderId} → queueing (ref: ${paymentReference})`,
    );
    res.json({ success: true, orderId, queueStatus: "queueing" });
  } catch (error) {
    console.error("❌ [payment-confirmed] Error:", error);
    res.status(500).json({ error: "Failed to confirm payment" });
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Blocked origin: ${origin}`);
        callback(new Error(`Origin ${origin} not allowed`));
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
});

setSocketIOInstance(io);

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    allowedOrigins,
    port: PORT,
    connections: io.engine.clientsCount,
  });
});

app.get("/", (req, res) => {
  res.json({ message: "Socket.IO Server Running", version: "1.0.0" });
});

handleSocketEvents(io);

const startServer = async () => {
  try {
    // 1. Connect DB first
    await connectDatabase();

    setMessagingDb(mongoose.connection.db!);

    // 3. Start listening
    httpServer.listen(PORT, () => {
      console.log("━".repeat(50));
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || "dev"}`);
      console.log(`🔗 Allowed origins:`);
      allowedOrigins.forEach((o) => console.log(`   • ${o}`));
      console.log("━".repeat(50));
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal: string) => {
  console.log(`\n📡 ${signal} received, shutting down gracefully...`);
  httpServer.close(() => console.log("✅ HTTP server closed"));
  io.close(() => console.log("✅ Socket.IO server closed"));
  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

startServer();

export { io };
