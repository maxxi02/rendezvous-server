// src/models/Table.ts

import mongoose from "mongoose";

const tableSchema = new mongoose.Schema(
  {
    tableId: { type: String, required: true, unique: true },
    label: { type: String, required: true },
    qrCodeUrl: { type: String, required: true },
    qrType: {
      type: String,
      enum: ["dine-in", "walk-in", "drive-thru"],
      default: "dine-in",
    },
    status: {
      type: String,
      enum: ["available", "occupied", "reserved"],
      default: "available",
    },
    currentSessionId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  {
    collection: "tables",
    timestamps: true,
  },
);

export const Table =
  mongoose.models.Table || mongoose.model("Table", tableSchema);
