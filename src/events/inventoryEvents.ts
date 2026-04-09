import { Server, Socket } from "socket.io";

// ─── Types (aligned with solarworks-pos-serverless/src/models/Inventory.ts) ──

type UnitCategory = "weight" | "volume" | "count" | "length";

export interface InventoryAdjustment {
  itemId: string;
  itemName: string;
  adjustmentType: "restock" | "usage" | "waste" | "correction";
  quantity: number;
  unit: string;
  displayUnit: string;
  newStock: number;
  status: "critical" | "low" | "warning" | "ok";
  performedBy: string;
  notes?: string;
  timestamp: Date;
}

export interface InventoryAlert {
  itemId: string;
  itemName: string;
  category: string;
  currentStock: number;
  minStock: number;
  reorderPoint: number;
  unit: string;
  displayUnit: string;
  unitCategory: UnitCategory;
  status: "critical" | "low" | "warning";
  location: string;
}

export interface InventoryItemCreated {
  itemId: string;
  name: string;
  category: string;
  currentStock: number;
  unit: string;
  displayUnit: string;
  unitCategory: UnitCategory;
  createdBy: string;
}

export interface InventoryItemDeleted {
  itemId: string;
  name: string;
  deletedBy: string;
}

export interface InventoryBulkImport {
  importedCount: number;
  failedCount: number;
  importedBy: string;
  timestamp: Date;
}

export interface AuditEntry {
  _id: string;
  itemId: string;
  itemName: string;
  type: "restock" | "usage" | "waste" | "correction" | "deduction" | "adjustment";
  quantity: number;
  unit: string;
  originalQuantity?: number;
  originalUnit?: string;
  previousStock: number;
  newStock: number;
  notes?: string;
  conversionNote?: string;
  reference?: {
    type: "order" | "manual" | "return" | "adjustment" | "rollback";
    id?: string;
    number?: string;
  };
  transactionId?: string;
  performedBy: string;
  createdAt: string;
}

// ─── Rooms ────────────────────────────────────────────────────────────────────

const INVENTORY_ROOM        = "inventory:global";
const INVENTORY_ALERTS_ROOM = "inventory:alerts";
const INVENTORY_AUDIT_ROOM  = "inventory:audit";

// ─── Server-side Emit Helpers (io.to — for calls FROM API routes) ─────────────
//
// These use io.to() which sends to ALL sockets in the room.
// Use these only when the event originates server-side (e.g. API routes),
// where there is no originating client socket to exclude.

export const emitInventoryAdjusted = (io: Server, data: InventoryAdjustment): void => {
  io.to(INVENTORY_ROOM).emit("inventory:adjusted", data);
  console.log(`📦 [inventory] adjusted: ${data.itemName} → ${data.newStock}${data.unit} (${data.status})`);

  if (data.status === "critical" || data.status === "low") {
    const alert: Partial<InventoryAlert> = {
      itemId: data.itemId,
      itemName: data.itemName,
      currentStock: data.newStock,
      unit: data.unit,
      displayUnit: data.displayUnit,
      status: data.status as "critical" | "low",
    };
    io.to(INVENTORY_ALERTS_ROOM).emit("inventory:alert", alert);
    console.log(`🚨 [inventory] alert piggybacked: ${data.itemName} is ${data.status}`);
  }
};

export const emitInventoryItemCreated = (io: Server, data: InventoryItemCreated): void => {
  io.to(INVENTORY_ROOM).emit("inventory:item:created", data);
  console.log(`✅ [inventory] created: ${data.name} (base: ${data.unit}, display: ${data.displayUnit})`);
};

export const emitInventoryItemDeleted = (io: Server, data: InventoryItemDeleted): void => {
  io.to(INVENTORY_ROOM).emit("inventory:item:deleted", data);
  console.log(`🗑️  [inventory] deleted: ${data.name}`);
};

export const emitInventoryBulkImport = (io: Server, data: InventoryBulkImport): void => {
  io.to(INVENTORY_ROOM).emit("inventory:bulk:imported", data);
  console.log(`📥 [inventory] bulk import: ${data.importedCount} added, ${data.failedCount} failed`);
};

export const emitInventoryAlert = (io: Server, alert: InventoryAlert): void => {
  io.to(INVENTORY_ALERTS_ROOM).emit("inventory:alert", alert);
  console.log(`🚨 [inventory] alert: ${alert.itemName} is ${alert.status} (${alert.currentStock}${alert.unit})`);
};

export const emitAuditEntry = (io: Server, entry: AuditEntry): void => {
  io.to(INVENTORY_AUDIT_ROOM).emit("inventory:audit:new", entry);
  console.log(`📋 [inventory] audit entry broadcast: ${entry.itemName} (${entry.type})`);
};

// ─── Socket Handler Registration ─────────────────────────────────────────────

export const registerInventoryHandlers = (io: Server, socket: Socket): void => {
  const userId = socket.data.userId as string;

  // ── Subscribe / unsubscribe ───────────────────────────────────────────────

  socket.on("inventory:subscribe", () => {
    socket.join(INVENTORY_ROOM);
    socket.emit("inventory:subscribed", { room: INVENTORY_ROOM });
    console.log(`📦 [inventory] ${userId} subscribed`);
  });

  socket.on("inventory:unsubscribe", () => {
    socket.leave(INVENTORY_ROOM);
    console.log(`📦 [inventory] ${userId} unsubscribed`);
  });

  socket.on("inventory:alerts:subscribe", () => {
    socket.join(INVENTORY_ALERTS_ROOM);
    socket.emit("inventory:alerts:subscribed", { room: INVENTORY_ALERTS_ROOM });
    console.log(`🚨 [inventory] ${userId} subscribed to alerts`);
  });

  socket.on("inventory:alerts:unsubscribe", () => {
    socket.leave(INVENTORY_ALERTS_ROOM);
    console.log(`🚨 [inventory] ${userId} unsubscribed from alerts`);
  });

  socket.on("inventory:audit:subscribe", () => {
    socket.join(INVENTORY_AUDIT_ROOM);
    socket.emit("inventory:audit:subscribed", { room: INVENTORY_AUDIT_ROOM });
    console.log(`📋 [inventory] ${userId} subscribed to audit trail`);
  });

  socket.on("inventory:audit:unsubscribe", () => {
    socket.leave(INVENTORY_AUDIT_ROOM);
    console.log(`📋 [inventory] ${userId} unsubscribed from audit trail`);
  });

  // ── Triggers from Next.js client ─────────────────────────────────────────
  //
  // FIX (Bug 2 — self-echo): Changed from io.to(room) to socket.broadcast.to(room).
  //
  // The client that fires these triggers has already updated its own local
  // state optimistically. If we used io.to() it would broadcast back to the
  // sender too, causing a double-update (stock flicker, extra loadInventory
  // calls, etc.). socket.broadcast.to() sends to everyone in the room
  // EXCEPT the triggering socket, so only OTHER sessions receive the event.
  //
  // The io.to() helpers above remain unchanged — they are for server-side
  // calls (e.g. from API routes) where there is no "sender" to exclude.

  socket.on("inventory:adjusted:trigger", (data: InventoryAdjustment) => {
    try {
      socket.broadcast.to(INVENTORY_ROOM).emit("inventory:adjusted", data);
      console.log(`📦 [inventory] adjusted (broadcast): ${data.itemName} → ${data.newStock}${data.unit}`);

      if (data.status === "critical" || data.status === "low") {
        const alert: Partial<InventoryAlert> = {
          itemId: data.itemId,
          itemName: data.itemName,
          currentStock: data.newStock,
          unit: data.unit,
          displayUnit: data.displayUnit,
          status: data.status as "critical" | "low",
        };
        socket.broadcast.to(INVENTORY_ALERTS_ROOM).emit("inventory:alert", alert);
        console.log(`🚨 [inventory] alert piggybacked (broadcast): ${data.itemName} is ${data.status}`);
      }
    } catch (err) {
      console.error("❌ inventory:adjusted:trigger", err);
    }
  });

  socket.on("inventory:item:created:trigger", (data: InventoryItemCreated) => {
    try {
      socket.broadcast.to(INVENTORY_ROOM).emit("inventory:item:created", data);
      console.log(`✅ [inventory] created (broadcast): ${data.name}`);
    } catch (err) {
      console.error("❌ inventory:item:created:trigger", err);
    }
  });

  socket.on("inventory:item:deleted:trigger", (data: InventoryItemDeleted) => {
    try {
      socket.broadcast.to(INVENTORY_ROOM).emit("inventory:item:deleted", data);
      console.log(`🗑️  [inventory] deleted (broadcast): ${data.name}`);
    } catch (err) {
      console.error("❌ inventory:item:deleted:trigger", err);
    }
  });

  socket.on("inventory:bulk:imported:trigger", (data: InventoryBulkImport) => {
    try {
      socket.broadcast.to(INVENTORY_ROOM).emit("inventory:bulk:imported", data);
      console.log(`📥 [inventory] bulk import (broadcast): ${data.importedCount} added`);
    } catch (err) {
      console.error("❌ inventory:bulk:imported:trigger", err);
    }
  });

  socket.on("inventory:alert:trigger", (data: InventoryAlert) => {
    try {
      socket.broadcast.to(INVENTORY_ALERTS_ROOM).emit("inventory:alert", data);
      console.log(`🚨 [inventory] alert (broadcast): ${data.itemName} is ${data.status}`);
    } catch (err) {
      console.error("❌ inventory:alert:trigger", err);
    }
  });

  socket.on("inventory:audit:trigger", (data: AuditEntry) => {
    try {
      socket.broadcast.to(INVENTORY_AUDIT_ROOM).emit("inventory:audit:new", data);
      console.log(`📋 [inventory] audit entry (broadcast): ${data.itemName} (${data.type})`);
    } catch (err) {
      console.error("❌ inventory:audit:trigger", err);
    }
  });
};