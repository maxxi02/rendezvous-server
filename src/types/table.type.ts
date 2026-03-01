// src/types/table.type.ts

export type QrType = "dine-in" | "walk-in" | "drive-thru";
export type TableStatus = "available" | "occupied" | "reserved";

export interface Table {
  _id?: string;
  tableId: string; // "table-1", "table-2"
  label: string; // "Table #1"
  qrCodeUrl: string; // URL the QR encodes
  qrType: QrType;
  status: TableStatus;
  currentSessionId?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TableSession {
  _id?: string;
  sessionId: string;
  tableId?: string; // null for walk-in/drive-thru
  qrType: QrType;
  customerName: string;
  customerId?: string; // Google auth userId
  isAnonymous: boolean;
  status: "active" | "closed";
  createdAt: Date;
  closedAt?: Date;
}

// Socket payloads
export interface TableCreatePayload {
  label: string;
  qrType: QrType;
  createdBy: string;
}

export interface TableUpdatePayload {
  tableId: string;
  label?: string;
  status?: TableStatus;
}

export interface TableDeletePayload {
  tableId: string;
}

export interface SessionStartPayload {
  tableId?: string;
  qrType: QrType;
  customerName: string;
  customerId?: string;
  isAnonymous: boolean;
}

export interface SessionEndPayload {
  sessionId: string;
}
