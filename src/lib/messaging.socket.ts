/**
 * messaging.socket.ts
 *
 * Add this to your existing socket server.
 * Call `registerMessagingHandlers(io, socket)` inside your handleConnection function.
 *
 * Prerequisites:
 *   npm install mongodb   (already installed since you use it)
 *
 * In your existing handleConnection(), add:
 *   registerMessagingHandlers(io, socket);
 */

import { Server, Socket } from "socket.io";
import { Db, ObjectId } from "mongodb";
import {
  insertMessage,
  markMessagesAsRead,
  findOrCreateDMConversation,
  getConversationsCollection,
  ensureMessagingIndexes,
} from "./messaging.db";
import type {
  DmSendPayload,
  DmReceivePayload,
  DmTypingPayload,
  DmReadPayload,
  DmConversationJoinPayload,
} from "../types/messaging.types";

// ─── DB Connection (reuse your existing MongoDB connection) ───────

let db: Db | null = null;

export function setMessagingDb(database: Db): void {
  db = database;
  ensureMessagingIndexes(database).catch(console.error);
  console.log("✅ Messaging DB set");
}

const getDb = (): Db => {
  if (!db)
    throw new Error("Messaging DB not initialized. Call setMessagingDb()");
  return db;
};

// ─── Room Naming ──────────────────────────────────────────────────

const getConversationRoom = (conversationId: string) =>
  `conversation:${conversationId}`;

// ─── Typing Debounce Map ──────────────────────────────────────────

const typingTimers = new Map<string, NodeJS.Timeout>();

// ─── Messaging Handlers ───────────────────────────────────────────

export function registerMessagingHandlers(io: Server, socket: Socket): void {
  const userId = socket.data.userId as string;
  const userName = socket.data.userName as string;
  const userAvatar = socket.data.userAvatar as string | undefined;

  // ── Join a conversation room ────────────────────────────────────
  socket.on("dm:conversation:join", async (data: DmConversationJoinPayload) => {
    try {
      const { conversationId } = data;

      // Verify user is a participant before letting them join
      const database = getDb();
      const conversations = getConversationsCollection(database);
      const conversation = await conversations.findOne({
        _id: new ObjectId(conversationId),
        participants: userId,
      });

      if (!conversation) {
        socket.emit("dm:error", {
          message: "Conversation not found or access denied",
        });
        return;
      }

      const room = getConversationRoom(conversationId);
      socket.join(room);

      // Mark messages as read when joining
      const readMessageIds = await markMessagesAsRead(
        database,
        conversationId,
        userId,
      );

      if (readMessageIds.length > 0) {
        const readPayload: DmReadPayload = {
          conversationId,
          messageIds: readMessageIds,
          userId,
          readAt: new Date(),
        };
        io.to(room).emit("dm:read", readPayload);
      }

      console.log(`✅ User ${userId} joined conversation room: ${room}`);
    } catch (error) {
      console.error("❌ Error in dm:conversation:join", error);
      socket.emit("dm:error", { message: "Failed to join conversation" });
    }
  });

  // ── Leave a conversation room ───────────────────────────────────
  socket.on("dm:conversation:leave", (data: DmConversationJoinPayload) => {
    const room = getConversationRoom(data.conversationId);
    socket.leave(room);
    console.log(`ℹ️  User ${userId} left conversation room: ${room}`);
  });

  // ── Start a new DM (or get existing) ───────────────────────────
  socket.on("dm:start", async (data: { targetUserId: string }) => {
    try {
      const database = getDb();
      const conversationId = await findOrCreateDMConversation(
        database,
        userId,
        data.targetUserId,
      );

      socket.emit("dm:started", { conversationId });
    } catch (error) {
      console.error("❌ Error in dm:start", error);
      socket.emit("dm:error", { message: "Failed to start conversation" });
    }
  });

  // ── Send a message ──────────────────────────────────────────────
  socket.on("dm:send", async (data: DmSendPayload) => {
    console.log("📨 dm:send received", data);
    try {
      const { conversationId, content, tempId } = data;

      if (!content?.trim()) return;

      const database = getDb();

      // Verify participant
      const conversations = getConversationsCollection(database);
      const conversation = await conversations.findOne({
        _id: new ObjectId(conversationId),
        participants: userId,
      });

      if (!conversation) {
        socket.emit("dm:error", {
          message: "Not a participant of this conversation",
        });
        return;
      }

      // Save to DB
      const message = await insertMessage(database, {
        conversationId,
        senderId: userId,
        senderName: userName,
        senderImage: userAvatar,
        content: content.trim(),
      });

      const payload: DmReceivePayload = {
        conversationId,
        message: {
          ...message,
          _id: message._id.toString(),
        } as any,
      };

      // Broadcast to entire conversation room (including sender)
      const room = getConversationRoom(conversationId);
      io.to(room).emit("dm:receive", payload);

      // Confirm to sender with tempId for optimistic UI reconciliation
      socket.emit("dm:sent", { tempId, messageId: message._id.toString() });

      // Notify other participant's personal room if they're NOT in the conversation room
      // (i.e., they have the app open but not on this chat)
      const otherParticipants = conversation.participants.filter(
        (p: string) => p !== userId,
      );
      for (const participantId of otherParticipants) {
        io.to(`user:${participantId}`).emit("dm:notification", {
          conversationId,
          senderName: userName,
          senderImage: userAvatar,
          preview: content.trim().slice(0, 80),
        });
      }
    } catch (error) {
      console.error("❌ Error in dm:send", error);
      socket.emit("dm:error", { message: "Failed to send message" });
    }
  });

  // ── Typing indicators ───────────────────────────────────────────
  socket.on("dm:typing:start", (data: { conversationId: string }) => {
    const room = getConversationRoom(data.conversationId);
    const timerKey = `${data.conversationId}:${userId}`;

    const payload: DmTypingPayload = {
      conversationId: data.conversationId,
      userId,
      userName,
    };

    socket.to(room).emit("dm:typing:start", payload);

    // Auto-stop typing after 3s of inactivity
    if (typingTimers.has(timerKey)) clearTimeout(typingTimers.get(timerKey)!);
    typingTimers.set(
      timerKey,
      setTimeout(() => {
        socket.to(room).emit("dm:typing:stop", payload);
        typingTimers.delete(timerKey);
      }, 3000),
    );
  });

  socket.on("dm:typing:stop", (data: { conversationId: string }) => {
    const room = getConversationRoom(data.conversationId);
    const timerKey = `${data.conversationId}:${userId}`;

    if (typingTimers.has(timerKey)) {
      clearTimeout(typingTimers.get(timerKey)!);
      typingTimers.delete(timerKey);
    }

    const payload: DmTypingPayload = {
      conversationId: data.conversationId,
      userId,
      userName,
    };
    socket.to(room).emit("dm:typing:stop", payload);
  });

  // ── Read receipts (manual trigger) ─────────────────────────────
  socket.on("dm:read", async (data: { conversationId: string }) => {
    try {
      const database = getDb();
      const readMessageIds = await markMessagesAsRead(
        database,
        data.conversationId,
        userId,
      );

      if (readMessageIds.length > 0) {
        const room = getConversationRoom(data.conversationId);
        const payload: DmReadPayload = {
          conversationId: data.conversationId,
          messageIds: readMessageIds,
          userId,
          readAt: new Date(),
        };
        io.to(room).emit("dm:read", payload);
      }
    } catch (error) {
      console.error("❌ Error in dm:read", error);
    }
  });
}
