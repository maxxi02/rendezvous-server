import dns from "node:dns";
dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
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
    "http://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "https://rendezvouscafe.vercel.app",
    "https://rendezvous-cafe.vercel.app",
    "http://localhost:8000",
    "http://localhost:8001",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8001",
    "http://192.168.1.56:8080",
    "http://192.168.1.56:8081",
    "http://192.168.1.56:3000",
    "http://192.168.1.56:3001",
  ];

  const origins = Array.from(new Set([...envOrigins, ...defaultOrigins]));
  console.log(
    `[CORS] Final allowed origins list initialized with ${origins.length} entries`,
  );
  return origins;
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

app.post("/internal/tables-updated", (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const tableData = req.body;
    io.emit("table:updated", tableData);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to emit" });
  }
});

app.post("/internal/order-create", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const orderData = req.body;
    if (!orderData?.orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    // Check if order already exists to prevent duplicates
    const existingOrder = await Order.findOne({ orderId: orderData.orderId });
    if (existingOrder) {
      return res.json(existingOrder);
    }

    const order = await Order.create(orderData);
    console.log(`✅ Order created successfully: ${order.orderId}`);

    // Broadcast newly created order so POS gets pending table orders (dine-in) instantly
    io.emit("order:queue:updated", {
      orderId: order.orderId,
      queueStatus: order.queueStatus || "pending_payment",
      order,
    });

    res.json(order);
  } catch (error: any) {
    console.error("❌ Error creating order:", error);
    res.status(500).json({ error: error.message || "Failed to create order" });
  }
});

app.post("/internal/payment-confirmed", async (req, res) => {
  try {
    const secret = req.headers["x-internal-secret"];
    if (process.env.INTERNAL_SECRET && secret !== process.env.INTERNAL_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { orderId, paymentReference } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: "orderId is required" });
    }

    const order = await Order.findOneAndUpdate(
      { orderId },
      {
        $set: {
          paymentStatus: "paid",
          queueStatus: "queueing",
          paymentReference: paymentReference || null,
          paidAt: new Date(),
          queueingAt: new Date(),
        },
      },
      { new: true },
    );

    if (!order) {
      console.warn(
        `[payment-confirmed] Order not found for orderId: ${orderId}`,
      );
      return res.status(404).json({ error: "Order not found" });
    }

    console.log(`✅ Payment confirmed for order: ${orderId}`);

    // Notify the customer's session room
    if (order.sessionId) {
      io.to(`session:${order.sessionId}`).emit("order:status:changed", {
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        queueStatus: order.queueStatus,
        paymentStatus: order.paymentStatus,
      });
    }

    // Broadcast to all staff POS clients so QueueBoard adds the order in real-time.
    // Shape must match what QueueBoard's handleQueueUpdate expects:
    // { orderId, queueStatus, order }
    io.emit("order:queue:updated", {
      orderId: order.orderId,
      queueStatus: order.queueStatus,
      order,
    });

    res.json({ success: true, order });
  } catch (error: any) {
    console.error("❌ Error confirming payment:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to confirm payment" });
  }
});

const io = new Server(httpServer, {
  cors: {
    origin: "*",
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
