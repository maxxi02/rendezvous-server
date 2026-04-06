// src/types/order.type.ts

import { QrType } from "./table.type";

export type QueueStatus =
  | "pending_payment"
  | "paid"
  | "queueing"
  | "preparing"
  | "serving"
  | "ready"
  | "served"
  | "completed"
  | "done"
  | "cancelled";

export type PaymentStatus = "pending" | "paid" | "failed" | "refunded";

export interface CustomerOrderItem {
  _id: string;
  name: string;
  price: number;
  quantity: number;
  description?: string;
  category?: string;
  menuType?: "food" | "drink";
  imageUrl?: string;
  ingredients: Array<{ name: string; quantity: string; unit: string }>;
}

export interface CustomerOrder {
  orderId: string;
  orderNumber?: string; // auto-increment per day e.g. "#001"
  sessionId?: string; // links to table session
  tableId?: string; // null for walk-in/drive-thru
  qrType?: QrType;
  customerName: string;
  customerId?: string; // if logged in via Google
  items: CustomerOrderItem[];
  orderNote?: string;
  orderType: "dine-in" | "takeaway";
  tableNumber?: string;
  subtotal: number;
  total: number;
  timestamp: Date;

  // Payment
  paymentMethod?: "gcash" | "cash" | "split";
  paymentStatus?: PaymentStatus;
  paymentReference?: string;
  splitPayment?: { cash: number; gcash: number };

  // Queue
  queueStatus?: QueueStatus;

  // Timestamps
  paidAt?: Date;
  preparingAt?: Date;
  servingAt?: Date;
  readyAt?: Date;
  servedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
}

// Socket payloads for queue updates
export interface OrderQueueUpdatePayload {
  orderId: string;
  queueStatus: QueueStatus;
  updatedBy: string;
}

export interface OrderPaymentConfirmedPayload {
  orderId: string;
  paymentReference: string;
  paymentMethod: "gcash";
}
