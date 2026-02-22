// src/lib/order.socket.ts

import { Server } from "socket.io";
import { CustomerOrder } from "../types/order.type";

const log = {
  success: (msg: string, data?: unknown) =>
    console.log(`✅ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  error: (msg: string, data?: unknown) =>
    console.error(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
};

export const emitCustomerOrder = (io: Server, order: CustomerOrder): void => {
  io.to("pos:cashiers").emit("order:new", order);
  log.success(`Customer order emitted to POS cashiers`, {
    orderId: order.orderId,
  });
};
