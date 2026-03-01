// src/events/tableEvents.ts

import { Server, Socket } from "socket.io";
import { Table } from "../models/Table";
import { TableSession } from "../models/TableSession";
import type {
  TableCreatePayload,
  TableUpdatePayload,
  TableDeletePayload,
  SessionStartPayload,
  SessionEndPayload,
} from "../types/table.type";

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`ℹ️  [Table] ${msg}`, data ? JSON.stringify(data) : ""),
  success: (msg: string, data?: unknown) =>
    console.log(`✅ [Table] ${msg}`, data ? JSON.stringify(data) : ""),
  error: (msg: string, data?: unknown) =>
    console.error(`❌ [Table] ${msg}`, data ? JSON.stringify(data) : ""),
};

// Generate a session room name
const getSessionRoom = (sessionId: string) => `session:${sessionId}`;
const getTableRoom = (tableId: string) => `table:${tableId}`;

export function registerTableHandlers(io: Server, socket: Socket): void {
  // ─── Admin: Create a table ──────────────────────────────────────
  socket.on("table:create", async (data: TableCreatePayload) => {
    try {
      // Count existing tables to auto-increment
      const count = await Table.countDocuments();
      const tableId = `table-${count + 1}`;

      const customerPortalUrl =
        process.env.CUSTOMER_PORTAL_URL || "http://localhost:3001";
      const qrCodeUrl = `${customerPortalUrl}/order?table=${tableId}&type=${data.qrType}`;

      const table = await Table.create({
        tableId,
        label: data.label,
        qrCodeUrl,
        qrType: data.qrType,
        status: "available",
        createdBy: data.createdBy,
      });

      // Broadcast to all POS clients
      io.to("pos:cashiers").emit("table:created", table.toObject());
      socket.emit("table:create:success", table.toObject());

      log.success(`Table created: ${tableId}`, { label: data.label });
    } catch (error) {
      log.error("Error creating table", error);
      socket.emit("table:create:error", {
        message: "Failed to create table",
      });
    }
  });

  // ─── Admin: Update a table ──────────────────────────────────────
  socket.on("table:update", async (data: TableUpdatePayload) => {
    try {
      const updateData: Record<string, unknown> = {};
      if (data.label) updateData.label = data.label;
      if (data.status) updateData.status = data.status;

      const table = await Table.findOneAndUpdate(
        { tableId: data.tableId },
        { $set: updateData },
        { new: true },
      );

      if (!table) {
        socket.emit("table:update:error", { message: "Table not found" });
        return;
      }

      io.to("pos:cashiers").emit("table:updated", table.toObject());
      socket.emit("table:update:success", table.toObject());

      log.success(`Table updated: ${data.tableId}`);
    } catch (error) {
      log.error("Error updating table", error);
      socket.emit("table:update:error", {
        message: "Failed to update table",
      });
    }
  });

  // ─── Admin: Delete a table ──────────────────────────────────────
  socket.on("table:delete", async (data: TableDeletePayload) => {
    try {
      const table = await Table.findOneAndDelete({ tableId: data.tableId });

      if (!table) {
        socket.emit("table:delete:error", { message: "Table not found" });
        return;
      }

      io.to("pos:cashiers").emit("table:deleted", { tableId: data.tableId });
      socket.emit("table:delete:success", { tableId: data.tableId });

      log.success(`Table deleted: ${data.tableId}`);
    } catch (error) {
      log.error("Error deleting table", error);
      socket.emit("table:delete:error", {
        message: "Failed to delete table",
      });
    }
  });

  // ─── Customer: Start a session (scan QR) ────────────────────────
  socket.on("table:session:start", async (data: SessionStartPayload) => {
    try {
      const sessionId = crypto.randomUUID();

      const session = await TableSession.create({
        sessionId,
        tableId: data.tableId || null,
        qrType: data.qrType,
        customerName: data.customerName,
        customerId: data.customerId || null,
        isAnonymous: data.isAnonymous,
        status: "active",
      });

      // If dine-in, update table status
      if (data.tableId) {
        await Table.findOneAndUpdate(
          { tableId: data.tableId },
          {
            $set: {
              status: "occupied",
              currentSessionId: sessionId,
            },
          },
        );

        io.to("pos:cashiers").emit("table:updated", {
          tableId: data.tableId,
          status: "occupied",
          currentSessionId: sessionId,
        });
      }

      // Join the session room
      const sessionRoom = getSessionRoom(sessionId);
      socket.join(sessionRoom);

      socket.emit("table:session:started", session.toObject());

      // Notify POS staff
      io.to("pos:cashiers").emit("table:session:new", {
        sessionId,
        tableId: data.tableId,
        qrType: data.qrType,
        customerName: data.customerName,
        isAnonymous: data.isAnonymous,
      });

      log.success(`Session started: ${sessionId}`, {
        tableId: data.tableId,
        qrType: data.qrType,
      });
    } catch (error) {
      log.error("Error starting session", error);
      socket.emit("table:session:error", {
        message: "Failed to start session",
      });
    }
  });

  // ─── Join an existing session room ──────────────────────────────
  socket.on("table:session:join", (data: { sessionId: string }) => {
    const sessionRoom = getSessionRoom(data.sessionId);
    socket.join(sessionRoom);
    log.info(`Socket joined session room: ${sessionRoom}`);
  });

  // ─── End a session ──────────────────────────────────────────────
  socket.on("table:session:end", async (data: SessionEndPayload) => {
    try {
      const session = await TableSession.findOneAndUpdate(
        { sessionId: data.sessionId },
        {
          $set: {
            status: "closed",
            closedAt: new Date(),
          },
        },
        { new: true },
      );

      if (!session) {
        socket.emit("table:session:error", {
          message: "Session not found",
        });
        return;
      }

      // If dine-in, free up the table
      if (session.tableId) {
        await Table.findOneAndUpdate(
          { tableId: session.tableId },
          {
            $set: {
              status: "available",
              currentSessionId: null,
            },
          },
        );

        io.to("pos:cashiers").emit("table:updated", {
          tableId: session.tableId,
          status: "available",
          currentSessionId: null,
        });
      }

      // Notify session room
      const sessionRoom = getSessionRoom(data.sessionId);
      io.to(sessionRoom).emit("table:session:ended", {
        sessionId: data.sessionId,
      });

      // Notify POS
      io.to("pos:cashiers").emit("table:session:closed", {
        sessionId: data.sessionId,
        tableId: session.tableId,
      });

      log.success(`Session ended: ${data.sessionId}`);
    } catch (error) {
      log.error("Error ending session", error);
      socket.emit("table:session:error", {
        message: "Failed to end session",
      });
    }
  });

  // ─── Fetch all tables ───────────────────────────────────────────
  socket.on("table:list", async () => {
    try {
      const tables = await Table.find().sort({ createdAt: 1 }).lean();
      socket.emit("table:list:result", tables);
    } catch (error) {
      log.error("Error fetching tables", error);
      socket.emit("table:list:error", { message: "Failed to fetch tables" });
    }
  });
}
