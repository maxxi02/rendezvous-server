import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import { ConversationModel, IConversation } from "../models/conversation.model";
import { MessageModel, IMessage } from "../models/message.model";

// ─── Constants ───────────────────────────────────────────────────

const ALL_STAFF_SLUG = "group:all-staff";
const MESSAGES_LIMIT = 50;

// ─── Payload types (Client → Server) ─────────────────────────────

interface SendMessagePayload {
  conversationId: string;
  content: string;
}

interface LoadMessagesPayload {
  conversationId: string;
  cursor?: string; // _id of oldest currently-loaded message for pagination
}

interface DirectGetOrCreatePayload {
  targetUserId: string;
  targetUserName: string;
  targetUserAvatar?: string;
}

interface TypingUpdatePayload {
  conversationId: string;
  isTyping: boolean;
}

interface ReadMessagesPayload {
  conversationId: string;
}

// ─── Wire types (serialized for the client) ───────────────────────

interface WireMessage {
  _id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  content: string;
  readBy: string[];
  createdAt: string;
  updatedAt: string;
}

interface WireConversation {
  _id: string;
  type: "group" | "direct";
  name: string;
  slug: string;
  participants: string[];
  lastMessage?: {
    content: string;
    senderId: string;
    senderName: string;
    timestamp: string;
  };
  createdAt: string;
  updatedAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

const getChatRoom = (conversationId: string) => `chat:conv:${conversationId}`;
const getUserRoom = (userId: string) => `user:${userId}`;

const toWireMessage = (msg: IMessage): WireMessage => ({
  _id: (msg._id as mongoose.Types.ObjectId).toString(),
  conversationId: msg.conversationId,
  senderId: msg.senderId,
  senderName: msg.senderName,
  senderAvatar: msg.senderAvatar,
  content: msg.content,
  readBy: msg.readBy,
  createdAt: msg.createdAt.toISOString(),
  updatedAt: msg.updatedAt.toISOString(),
});

const toWireConversation = (conv: IConversation): WireConversation => ({
  _id: (conv._id as mongoose.Types.ObjectId).toString(),
  type: conv.type,
  name: conv.name,
  slug: conv.slug,
  participants: conv.participants,
  lastMessage: conv.lastMessage
    ? {
        content: conv.lastMessage.content,
        senderId: conv.lastMessage.senderId,
        senderName: conv.lastMessage.senderName,
        timestamp: conv.lastMessage.timestamp.toISOString(),
      }
    : undefined,
  createdAt: conv.createdAt.toISOString(),
  updatedAt: conv.updatedAt.toISOString(),
});

const isValidId = (id: string) => mongoose.Types.ObjectId.isValid(id);

const log = {
  info: (msg: string) => console.log(`ℹ️  [Chat] ${msg}`),
  success: (msg: string) => console.log(`✅ [Chat] ${msg}`),
  error: (msg: string, err?: unknown) =>
    console.error(`❌ [Chat] ${msg}`, err ?? ""),
};

// ─── Seed: All Staff group (run once on server start) ─────────────

export const seedAllStaffGroup = async (): Promise<void> => {
  try {
    const exists = await ConversationModel.findOne({ slug: ALL_STAFF_SLUG });
    if (!exists) {
      await ConversationModel.create({
        type: "group",
        name: "All Staff",
        slug: ALL_STAFF_SLUG,
        participants: [],
      });
      log.success('Seeded "All Staff" group conversation');
    }
  } catch (err) {
    log.error("Failed to seed All Staff group", err);
  }
};

// ─── On connect: auto-join all rooms ─────────────────────────────

const joinUserRooms = async (
  io: Server,
  socket: Socket,
  userId: string,
): Promise<void> => {
  // 1. Add user to All Staff participants and join its socket room
  const allStaff = await ConversationModel.findOneAndUpdate(
    { slug: ALL_STAFF_SLUG },
    { $addToSet: { participants: userId } },
    { new: true },
  );

  if (allStaff) {
    const room = getChatRoom(
      (allStaff._id as mongoose.Types.ObjectId).toString(),
    );
    await socket.join(room);
    log.info(`${userId} joined All Staff room`);
  }

  // 2. Re-join all existing DM rooms
  const dmConvs = await ConversationModel.find({
    type: "direct",
    participants: userId,
  }).select("_id");

  for (const conv of dmConvs) {
    const room = getChatRoom((conv._id as mongoose.Types.ObjectId).toString());
    await socket.join(room);
  }

  log.info(`${userId} re-joined ${dmConvs.length} DM room(s)`);
};

// ─── Handler: load conversations ─────────────────────────────────

const handleConversationsLoad = async (
  socket: Socket,
  userId: string,
): Promise<void> => {
  const convs = await ConversationModel.find({ participants: userId }).sort({
    updatedAt: -1,
  });

  socket.emit("chat:conversations:loaded", {
    conversations: convs.map(toWireConversation),
  });
};

// ─── Handler: load messages (cursor pagination) ───────────────────

const handleMessagesLoad = async (
  socket: Socket,
  userId: string,
  payload: LoadMessagesPayload,
): Promise<void> => {
  const { conversationId, cursor } = payload;

  if (!isValidId(conversationId)) {
    socket.emit("chat:error", { message: "Invalid conversation ID" });
    return;
  }

  const conv = await ConversationModel.findOne({
    _id: conversationId,
    participants: userId,
  });

  if (!conv) {
    socket.emit("chat:error", { message: "Conversation not found" });
    return;
  }

  const query: {
    conversationId: string;
    _id?: { $lt: mongoose.Types.ObjectId };
  } = { conversationId };

  if (cursor && isValidId(cursor)) {
    query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
  }

  // Fetch one extra to detect if there are more pages
  const raw = await MessageModel.find(query)
    .sort({ _id: -1 })
    .limit(MESSAGES_LIMIT + 1);

  const hasMore = raw.length > MESSAGES_LIMIT;
  const messages = raw.slice(0, MESSAGES_LIMIT).reverse(); // oldest → newest

  socket.emit("chat:messages:loaded", {
    conversationId,
    messages: messages.map(toWireMessage),
    hasMore,
  });
};

// ─── Handler: send message ────────────────────────────────────────

const handleMessageSend = async (
  io: Server,
  socket: Socket,
  userId: string,
  userName: string,
  userAvatar: string,
  payload: SendMessagePayload,
): Promise<void> => {
  const { conversationId, content } = payload;

  if (!isValidId(conversationId)) {
    socket.emit("chat:error", { message: "Invalid conversation ID" });
    return;
  }

  const trimmed = content?.trim();
  if (!trimmed || trimmed.length > 5000) {
    socket.emit("chat:error", { message: "Invalid message content" });
    return;
  }

  const conv = await ConversationModel.findOne({
    _id: conversationId,
    participants: userId,
  });

  if (!conv) {
    socket.emit("chat:error", { message: "Access denied" });
    return;
  }

  const message = await MessageModel.create({
    conversationId,
    senderId: userId,
    senderName: userName,
    senderAvatar: userAvatar,
    content: trimmed,
    readBy: [userId],
  });

  // Update conversation's lastMessage and bump updatedAt for sort order
  await ConversationModel.findByIdAndUpdate(conversationId, {
    lastMessage: {
      content: trimmed,
      senderId: userId,
      senderName: userName,
      timestamp: message.createdAt,
    },
    updatedAt: new Date(),
  });

  const room = getChatRoom(conversationId);
  io.to(room).emit("chat:message:new", {
    message: toWireMessage(message),
    conversationId,
  });
};

// ─── Handler: get or create direct conversation ───────────────────

const handleDirectGetOrCreate = async (
  io: Server,
  socket: Socket,
  userId: string,
  userName: string,
  payload: DirectGetOrCreatePayload,
): Promise<void> => {
  const { targetUserId, targetUserName, targetUserAvatar = "" } = payload;

  if (userId === targetUserId) {
    socket.emit("chat:error", { message: "Cannot DM yourself" });
    return;
  }

  // Sort IDs so the slug is identical regardless of who initiates
  const [idA, idB] = [userId, targetUserId].sort();
  const slug = `direct:${idA}:${idB}`;

  let conv = await ConversationModel.findOne({ slug });

  if (!conv) {
    conv = await ConversationModel.create({
      type: "direct",
      name: `${userName} & ${targetUserName}`,
      slug,
      participants: [userId, targetUserId],
    });
    log.success(`Created DM: ${slug}`);
  }

  const convId = (conv._id as mongoose.Types.ObjectId).toString();
  const room = getChatRoom(convId);

  // Ensure requesting socket is in the room
  await socket.join(room);

  // Pull every socket belonging to the other user into the room too
  await io.in(getUserRoom(targetUserId)).socketsJoin(room);

  // Confirm to requester
  socket.emit("chat:direct:ready", { conversation: toWireConversation(conv) });

  // Notify the other user (may be offline — they'll re-join on next connect)
  io.to(getUserRoom(targetUserId)).emit("chat:conversation:new", {
    conversation: toWireConversation(conv),
  });
};

// ─── Handler: typing indicator ────────────────────────────────────

const handleTypingUpdate = (
  socket: Socket,
  userId: string,
  userName: string,
  payload: TypingUpdatePayload,
): void => {
  if (!isValidId(payload.conversationId)) return;

  const room = getChatRoom(payload.conversationId);

  // Broadcast to everyone in the room EXCEPT the sender
  socket.to(room).emit("chat:typing", {
    conversationId: payload.conversationId,
    userId,
    userName,
    isTyping: payload.isTyping,
  });
};

// ─── Handler: mark messages read ─────────────────────────────────

const handleMessagesRead = async (
  socket: Socket,
  userId: string,
  payload: ReadMessagesPayload,
): Promise<void> => {
  if (!isValidId(payload.conversationId)) return;

  await MessageModel.updateMany(
    {
      conversationId: payload.conversationId,
      senderId: { $ne: userId },
      readBy: { $nin: [userId] },
    },
    { $addToSet: { readBy: userId } },
  );
};

// ─── Main: register all chat events for a socket ─────────────────

export const handleChatEvents = (io: Server, socket: Socket): void => {
  const auth = socket.handshake.auth as {
    userId?: string;
    userName?: string;
    userAvatar?: string;
  };

  const userId = auth.userId;
  const userName = auth.userName ?? "Unknown";
  const userAvatar = auth.userAvatar ?? "";

  if (!userId) return;

  // Auto-join rooms immediately on connect (fire-and-forget with error boundary)
  joinUserRooms(io, socket, userId).catch((err) =>
    log.error("joinUserRooms failed", err),
  );

  socket.on("chat:conversations:load", () => {
    handleConversationsLoad(socket, userId).catch((err) =>
      log.error("handleConversationsLoad", err),
    );
  });

  socket.on("chat:messages:load", (payload: LoadMessagesPayload) => {
    handleMessagesLoad(socket, userId, payload).catch((err) =>
      log.error("handleMessagesLoad", err),
    );
  });

  socket.on("chat:message:send", (payload: SendMessagePayload) => {
    handleMessageSend(io, socket, userId, userName, userAvatar, payload).catch(
      (err) => log.error("handleMessageSend", err),
    );
  });

  socket.on(
    "chat:direct:get-or-create",
    (payload: DirectGetOrCreatePayload) => {
      handleDirectGetOrCreate(io, socket, userId, userName, payload).catch(
        (err) => log.error("handleDirectGetOrCreate", err),
      );
    },
  );

  socket.on("chat:typing:update", (payload: TypingUpdatePayload) => {
    handleTypingUpdate(socket, userId, userName, payload);
  });

  socket.on("chat:messages:read", (payload: ReadMessagesPayload) => {
    handleMessagesRead(socket, userId, payload).catch((err) =>
      log.error("handleMessagesRead", err),
    );
  });
};
