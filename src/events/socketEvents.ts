import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import { UserStatusUpdate } from "../types/userStatus.type";
import { registerMessagingHandlers } from "../lib/messaging.socket";
import { emitCustomerOrder } from "../lib/order.socket";
import { CustomerOrder } from "../types/order.type";
import { registerInventoryHandlers } from "./inventoryEvents";

// ─── Types ───────────────────────────────────────────────────────

interface AttendanceUpdate {
  attendanceId: string;
  userId: string;
  status: string;
  totalHours?: number;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

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

// ─── Socket Room Management ──────────────────────────────────────

const getUserRoom = (userId: string) => `user:${userId}`;

// ─── Event Handlers ──────────────────────────────────────────────

const handleConnection = (io: Server, socket: Socket) => {
  const userId = socket.handshake.auth.userId as string | undefined;
  const userName = socket.handshake.auth.userName as string | undefined;
  const userAvatar = socket.handshake.auth.userAvatar as string | undefined;

  if (!userId) {
    log.warn("Connection rejected: No userId", { socketId: socket.id });
    socket.disconnect();
    return;
  }

  // Store user data in socket for later use
  socket.data.userId = userId;
  socket.data.userName = userName;
  socket.data.userAvatar = userAvatar;

  registerMessagingHandlers(io, socket);
  registerInventoryHandlers(io, socket);

  log.success("Client connected", { socketId: socket.id, userId });

  // Join user's personal room for targeted notifications
  const userRoom = getUserRoom(userId);
  socket.join(userRoom);
  log.info(`User joined room: ${userRoom}`);

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

  // ─── Attendance Event Triggers (from API routes) ────────────────

  socket.on(
    "attendance:approved:trigger",
    (data: {
      userId: string;
      attendanceId: string;
      status: string;
      totalHours?: number;
      approvedBy: string;
    }) => {
      try {
        emitAttendanceApproved(io, data);
      } catch (error) {
        log.error("Error in attendance:approved:trigger", error);
      }
    },
  );

  socket.on(
    "attendance:rejected:trigger",
    (data: {
      userId: string;
      attendanceId: string;
      rejectionReason: string;
      rejectedBy: string;
    }) => {
      try {
        emitAttendanceRejected(io, data);
      } catch (error) {
        log.error("Error in attendance:rejected:trigger", error);
      }
    },
  );

  socket.on(
    "attendance:status:changed:trigger",
    (data: { userId: string; attendanceId: string; status: string }) => {
      try {
        emitAttendanceStatusChange(io, data);
      } catch (error) {
        log.error("Error in attendance:status:changed:trigger", error);
      }
    },
  );

  socket.on("order:new:trigger", (order: CustomerOrder) => {
    try {
      emitCustomerOrder(io, order);
    } catch (error) {
      log.error("Error in order:new:trigger", error);
    }
  });

  socket.on("pos:join", () => {
    socket.join("pos:cashiers");
    log.info(`POS cashier joined room: pos:cashiers`, { socketId: socket.id });
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

// ─── Attendance Notification Helpers ─────────────────────────────

export const emitAttendanceApproved = (
  io: Server,
  data: {
    userId: string;
    attendanceId: string;
    status: string;
    totalHours?: number;
    approvedBy: string;
  },
) => {
  const userRoom = getUserRoom(data.userId);

  const payload: AttendanceUpdate = {
    attendanceId: data.attendanceId,
    userId: data.userId,
    status: data.status,
    totalHours: data.totalHours,
    approvedBy: data.approvedBy,
  };

  io.to(userRoom).emit("attendance:approved", payload);

  log.success(
    `Attendance approved notification sent to ${data.userId}`,
    payload,
  );
};

export const emitAttendanceRejected = (
  io: Server,
  data: {
    userId: string;
    attendanceId: string;
    rejectionReason: string;
    rejectedBy: string;
  },
) => {
  const userRoom = getUserRoom(data.userId);

  const payload: AttendanceUpdate = {
    attendanceId: data.attendanceId,
    userId: data.userId,
    status: "REJECTED",
    rejectionReason: data.rejectionReason,
    rejectedBy: data.rejectedBy,
  };

  io.to(userRoom).emit("attendance:rejected", payload);

  log.success(
    `Attendance rejected notification sent to ${data.userId}`,
    payload,
  );
};

export const emitAttendanceStatusChange = (
  io: Server,
  data: {
    userId: string;
    attendanceId: string;
    status: string;
  },
) => {
  const userRoom = getUserRoom(data.userId);

  const payload: AttendanceUpdate = {
    attendanceId: data.attendanceId,
    userId: data.userId,
    status: data.status,
  };

  io.to(userRoom).emit("attendance:status:changed", payload);

  log.info(`Attendance status change sent to ${data.userId}`, payload);
};

// ─── Main Export ─────────────────────────────────────────────────

export const handleSocketEvents = (io: Server): void => {
  io.on("connection", (socket) => {
    handleConnection(io, socket);
  });

  log.info("Socket.IO event handlers registered");
};

// Export io instance for use in API routes
let ioInstance: Server | null = null;

export const setSocketIOInstance = (io: Server): void => {
  ioInstance = io;
  log.info("Socket.IO instance registered for API routes");
};

export const getSocketIOInstance = (): Server => {
  if (!ioInstance) {
    throw new Error("Socket.IO instance not initialized");
  }
  return ioInstance;
};
