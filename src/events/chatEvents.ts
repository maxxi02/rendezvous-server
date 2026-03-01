// src/events/chatEvents.ts

import { Server, Socket } from "socket.io";
import { ChatMessage } from "../models/ChatMessage";
import type {
  ChatSendPayload,
  ChatReceivePayload,
  ChatJoinPayload,
} from "../types/chat.type";

const log = {
  info: (msg: string, data?: unknown) =>
    console.log(`ℹ️  [Chat] ${msg}`, data ? JSON.stringify(data) : ""),
  success: (msg: string, data?: unknown) =>
    console.log(`✅ [Chat] ${msg}`, data ? JSON.stringify(data) : ""),
  error: (msg: string, data?: unknown) =>
    console.error(`❌ [Chat] ${msg}`, data ? JSON.stringify(data) : ""),
};

const getChatRoom = (sessionId: string) => `chat:${sessionId}`;

export function registerChatHandlers(io: Server, socket: Socket): void {
  const userId = socket.data.userId as string;
  const userName = socket.data.userName as string;

  // ─── Join a chat room ───────────────────────────────────────────
  socket.on("chat:join", (data: ChatJoinPayload) => {
    const room = getChatRoom(data.sessionId);
    socket.join(room);
    log.info(`User ${userId || "anonymous"} joined chat room: ${room}`);
  });

  // ─── Leave a chat room ──────────────────────────────────────────
  socket.on("chat:leave", (data: ChatJoinPayload) => {
    const room = getChatRoom(data.sessionId);
    socket.leave(room);
    log.info(`User ${userId || "anonymous"} left chat room: ${room}`);
  });

  // ─── Send a message ─────────────────────────────────────────────
  socket.on("chat:send", async (data: ChatSendPayload) => {
    try {
      if (!data.message?.trim()) return;

      const chatMessage = await ChatMessage.create({
        sessionId: data.sessionId,
        senderId: userId || `anonymous-${socket.id}`,
        senderName: data.senderName || userName || "Anonymous",
        senderRole: data.senderRole,
        message: data.message.trim(),
      });

      const payload: ChatReceivePayload = {
        sessionId: data.sessionId,
        message: chatMessage.toObject(),
      };

      // Broadcast to the chat room
      const room = getChatRoom(data.sessionId);
      io.to(room).emit("chat:receive", payload);

      // Also notify POS staff if message is from customer
      if (data.senderRole === "customer") {
        io.to("pos:cashiers").emit("chat:customer:message", {
          sessionId: data.sessionId,
          senderName: data.senderName,
          preview: data.message.trim().slice(0, 80),
        });
      }

      log.success(`Chat message sent in session ${data.sessionId}`);
    } catch (error) {
      log.error("Error sending chat message", error);
      socket.emit("chat:error", { message: "Failed to send message" });
    }
  });

  // ─── Fetch chat history ─────────────────────────────────────────
  socket.on(
    "chat:history",
    async (data: { sessionId: string; limit?: number }) => {
      try {
        const limit = data.limit || 50;

        const messages = await ChatMessage.find({
          sessionId: data.sessionId,
        })
          .sort({ createdAt: 1 })
          .limit(limit)
          .lean();

        socket.emit("chat:history:result", {
          sessionId: data.sessionId,
          messages,
        });

        log.info(
          `Chat history fetched for session ${data.sessionId}: ${messages.length} messages`,
        );
      } catch (error) {
        log.error("Error fetching chat history", error);
        socket.emit("chat:error", {
          message: "Failed to fetch chat history",
        });
      }
    },
  );

  // ─── Typing indicators ─────────────────────────────────────────
  socket.on("chat:typing:start", (data: { sessionId: string }) => {
    const room = getChatRoom(data.sessionId);
    socket.to(room).emit("chat:typing:start", {
      sessionId: data.sessionId,
      userId: userId || `anonymous-${socket.id}`,
      userName: userName || "Anonymous",
    });
  });

  socket.on("chat:typing:stop", (data: { sessionId: string }) => {
    const room = getChatRoom(data.sessionId);
    socket.to(room).emit("chat:typing:stop", {
      sessionId: data.sessionId,
      userId: userId || `anonymous-${socket.id}`,
    });
  });

  // ─── Table-based chat (for QR scanned table sessions) ──────────

  const getTableChatRoom = (tableId: string) => `chat:table:${tableId}`;

  socket.on("chat:table:join", (data: { tableId: string }) => {
    const room = getTableChatRoom(data.tableId);
    socket.join(room);
    log.info(`Socket ${socket.id} joined table chat room: ${room}`);
  });

  socket.on("chat:table:leave", (data: { tableId: string }) => {
    const room = getTableChatRoom(data.tableId);
    socket.leave(room);
    log.info(`Socket ${socket.id} left table chat room: ${room}`);
  });

  socket.on(
    "chat:table:send",
    async (data: {
      tableId: string;
      message: string;
      senderName: string;
      senderRole: "customer" | "staff";
    }) => {
      try {
        if (!data.message?.trim()) return;

        const chatMessage = await ChatMessage.create({
          sessionId: `table:${data.tableId}`,
          senderId: userId || `anonymous-${socket.id}`,
          senderName: data.senderName || userName || "Anonymous",
          senderRole: data.senderRole,
          message: data.message.trim(),
        });

        const room = getTableChatRoom(data.tableId);
        io.to(room).emit("chat:table:receive", {
          tableId: data.tableId,
          message: chatMessage.toObject(),
        });

        // Also notify POS staff if message is from customer
        if (data.senderRole === "customer") {
          io.to("pos:cashiers").emit("chat:customer:message", {
            tableId: data.tableId,
            senderName: data.senderName,
            preview: data.message.trim().slice(0, 80),
          });
        }

        log.success(`Table chat message sent in table ${data.tableId}`);
      } catch (error) {
        log.error("Error sending table chat message", error);
        socket.emit("chat:error", { message: "Failed to send message" });
      }
    },
  );

  socket.on(
    "chat:table:history",
    async (data: { tableId: string; limit?: number }) => {
      try {
        const limit = data.limit || 50;
        const messages = await ChatMessage.find({
          sessionId: `table:${data.tableId}`,
        })
          .sort({ createdAt: 1 })
          .limit(limit)
          .lean();

        socket.emit("chat:table:history:result", {
          tableId: data.tableId,
          messages,
        });

        log.info(
          `Table chat history fetched for table ${data.tableId}: ${messages.length} messages`,
        );
      } catch (error) {
        log.error("Error fetching table chat history", error);
        socket.emit("chat:error", { message: "Failed to fetch chat history" });
      }
    },
  );
}
