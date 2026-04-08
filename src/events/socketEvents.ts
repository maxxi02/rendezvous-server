import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import { UserStatusUpdate } from "../types/userStatus.type";
import { registerMessagingHandlers } from "../lib/messaging.socket";
import { emitCustomerOrder, registerOrderHandlers } from "../lib/order.socket";
import { CustomerOrder } from "../types/order.type";
import { registerInventoryHandlers } from "./inventoryEvents";
import { registerTableHandlers } from "./tableEvents";


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

interface PrintJob {
  jobId: string;
  target: "receipt" | "kitchen" | "both";
  input: ReceiptBuildInput;
}

interface ReceiptBuildInput {
  orderNumber: string;
  customerName: string;
  cashier: string;
  timestamp: Date;
  orderType: "dine-in" | "takeaway";
  tableNumber?: string;
  orderNote?: string;
  sourceOrderId?: string;
  items: Array<{
    name: string;
    price: number;
    quantity: number;
    hasDiscount?: boolean;
    menuType?: "food" | "drink";
  }>;
  subtotal: number;
  discountTotal: number;
  total: number;
  paymentMethod: "cash" | "gcash" | "split";
  splitPayment?: { cash: number; gcash: number };
  amountPaid?: number;
  change?: number;
  seniorPwdCount?: number;
  seniorPwdIds?: string[];
  isReprint?: boolean;
  businessName: string;
  businessAddress?: string;
  businessPhone?: string;
  businessLogo?: string;
  receiptMessage?: string;
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

let cachedPrinterStatus = { usb: false, bt: false };
// Per-socket throttle: track last relay timestamp to enforce 5s minimum interval
const printerStatusLastEmit = new Map<string, number>();
const PRINTER_STATUS_THROTTLE_MS = 5000;

// ─── Event Handlers ──────────────────────────────────────────────

const handleConnection = (io: Server, socket: Socket) => {
  const userId = socket.handshake.auth.userId as string | undefined;
  const userName = socket.handshake.auth.userName as string | undefined;
  const userAvatar = socket.handshake.auth.userAvatar as string | undefined;

  // Allow anonymous connections for customer portal guests
  const effectiveUserId = userId || `guest:${socket.id}`;

  // Store user data in socket for later use
  socket.data.userId = effectiveUserId;
  socket.data.userName = userName || "Guest";
  socket.data.userAvatar = userAvatar;

  if (userId) {
    // Authenticated user — join their personal room
    const userRoom = getUserRoom(userId);
    socket.join(userRoom);
    log.info(`User joined room: ${userRoom}`);
  }

  registerMessagingHandlers(io, socket);
  registerInventoryHandlers(io, socket);
  registerTableHandlers(io, socket);

  registerOrderHandlers(io, socket);

  log.success("Client connected", {
    socketId: socket.id,
    userId: effectiveUserId,
  });

  // User comes online
  socket.on("user:online", async () => {
    try {
      if (userId) await setUserOnline(userId);

      const update: UserStatusUpdate = {
        userId: effectiveUserId,
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
      if (userId) await updateUserActivity(userId);
    } catch (error) {
      log.error("Error in user:activity", error);
    }
  });

  socket.on(
    "companion:printer:status",
    (status: { usb: boolean; bt: boolean }) => {
      const now = Date.now();
      const last = printerStatusLastEmit.get(socket.id) ?? 0;
      if (now - last < PRINTER_STATUS_THROTTLE_MS) return; // drop — too soon
      printerStatusLastEmit.set(socket.id, now);

      cachedPrinterStatus = status;
      io.to("pos:cashiers").emit("companion:printer:status", status);
      log.info("Printer status relayed to pos:cashiers", status);
    },
  );

  socket.on("print:request", (job: PrintJob) => {
    try {
      log.info(`Print request received: ${job.jobId} → ${job.target}`);

      // Relay to companion app for actual printing
      io.to("pos:cashiers").emit("print:job", job);

      // Also broadcast as an order:queue:updated so all companions
      // can show the order in their Orders tab immediately
      // Only append if it's a new POS checkout (no sourceOrderId)
      if (job.input && !job.input.sourceOrderId) {
        const orderPayload = {
          orderId: `pos-${job.jobId}`,
          orderNumber: job.input.orderNumber,
          customerName: job.input.customerName,
          cashier: job.input.cashier,
          items: job.input.items,
          orderType: job.input.orderType,
          tableNumber: job.input.tableNumber,
          orderNote: job.input.orderNote,
          total: job.input.total,
          subtotal: job.input.subtotal,
          discountTotal: job.input.discountTotal,
          paymentMethod: job.input.paymentMethod,
          queueStatus: "preparing",
          createdAt: job.input.timestamp,
        };
        io.to("pos:cashiers").emit("order:queue:updated", {
          orderId: orderPayload.orderId,
          queueStatus: "preparing",
          order: orderPayload,
        });
      }

      log.success(`Print job relayed to pos:cashiers: ${job.jobId}`);
    } catch (error) {
      log.error("Error in print:request", error);
      socket.emit("print:error", {
        jobId: job.jobId,
        error: "Failed to relay print job",
      });
    }
  });

  socket.on(
    "print:qr",
    (data: { url: string; label: string; jobId: string }) => {
      try {
        log.info(`QR print request received: ${data.jobId} for ${data.label}`);

        // Relay to pos:cashiers room where the companion app is joined
        io.to("pos:cashiers").emit("print:qr", data);

        log.success(`QR print request relayed to pos:cashiers: ${data.jobId}`);
      } catch (error) {
        log.error("Error in print:qr", error);
        socket.emit("print:error", {
          jobId: data.jobId,
          error: "Failed to relay QR print job",
        });
      }
    },
  );

  socket.on(
    "print:zreport",
    (data: any) => {
      try {
        // POS sends: { jobId: "...", data: { businessName, totalSales, ... } }
        // We must forward the inner `data` payload, not the whole wrapper.
        const jobId = data.jobId || `zreport-${Date.now()}`;
        const reportData = data.data ?? data; // graceful fallback if already flat
        log.info(`Z-Report print request received: ${jobId}`);

        // Relay to pos:cashiers room where the companion app is joined
        io.to("pos:cashiers").emit("print:zreport", { data: reportData, jobId });

        log.success(`Z-Report print request relayed to pos:cashiers: ${jobId}`);
      } catch (error) {
        log.error("Error in print:zreport", error);
        socket.emit("print:error", {
          jobId: data?.jobId || "unknown",
          error: "Failed to relay Z-Report print job",
        });
      }
    },
  );

  socket.on(
    "print:job:result",
    (result: {
      jobId: string;
      success: boolean;
      receipt?: boolean;
      kitchen?: boolean;
      error?: string;
    }) => {
      log.info(`Print job result: ${result.jobId}`, result);

      // Relay result back to POS cashiers so printBoth() Promise can resolve
      io.to("pos:cashiers").emit("print:job:result", result);
    },
  );

  socket.on(
    "print:raw:request",
    (data: { target: "usb" | "bluetooth"; bytes: number[]; jobId: string }) => {
      try {
        io.to("pos:cashiers").emit("print:raw", data);
        log.info(
          `Raw print bytes relayed: ${data.jobId} → ${data.target} (${data.bytes.length} bytes)`,
        );
      } catch (error) {
        log.error("Error relaying raw print", error);
      }
    },
  );

  socket.on(
    "print:raw:result",
    (result: { jobId: string; success: boolean }) => {
      log.info(
        `Raw print result: ${result.jobId} → ${result.success ? "✅" : "❌"}`,
      );
    },
  );

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
    socket.emit("companion:printer:status", cachedPrinterStatus);
    log.info(`POS cashier joined room: pos:cashiers`, { socketId: socket.id, sentCachedStatus: cachedPrinterStatus });
  });

  // ─── Customer: Mark Order as Done ────────────────────────────────

  socket.on("order:customer:done", async ({ orderId }: { orderId: string }) => {
    try {
      if (!orderId) {
        socket.emit("order:customer:done:error", { message: "orderId is required" });
        return;
      }

      if (!mongoose.connection.db) {
        socket.emit("order:customer:done:error", { message: "Database not connected" });
        return;
      }

      const ordersCollection = mongoose.connection.db.collection("orders");

      const updated = await ordersCollection.findOneAndUpdate(
        { orderId, queueStatus: "serving" },
        { $set: { queueStatus: "done", doneAt: new Date(), updatedAt: new Date() } },
        { returnDocument: "after" },
      );

      if (!updated) {
        // Order not found or not in serving phase — silently ignore
        log.warn(`order:customer:done — order not found or not serving: ${orderId}`);
        socket.emit("order:customer:done:error", { message: "Order not found or not in serving phase" });
        return;
      }

      log.success(`Customer marked order done: ${orderId}`);

      // Notify ALL POS clients so QueueBoard removes the card
      io.emit("order:queue:updated", {
        orderId: updated.orderId,
        queueStatus: "done",
        order: updated,
      });

      // Notify the customer's own session room so waiting page transitions to "done"
      const sessionRoom = `session:${socket.id}`;
      io.to(sessionRoom).emit("order:status:changed", {
        orderId: updated.orderId,
        orderNumber: updated.orderNumber,
        queueStatus: "done",
      });
    } catch (error) {
      log.error("Error in order:customer:done", error);
      socket.emit("order:customer:done:error", { message: "Failed to mark order as done" });
    }
  });

  // User disconnects
  socket.on("disconnect", async (reason) => {
    try {
      printerStatusLastEmit.delete(socket.id);

      // If the companion app disconnects, notify POS that printers are offline
      if (socket.rooms.has("pos:cashiers")) {
        cachedPrinterStatus = { usb: false, bt: false };
        io.to("pos:cashiers").emit("companion:printer:status", cachedPrinterStatus);
        log.info("Companion disconnected — printer status reset to offline");
      }

      if (userId) await setUserOffline(userId);

      const update: UserStatusUpdate = {
        userId: effectiveUserId,
        isOnline: false,
        lastSeen: new Date(),
      };

      io.emit("user:status:changed", update);

      log.info("Client disconnected", { userId: effectiveUserId, reason });
    } catch (error) {
      log.error("Error in disconnect", error);
    }
  });

  // Handle errors
  socket.on("error", (error) => {
    log.error("Socket error", { userId, error });
  });
};

// ─── Sales Analytics ─────────────────────────────────────────────

export const emitSalesUpdated = (io: Server) => {
  io.emit("sales:updated", { timestamp: new Date() });
  log.info("sales:updated emitted to all clients");
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

const notifySalesUpdate = async () => {
  try {
    await fetch(`${process.env.SOCKET_SERVER_URL}/internal/sales-updated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": process.env.INTERNAL_SECRET || "",
      },
    });
  } catch (err) {
    // Non-critical — don't fail the payment if this errors
    console.warn("Could not notify socket server:", err);
  }
};

// ─── Cash Management ─────────────────────────────────────────────

export const emitCashUpdated = (io: Server) => {
  io.emit("cash:updated", { timestamp: new Date() });
  log.info("cash:updated emitted to all clients");
};

export const emitRegisterClosed = (
  io: Server,
  data: { cashierName: string; registerName: string; closedAt: string },
) => {
  io.emit("register:closed", { ...data, timestamp: new Date() });
  log.info("register:closed emitted", data);
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
