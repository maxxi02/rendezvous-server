// src/models/Order.ts

import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true },
    description: String,
    category: String,
    menuType: { type: String, enum: ["food", "drink"] },
    imageUrl: String,
    ingredients: [
      {
        name: String,
        quantity: String,
        unit: String,
      },
    ],
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true },
    orderNumber: { type: String }, // auto-increment per day e.g. "#001"
    sessionId: { type: String, default: null },
    tableId: { type: String, default: null },
    qrType: {
      type: String,
      enum: ["dine-in", "walk-in", "drive-thru"],
    },
    customerName: { type: String, required: true },
    customerId: { type: String, default: null },
    items: [orderItemSchema],
    orderNote: String,
    orderType: {
      type: String,
      enum: ["dine-in", "takeaway"],
      default: "dine-in",
    },
    tableNumber: String,
    subtotal: { type: Number, required: true },
    total: { type: Number, required: true },

    // Payment
    paymentMethod: {
      type: String,
      enum: ["gcash"],
      default: "gcash",
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    paymentReference: String,

    // Queue
    queueStatus: {
      type: String,
      enum: [
        "pending_payment",
        "paid",
        "preparing",
        "ready",
        "served",
        "completed",
        "cancelled",
      ],
      default: "pending_payment",
    },

    // Timestamps
    paidAt: Date,
    preparingAt: Date,
    readyAt: Date,
    servedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
  },
  {
    collection: "orders",
    timestamps: true,
  },
);

// Indexes for queue queries
orderSchema.index({ queueStatus: 1, createdAt: -1 });
orderSchema.index({ sessionId: 1 });
orderSchema.index({ orderId: 1 });
orderSchema.index({ tableId: 1 });

export const Order =
  mongoose.models.Order || mongoose.model("Order", orderSchema);
