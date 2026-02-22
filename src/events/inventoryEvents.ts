import { Server, Socket } from "socket.io";

// ─── Types (aligned with solarworks-pos-serverless/src/models/Inventory.ts) ──
// unit      = base unit stored in DB  (g, mL, pieces, cm)
// displayUnit = human-facing unit     (kg, L, boxes, tsp, etc.)
// unitCategory = 'weight' | 'volume' | 'count' | 'length'

type UnitCategory = "weight" | "volume" | "count" | "length";

export interface InventoryAdjustment {
  itemId: string;
  itemName: string;
  adjustmentType: "restock" | "usage" | "waste" | "correction";
  quantity: number;       // value in base unit (already converted)
  unit: string;           // base unit  e.g. "g"
  displayUnit: string;    // display unit e.g. "kg"
  newStock: number;       // updated currentStock in base unit
  status: "critical" | "low" | "warning" | "ok";
  performedBy: string;
  notes?: string;
  timestamp: Date;
}

export interface InventoryAlert {
  itemId: string;
  itemName: string;
  category: string;
  currentStock: number;   // base unit
  minStock: number;       // base unit
  reorderPoint: number;   // base unit
  unit: string;           // base unit
  displayUnit: string;    // display unit
  unitCategory: UnitCategory;
  status: "critical" | "low" | "warning";
  location: string;
}

export interface InventoryItemCreated {
  itemId: string;
  name: string;
  category: string;
  currentStock: number;   // base unit
  unit: string;           // base unit
  displayUnit: string;    // display unit
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

// ─── Rooms ────────────────────────────────────────────────────────────────────

const INVENTORY_ROOM = "inventory:global";
const INVENTORY_ALERTS_ROOM = "inventory:alerts";

// ─── Emit Helpers (usable directly from Express routes too) ──────────────────

export const emitInventoryAdjusted = (
  io: Server,
  data: InventoryAdjustment
): void => {
  io.to(INVENTORY_ROOM).emit("inventory:adjusted", data);
  console.log(
    `📦 [inventory] adjusted: ${data.itemName} → ${data.newStock}${data.unit} (${data.status})`
  );

  // Piggyback an alert if stock dropped to critical or low
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

export const emitInventoryItemCreated = (
  io: Server,
  data: InventoryItemCreated
): void => {
  io.to(INVENTORY_ROOM).emit("inventory:item:created", data);
  console.log(`✅ [inventory] created: ${data.name} (base: ${data.unit}, display: ${data.displayUnit})`);
};

export const emitInventoryItemDeleted = (
  io: Server,
  data: InventoryItemDeleted
): void => {
  io.to(INVENTORY_ROOM).emit("inventory:item:deleted", data);
  console.log(`🗑️  [inventory] deleted: ${data.name}`);
};

export const emitInventoryBulkImport = (
  io: Server,
  data: InventoryBulkImport
): void => {
  io.to(INVENTORY_ROOM).emit("inventory:bulk:imported", data);
  console.log(`📥 [inventory] bulk import: ${data.importedCount} added, ${data.failedCount} failed`);
};

export const emitInventoryAlert = (
  io: Server,
  alert: InventoryAlert
): void => {
  io.to(INVENTORY_ALERTS_ROOM).emit("inventory:alert", alert);
  console.log(`🚨 [inventory] alert: ${alert.itemName} is ${alert.status} (${alert.currentStock}${alert.unit})`);
};

// ─── Socket Handler Registration ─────────────────────────────────────────────

export const registerInventoryHandlers = (io: Server, socket: Socket): void => {
  const userId = socket.data.userId as string;

  // ── Subscribe / unsubscribe ───────────────────────────────────

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

  // ── Trigger events (Next.js → server → all other clients) ────

  socket.on("inventory:adjusted:trigger", (data: InventoryAdjustment) => {
    try {
      emitInventoryAdjusted(io, data);
    } catch (err) {
      console.error("❌ inventory:adjusted:trigger", err);
    }
  });

  socket.on("inventory:item:created:trigger", (data: InventoryItemCreated) => {
    try {
      emitInventoryItemCreated(io, data);
    } catch (err) {
      console.error("❌ inventory:item:created:trigger", err);
    }
  });

  socket.on("inventory:item:deleted:trigger", (data: InventoryItemDeleted) => {
    try {
      emitInventoryItemDeleted(io, data);
    } catch (err) {
      console.error("❌ inventory:item:deleted:trigger", err);
    }
  });

  socket.on("inventory:bulk:imported:trigger", (data: InventoryBulkImport) => {
    try {
      emitInventoryBulkImport(io, data);
    } catch (err) {
      console.error("❌ inventory:bulk:imported:trigger", err);
    }
  });

  socket.on("inventory:alert:trigger", (data: InventoryAlert) => {
    try {
      emitInventoryAlert(io, data);
    } catch (err) {
      console.error("❌ inventory:alert:trigger", err);
    }
  });
};