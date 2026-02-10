// events/socketEvents.ts
import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import { UserStatusUpdate } from "../types/userStatus.type";

// ─── Helpers ─────────────────────────────────────────────────────

const getUserCollection = () => {
  if (!mongoose.connection.db) {
    throw new Error("Database not connected");
  }
  return mongoose.connection.db.collection("user");
};

const log = {
  info: (msg: string, data?: any) =>
    console.log(`ℹ️  ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  success: (msg: string, data?: any) =>
    console.log(`✅ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  error: (msg: string, data?: any) =>
    console.error(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  warn: (msg: string, data?: any) =>
    console.warn(`⚠️  ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
};

// ─── User Service ────────────────────────────────────────────────

const setUserOnline = async (userId: string): Promise<void> => {
  const userCollection = getUserCollection();

  await userCollection.updateOne(
    { id: userId },
    {
      $set: {
        isOnline: true,
        lastSeen: new Date(),
      },
    },
  );

  log.success(`User online: ${userId}`);
};

const setUserOffline = async (userId: string): Promise<void> => {
  const userCollection = getUserCollection();

  await userCollection.updateOne(
    { id: userId },
    {
      $set: {
        isOnline: false,
        lastSeen: new Date(),
      },
    },
  );

  log.info(`User offline: ${userId}`);
};

const updateUserActivity = async (userId: string): Promise<void> => {
  const userCollection = getUserCollection();

  await userCollection.updateOne(
    { id: userId },
    {
      $set: {
        lastSeen: new Date(),
        isOnline: true,
      },
    },
  );
};

// ─── Event Handlers ──────────────────────────────────────────────

const handleConnection = (io: Server, socket: Socket) => {
  const userId = socket.handshake.auth.userId as string | undefined;

  if (!userId) {
    log.warn("Connection rejected: No userId", { socketId: socket.id });
    socket.disconnect();
    return;
  }

  log.success("Client connected", { socketId: socket.id, userId });

  // User comes online
  socket.on("user:online", async () => {
    try {
      await setUserOnline(userId);

      const update: UserStatusUpdate = {
        userId,
        isOnline: true,
        lastSeen: new Date(),
      };

      io.emit("user:status:changed", update);
    } catch (error) {
      log.error("Error in user:online", error);
      socket.emit("error", { message: "Failed to update online status" });
    }
  });

  // User activity
  socket.on("user:activity", async () => {
    try {
      await updateUserActivity(userId);
    } catch (error) {
      log.error("Error in user:activity", error);
    }
  });

  // User disconnects
  socket.on("disconnect", async (reason) => {
    try {
      await setUserOffline(userId);

      const update: UserStatusUpdate = {
        userId,
        isOnline: false,
        lastSeen: new Date(),
      };

      io.emit("user:status:changed", update);

      log.info("Client disconnected", { userId, reason });
    } catch (error) {
      log.error("Error in disconnect", error);
    }
  });

  // Handle errors
  socket.on("error", (error) => {
    log.error("Socket error", { userId, error });
  });
};

// ─── Main Export ─────────────────────────────────────────────────

export const handleSocketEvents = (io: Server): void => {
  io.on("connection", (socket) => handleConnection(io, socket));
  log.info("Socket.IO event handlers registered");
};
