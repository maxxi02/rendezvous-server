// src/types/order.type.ts

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
  customerName: string;
  items: CustomerOrderItem[];
  orderNote?: string;
  orderType: "dine-in" | "takeaway";
  tableNumber?: string;
  subtotal: number;
  total: number;
  timestamp: Date;
}
