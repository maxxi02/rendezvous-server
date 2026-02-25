import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { connectDatabase } from "./config/database";
import { handleSocketEvents, setSocketIOInstance } from "./events/socketEvents";
import { setMessagingDb } from "./lib/messaging.socket";
import mongoose from "mongoose";
import { emitSalesUpdated } from "./events/socketEvents";

dotenv.config();

const PORT = process.env.PORT || 8080;

const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((o) =>
  o.trim(),
) || [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://rendezvouscafe.vercel.app",
  "https://rendezvous-cafe.vercel.app",
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST"],
  credentials: true,
};

const app = express();
const httpServer = createServer(app);

app.use(cors(corsOptions));
app.use(express.json());

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

const io = new Server(httpServer, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
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
