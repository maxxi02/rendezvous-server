// server.ts
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { connectDatabase } from "./config/database";
import { handleSocketEvents } from "./events/socketEvents";

dotenv.config();

// ─── Configuration ───────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((origin) =>
  origin.trim(),
) || ["http://localhost:3000", "https://rendezvouscafe.vercel.app"];

const corsOptions = {
  origin: allowedOrigins,
  methods: ["GET", "POST"],
  credentials: true,
};

// ─── Express Setup ───────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);

app.use(cors(corsOptions));
app.use(express.json());

// ─── Socket.IO Setup ─────────────────────────────────────────────

const io = new Server(httpServer, {
  cors: corsOptions,
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ─── Routes ──────────────────────────────────────────────────────

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
  res.json({
    message: "Socket.IO Server Running",
    version: "1.0.0",
  });
});

// ─── Socket Events ───────────────────────────────────────────────

handleSocketEvents(io);

// ─── Server Startup ──────────────────────────────────────────────

const startServer = async () => {
  try {
    await connectDatabase();

    httpServer.listen(PORT, () => {
      console.log("━".repeat(50));
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`🔗 Allowed origins:`);
      allowedOrigins.forEach((origin) => console.log(`   • ${origin}`));
      console.log("━".repeat(50));
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

// ─── Graceful Shutdown ───────────────────────────────────────────

const gracefulShutdown = async (signal: string) => {
  console.log(`\n📡 ${signal} received, shutting down gracefully...`);

  httpServer.close(() => {
    console.log("✅ HTTP server closed");
  });

  io.close(() => {
    console.log("✅ Socket.IO server closed");
  });

  // Close database connection if you have a close function
  // await closeDatabase();

  process.exit(0);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// ─── Start ───────────────────────────────────────────────────────

startServer();
