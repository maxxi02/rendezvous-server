// src/models/TableSession.ts

import mongoose from "mongoose";

const tableSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    tableId: { type: String, default: null }, // null for walk-in/drive-thru
    qrType: {
      type: String,
      enum: ["dine-in", "walk-in", "drive-thru"],
      required: true,
    },
    customerName: { type: String, required: true },
    customerId: { type: String, default: null }, // Google auth userId
    isAnonymous: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["active", "closed"],
      default: "active",
    },
    closedAt: { type: Date, default: null },
  },
  {
    collection: "table_sessions",
    timestamps: true,
  },
);

// Index for quick lookups
tableSessionSchema.index({ tableId: 1, status: 1 });
tableSessionSchema.index({ sessionId: 1 });

export const TableSession =
  mongoose.models.TableSession ||
  mongoose.model("TableSession", tableSessionSchema);
