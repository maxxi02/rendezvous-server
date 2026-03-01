// src/lib/order.socket.ts

import { Server, Socket } from "socket.io";
import { Order } from "../models/Order";
import { CustomerOrder, QueueStatus } from "../types/order.type";
import type { OrderQueueUpdatePayload } from "../types/order.type";
import mongoose from "mongoose";

const log = {
  success: (msg: string, data?: unknown) =>
    console.log(`✅ [Order] ${msg}`, data ? JSON.stringify(data) : ""),
  error: (msg: string, data?: unknown) =>
    console.error(`❌ [Order] ${msg}`, data ? JSON.stringify(data) : ""),
  info: (msg: string, data?: unknown) =>
    console.log(`ℹ️  [Order] ${msg}`, data ? JSON.stringify(data) : ""),
};

// Timestamp field mapping for each queue status
const statusTimestampMap: Record<string, string> = {
  paid: "paidAt",
  preparing: "preparingAt",
  ready: "readyAt",
  served: "servedAt",
  completed: "completedAt",
  cancelled: "cancelledAt",
};

// Generate order number for the day (e.g. "#001")
const generateOrderNumber = async (): Promise<string> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const count = await Order.countDocuments({
    createdAt: { $gte: today },
  });

  return `#${String(count + 1).padStart(3, "0")}`;
};

// Emit a customer order to POS cashiers (existing behavior preserved)
export const emitCustomerOrder = (io: Server, order: CustomerOrder): void => {
  io.to("pos:cashiers").emit("order:new", order);
  log.success(`Customer order emitted to POS cashiers`, {
    orderId: order.orderId,
  });
};

// Register order-related socket handlers
export function registerOrderHandlers(io: Server, socket: Socket): void {
  const userId = socket.data.userId as string;

  // ─── Join session room (customer portal calls this on connect) ──
  socket.on("session:join", (data: { sessionId: string }) => {
    if (!data?.sessionId) return;
    const room = `session:${data.sessionId}`;
    socket.join(room);
    log.info(`Socket ${socket.id} joined session room: ${room}`);
  });

  // ─── Submit an order (from customer portal) ─────────────────────
  socket.on("order:submit", async (order: CustomerOrder) => {
    try {
      const orderNumber = await generateOrderNumber();

      const savedOrder = await Order.create({
        ...order,
        orderNumber,
        queueStatus: "pending_payment",
        paymentStatus: "pending",
      });

      // Automatically set table to occupied if there's a table associated
      if (order.tableNumber) {
        try {
          const db = mongoose.connection.db;
          if (db) {
            await db.collection("tables").findOneAndUpdate(
              { tableId: order.tableNumber },
              {
                $set: {
                  status: "occupied",
                  currentSessionId: order.sessionId || null,
                  updatedAt: new Date(),
                },
              },
            );
          }
        } catch (tableErr) {
          log.error("Failed to update table status", tableErr);
        }
      }

      // Emit to POS
      io.to("pos:cashiers").emit("order:new", savedOrder.toObject());

      // Confirm to customer
      const sessionRoom = `session:${order.sessionId}`;
      io.to(sessionRoom).emit("order:submitted", {
        orderId: savedOrder.orderId,
        orderNumber,
        queueStatus: "pending_payment",
      });

      log.success(`Order submitted: ${savedOrder.orderId} (${orderNumber})`);
    } catch (error) {
      log.error("Error submitting order", error);
      socket.emit("order:submit:error", {
        message: "Failed to submit order",
      });
    }
  });

  // ─── Update queue status (from POS staff) ───────────────────────
  socket.on("order:queue:update", async (data: OrderQueueUpdatePayload) => {
    try {
      const updateData: Record<string, unknown> = {
        queueStatus: data.queueStatus,
      };

      // Set the corresponding timestamp
      const timestampField = statusTimestampMap[data.queueStatus];
      if (timestampField) {
        updateData[timestampField] = new Date();
      }

      // If paid, also update payment status
      if (data.queueStatus === "paid") {
        updateData.paymentStatus = "paid";
      }

      const order = await Order.findOneAndUpdate(
        { orderId: data.orderId },
        { $set: updateData },
        { new: true },
      );

      if (!order) {
        socket.emit("order:queue:update:error", {
          message: "Order not found",
        });
        return;
      }

      // Broadcast to all POS
      io.to("pos:cashiers").emit("order:queue:updated", {
        orderId: data.orderId,
        queueStatus: data.queueStatus,
        order: order.toObject(),
      });

      // Notify the customer via session room
      if (order.sessionId) {
        const sessionRoom = `session:${order.sessionId}`;
        io.to(sessionRoom).emit("order:status:changed", {
          orderId: data.orderId,
          orderNumber: order.orderNumber,
          queueStatus: data.queueStatus,
        });
      }

      log.success(`Order queue updated: ${data.orderId} → ${data.queueStatus}`);
    } catch (error) {
      log.error("Error updating order queue", error);
      socket.emit("order:queue:update:error", {
        message: "Failed to update order status",
      });
    }
  });

  // ─── Confirm payment (from webhook or manual) ───────────────────
  socket.on(
    "order:payment:confirmed",
    async (data: { orderId: string; paymentReference: string }) => {
      try {
        const order = await Order.findOneAndUpdate(
          { orderId: data.orderId },
          {
            $set: {
              paymentStatus: "paid",
              paymentReference: data.paymentReference,
              queueStatus: "paid",
              paidAt: new Date(),
            },
          },
          { new: true },
        );

        if (!order) {
          socket.emit("order:payment:error", {
            message: "Order not found",
          });
          return;
        }

        // Notify POS
        io.to("pos:cashiers").emit("order:queue:updated", {
          orderId: data.orderId,
          queueStatus: "paid",
          order: order.toObject(),
        });

        // Notify customer
        if (order.sessionId) {
          const sessionRoom = `session:${order.sessionId}`;
          io.to(sessionRoom).emit("order:payment:success", {
            orderId: data.orderId,
            orderNumber: order.orderNumber,
            queueStatus: "paid",
          });
        }

        log.success(`Payment confirmed: ${data.orderId}`);
      } catch (error) {
        log.error("Error confirming payment", error);
        socket.emit("order:payment:error", {
          message: "Failed to confirm payment",
        });
      }
    },
  );

  // ─── Fetch queue orders (for POS board) ─────────────────────────
  socket.on("order:queue:list", async (data?: { statuses?: QueueStatus[] }) => {
    try {
      const statuses = data?.statuses || [
        "paid",
        "preparing",
        "ready",
        "served",
      ];

      const orders = await Order.find({
        queueStatus: { $in: statuses },
      })
        .sort({ createdAt: 1 })
        .lean();

      socket.emit("order:queue:list:result", orders);

      log.info(`Queue list fetched: ${orders.length} orders`);
    } catch (error) {
      log.error("Error fetching queue list", error);
      socket.emit("order:queue:list:error", {
        message: "Failed to fetch orders",
      });
    }
  });

  // ─── Fetch order by ID (for customer tracking) ──────────────────
  socket.on("order:get", async (data: { orderId: string }) => {
    try {
      const order = await Order.findOne({ orderId: data.orderId }).lean();

      if (!order) {
        socket.emit("order:get:error", { message: "Order not found" });
        return;
      }

      socket.emit("order:get:result", order);
    } catch (error) {
      log.error("Error fetching order", error);
      socket.emit("order:get:error", { message: "Failed to fetch order" });
    }
  });
}
