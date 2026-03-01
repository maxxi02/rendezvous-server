// src/types/chat.type.ts

export type ChatSenderRole = "customer" | "staff";

export interface ChatMessage {
  _id?: string;
  sessionId: string; // table session or walk-in session
  senderId: string; // "anonymous-<uuid>" | google userId | staff userId
  senderName: string;
  senderRole: ChatSenderRole;
  message: string;
  timestamp: Date;
}

// Socket payloads
export interface ChatSendPayload {
  sessionId: string;
  message: string;
  senderName: string;
  senderRole: ChatSenderRole;
}

export interface ChatReceivePayload {
  sessionId: string;
  message: ChatMessage;
}

export interface ChatHistoryPayload {
  sessionId: string;
  messages: ChatMessage[];
}

export interface ChatJoinPayload {
  sessionId: string;
}
