import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";
import { connectDatabase } from "./config/database";
import { handleSocketEvents } from "./events/socketEvents";

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Parse CORS_ORIGIN (handles comma-separated list)
const allowedOrigins = process.env.CORS_ORIGIN?.split(",").map((origin) =>
  origin.trim(),
) || ["http://localhost:3000", "https://rendezvouscafe.vercel.app"];

console.log("✅ Allowed CORS origins:", allowedOrigins);

// Socket.IO setup with CORS
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
);
app.use(express.json());

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date(),
    allowedOrigins,
    port: PORT,
  });
});

// Socket.IO events
handleSocketEvents(io);

// Use Render's PORT or fallback to 8080
const PORT = process.env.PORT || 8080;

const startServer = async () => {
  try {
    // Connect to database
    await connectDatabase();

    httpServer.listen(PORT, () => {
      console.log(`🚀 Socket.IO server running on port ${PORT}`);
      console.log(`🌍 Allowed origins: ${allowedOrigins.join(", ")}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
