import { Server, Socket } from "socket.io";
import mongoose from "mongoose";
import { UserStatusUpdate } from "../types/userStatus.type";
import { ObjectId } from "mongodb";

// ─── Types ───────────────────────────────────────────────────────

interface AttendanceUpdate {
  attendanceId: string;
  userId: string;
  status: string;
  totalHours?: number;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
}

// Add these new types
interface MessageAttachment {
  url: string;
  publicId?: string;
  type: "image" | "video" | "audio" | "document" | "other";
  name: string;
  size: number;
  mimeType: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

interface ReplyTo {
  messageId: string;
  content: string;
  senderName: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

const getUserCollection = () => {
  if (!mongoose.connection.db) {
    throw new Error("Database not connected");
  }
  return mongoose.connection.db.collection("user");
};

const getConversationCollection = () => {
  if (!mongoose.connection.db) {
    throw new Error("Database not connected");
  }
  return mongoose.connection.db.collection("conversations");
};

const getMessageCollection = () => {
  if (!mongoose.connection.db) {
    throw new Error("Database not connected");
  }
  return mongoose.connection.db.collection("messages");
};

const log = {
  info: (msg: string, data?: any) =>
    console.log(`ℹ️  ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  success: (msg: string, data?: any) =>
    console.log(`✅ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  error: (msg: string, data?: any) =>
    console.error(`❌ ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
  warn: (msg: string, data?: any) =>
    console.warn(`⚠️  ${msg}`, data ? JSON.stringify(data, null, 2) : ""),
};

// ─── User Service ────────────────────────────────────────────────

const setUserOnline = async (userId: string): Promise<void> => {
  const userCollection = getUserCollection();

  await userCollection.updateOne(
    { id: userId },
    {
      $set: {
        isOnline: true,
        lastSeen: new Date(),
      },
    },
  );

  log.success(`User online: ${userId}`);
};

const setUserOffline = async (userId: string): Promise<void> => {
  const userCollection = getUserCollection();

  await userCollection.updateOne(
    { id: userId },
    {
      $set: {
        isOnline: false,
        lastSeen: new Date(),
      },
    },
  );

  log.info(`User offline: ${userId}`);
};

const updateUserActivity = async (userId: string): Promise<void> => {
  const userCollection = getUserCollection();

  await userCollection.updateOne(
    { id: userId },
    {
      $set: {
        lastSeen: new Date(),
        isOnline: true,
      },
    },
  );
};

// ─── Socket Room Management ──────────────────────────────────────

const getUserRoom = (userId: string) => `user:${userId}`;

// ─── Chat Event Handlers ─────────────────────────────────────────

const handleChatMessageSend = async (
  io: Server,
  socket: Socket,
  data: {
    conversationId: string;
    content: string;
    attachments?: MessageAttachment[];
    replyTo?: ReplyTo;
  },
) => {
  const userId = socket.data.userId;
  const userName = socket.data.userName;
  const userAvatar = socket.data.userAvatar;
  const { conversationId, content, attachments = [], replyTo } = data;

  try {
    // Validate user is in conversation
    const conversation = await getConversationCollection().findOne({
      _id: new ObjectId(conversationId),
      "participants.userId": userId,
    });

    if (!conversation) {
      socket.emit("error", {
        message: "Conversation not found or access denied",
      });
      return;
    }

    const now = new Date();
    const message = {
      conversationId,
      senderId: userId,
      senderName: userName,
      senderAvatar: userAvatar,
      content: content?.trim() ?? "",
      attachments,
      reactions: [],
      replyTo: replyTo ?? null,
      createdAt: now,
      updatedAt: now,
    };

    const result = await getMessageCollection().insertOne(message);

    // Update conversation last message + unread counts
    const unreadIncrement: Record<string, number> = {};
    conversation.participants
      .filter((p: { userId: string }) => p.userId !== userId)
      .forEach((p: { userId: string }) => {
        unreadIncrement[`unreadCounts.${p.userId}`] = 1;
      });

    await getConversationCollection().updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: {
          lastMessage: {
            content:
              content?.trim() ||
              (attachments.length > 0 ? "📎 Attachment" : ""),
            senderName: userName,
            sentAt: now,
            hasAttachment: attachments.length > 0,
          },
          updatedAt: now,
        },
        $inc: unreadIncrement,
      },
    );

    const outbound = { ...message, _id: result.insertedId.toString() };

    // Emit to all participants in the room
    io.to(conversationId).emit("chat:message:received", {
      conversationId,
      message: outbound,
    });

    log.success("Message sent", { conversationId, messageId: outbound._id });
  } catch (error) {
    log.error("Error in chat:message:send", error);
    socket.emit("error", { message: "Failed to send message" });
  }
};

const handleChatMessagesLoad = async (
  socket: Socket,
  data: {
    conversationId: string;
    before?: string;
    limit?: number;
  },
) => {
  const userId = socket.data.userId;
  const { conversationId, before, limit = 50 } = data;

  try {
    // Verify user is in conversation
    const conversation = await getConversationCollection().findOne({
      _id: new ObjectId(conversationId),
      "participants.userId": userId,
    });

    if (!conversation) {
      socket.emit("error", { message: "Conversation not found" });
      return;
    }

    // Build query
    const query: any = { conversationId };
    if (before) {
      query.createdAt = { $lt: new Date(before) };
    }

    const messages = await getMessageCollection()
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    // Mark messages as read
    await getConversationCollection().updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: { [`unreadCounts.${userId}`]: 0 },
      },
    );

    socket.emit("chat:messages:loaded", {
      conversationId,
      messages: messages.map((m) => ({ ...m, _id: m._id.toString() })),
      hasMore: messages.length === limit,
    });

    log.info(`Messages loaded for conversation ${conversationId}`);
  } catch (error) {
    log.error("Error in chat:messages:load", error);
    socket.emit("error", { message: "Failed to load messages" });
  }
};

const handleChatConversationsLoad = async (io: Server, socket: Socket) => {
  const userId = socket.data.userId;

  try {
    const conversations = await getConversationCollection()
      .find({ "participants.userId": userId })
      .sort({ updatedAt: -1 })
      .toArray();

    // Join all conversation rooms for real-time updates
    const roomIds = conversations.map((c) => c._id.toString());
    socket.join(roomIds);

    socket.emit("chat:conversations:loaded", {
      conversations: conversations.map((c) => ({
        ...c,
        _id: c._id.toString(),
        participants: c.participants,
        unreadCounts: c.unreadCounts || {},
      })),
    });

    log.success(`Conversations loaded for user ${userId}`, {
      count: conversations.length,
    });
  } catch (error) {
    log.error("Error in chat:conversations:load", error);
    socket.emit("error", { message: "Failed to load conversations" });
  }
};

const handleChatDirectGetOrCreate = async (
  socket: Socket,
  data: {
    targetUserId: string;
    targetUserName: string;
    targetUserAvatar?: string;
  },
) => {
  const userId = socket.data.userId;
  const { targetUserId, targetUserName, targetUserAvatar } = data;

  try {
    // Check if conversation already exists
    let conversation = await getConversationCollection().findOne({
      type: "direct",
      participants: {
        $all: [
          { $elemMatch: { userId } },
          { $elemMatch: { userId: targetUserId } },
        ],
      },
    });

    if (!conversation) {
      // Get user details for both participants
      const users = await getUserCollection()
        .find({ id: { $in: [userId, targetUserId] } })
        .toArray();

      const userMap = new Map(users.map((u) => [u.id, u]));

      const participants = [
        {
          userId,
          userName: userMap.get(userId)?.name || "Unknown",
          userAvatar: userMap.get(userId)?.image || "",
          role: "member" as const,
          joinedAt: new Date(),
          lastReadAt: new Date(),
        },
        {
          userId: targetUserId,
          userName: targetUserName, // use what client sent directly
          userAvatar: targetUserAvatar || "", // use what client sent directly
          role: "member" as const,
          joinedAt: new Date(),
          lastReadAt: new Date(),
        },
      ];

      const now = new Date();

      // Create the document WITHOUT _id, let MongoDB generate it
      const newConversation = {
        type: "direct",
        participants,
        unreadCounts: {
          [userId]: 0,
          [targetUserId]: 0,
        },
        createdAt: now,
        updatedAt: now,
      };

      const result =
        await getConversationCollection().insertOne(newConversation);

      // Get the inserted document with the generated _id
      conversation = await getConversationCollection().findOne({
        _id: result.insertedId,
      });
    }

    if (conversation) {
      // Join the conversation room
      socket.join(conversation._id.toString());

      socket.emit("chat:direct:created", {
        ...conversation,
        _id: conversation._id.toString(),
      });

      log.info(`Direct conversation created/retrieved`, {
        userId,
        targetUserId,
      });
    }
  } catch (error) {
    log.error("Error in chat:direct:get-or-create", error);
    socket.emit("error", { message: "Failed to create/get conversation" });
  }
};

const handleChatTypingUpdate = async (
  io: Server,
  socket: Socket,
  data: {
    conversationId: string;
    isTyping: boolean;
  },
) => {
  const userId = socket.data.userId;
  const userName = socket.data.userName;
  const { conversationId, isTyping } = data;

  try {
    // Verify user is in conversation
    const conversation = await getConversationCollection().findOne({
      _id: new ObjectId(conversationId),
      "participants.userId": userId,
    });

    if (!conversation) return;

    // Broadcast typing status to all other participants in the room
    socket.to(conversationId).emit("chat:typing:updated", {
      conversationId,
      userId,
      userName,
      isTyping,
    });
  } catch (error) {
    log.error("Error in chat:typing:update", error);
  }
};

const handleChatMessagesRead = async (
  io: Server,
  socket: Socket,
  data: {
    conversationId: string;
  },
) => {
  const userId = socket.data.userId;
  const { conversationId } = data;

  try {
    await getConversationCollection().updateOne(
      { _id: new ObjectId(conversationId) },
      {
        $set: { [`unreadCounts.${userId}`]: 0 },
      },
    );

    // Notify others that user has read messages
    socket.to(conversationId).emit("chat:read:updated", {
      conversationId,
      userId,
      readAt: new Date(),
    });

    log.info(`Messages marked as read`, { conversationId, userId });
  } catch (error) {
    log.error("Error in chat:messages:read", error);
  }
};

// ─── Internal API for Group Creation Notifications ───────────────

export const notifyGroupCreated = async (
  io: Server,
  data: {
    conversationId: string;
    participants: Array<{ userId: string }>;
    conversation: any;
  },
) => {
  const { conversationId, participants, conversation } = data;

  for (const participant of participants) {
    // Find socket for this user and join them to the room
    const sockets = await io.fetchSockets();
    const userSocket = sockets.find(
      (s) => s.data.userId === participant.userId,
    );

    if (userSocket) {
      await userSocket.join(conversationId);
      userSocket.emit("chat:conversation:updated", {
        ...conversation,
        _id: conversationId,
      });
    }
  }

  log.success(`Group created notification sent`, { conversationId });
};

// ─── Event Handlers ──────────────────────────────────────────────

const handleConnection = (io: Server, socket: Socket) => {
  const userId = socket.handshake.auth.userId as string | undefined;
  const userName = socket.handshake.auth.userName as string | undefined;
  const userAvatar = socket.handshake.auth.userAvatar as string | undefined;

  if (!userId) {
    log.warn("Connection rejected: No userId", { socketId: socket.id });
    socket.disconnect();
    return;
  }

  // Store user data in socket for later use
  socket.data.userId = userId;
  socket.data.userName = userName;
  socket.data.userAvatar = userAvatar;

  log.success("Client connected", { socketId: socket.id, userId });

  // Join user's personal room for targeted notifications
  const userRoom = getUserRoom(userId);
  socket.join(userRoom);
  log.info(`User joined room: ${userRoom}`);

  // User comes online
  socket.on("user:online", async () => {
    try {
      await setUserOnline(userId);

      const update: UserStatusUpdate = {
        userId,
        isOnline: true,
        lastSeen: new Date(),
      };

      io.emit("user:status:changed", update);
    } catch (error) {
      log.error("Error in user:online", error);
      socket.emit("error", { message: "Failed to update online status" });
    }
  });

  // User activity
  socket.on("user:activity", async () => {
    try {
      await updateUserActivity(userId);
    } catch (error) {
      log.error("Error in user:activity", error);
    }
  });

  // ─── Chat Events ────────────────────────────────────────────────

  socket.on("chat:message:send", (data) =>
    handleChatMessageSend(io, socket, data),
  );
  socket.on("chat:messages:load", (data) =>
    handleChatMessagesLoad(socket, data),
  );
  socket.on("chat:conversations:load", () =>
    handleChatConversationsLoad(io, socket),
  );
  socket.on("chat:direct:get-or-create", (data) =>
    handleChatDirectGetOrCreate(socket, data),
  );
  socket.on("chat:typing:update", (data) =>
    handleChatTypingUpdate(io, socket, data),
  );
  socket.on("chat:messages:read", (data) =>
    handleChatMessagesRead(io, socket, data),
  );

  // ─── Attendance Event Triggers (from API routes) ────────────────

  socket.on(
    "attendance:approved:trigger",
    (data: {
      userId: string;
      attendanceId: string;
      status: string;
      totalHours?: number;
      approvedBy: string;
    }) => {
      try {
        emitAttendanceApproved(io, data);
      } catch (error) {
        log.error("Error in attendance:approved:trigger", error);
      }
    },
  );

  socket.on(
    "attendance:rejected:trigger",
    (data: {
      userId: string;
      attendanceId: string;
      rejectionReason: string;
      rejectedBy: string;
    }) => {
      try {
        emitAttendanceRejected(io, data);
      } catch (error) {
        log.error("Error in attendance:rejected:trigger", error);
      }
    },
  );

  socket.on(
    "attendance:status:changed:trigger",
    (data: { userId: string; attendanceId: string; status: string }) => {
      try {
        emitAttendanceStatusChange(io, data);
      } catch (error) {
        log.error("Error in attendance:status:changed:trigger", error);
      }
    },
  );

  // User disconnects
  socket.on("disconnect", async (reason) => {
    try {
      await setUserOffline(userId);

      const update: UserStatusUpdate = {
        userId,
        isOnline: false,
        lastSeen: new Date(),
      };

      io.emit("user:status:changed", update);

      log.info("Client disconnected", { userId, reason });
    } catch (error) {
      log.error("Error in disconnect", error);
    }
  });

  // Handle errors
  socket.on("error", (error) => {
    log.error("Socket error", { userId, error });
  });
};

// ─── Attendance Notification Helpers ─────────────────────────────

export const emitAttendanceApproved = (
  io: Server,
  data: {
    userId: string;
    attendanceId: string;
    status: string;
    totalHours?: number;
    approvedBy: string;
  },
) => {
  const userRoom = getUserRoom(data.userId);

  const payload: AttendanceUpdate = {
    attendanceId: data.attendanceId,
    userId: data.userId,
    status: data.status,
    totalHours: data.totalHours,
    approvedBy: data.approvedBy,
  };

  io.to(userRoom).emit("attendance:approved", payload);

  log.success(
    `Attendance approved notification sent to ${data.userId}`,
    payload,
  );
};

export const emitAttendanceRejected = (
  io: Server,
  data: {
    userId: string;
    attendanceId: string;
    rejectionReason: string;
    rejectedBy: string;
  },
) => {
  const userRoom = getUserRoom(data.userId);

  const payload: AttendanceUpdate = {
    attendanceId: data.attendanceId,
    userId: data.userId,
    status: "REJECTED",
    rejectionReason: data.rejectionReason,
    rejectedBy: data.rejectedBy,
  };

  io.to(userRoom).emit("attendance:rejected", payload);

  log.success(
    `Attendance rejected notification sent to ${data.userId}`,
    payload,
  );
};

export const emitAttendanceStatusChange = (
  io: Server,
  data: {
    userId: string;
    attendanceId: string;
    status: string;
  },
) => {
  const userRoom = getUserRoom(data.userId);

  const payload: AttendanceUpdate = {
    attendanceId: data.attendanceId,
    userId: data.userId,
    status: data.status,
  };

  io.to(userRoom).emit("attendance:status:changed", payload);

  log.info(`Attendance status change sent to ${data.userId}`, payload);
};

// ─── Main Export ─────────────────────────────────────────────────

export const handleSocketEvents = (io: Server): void => {
  io.on("connection", (socket) => {
    handleConnection(io, socket);
  });

  log.info("Socket.IO event handlers registered");
};

// Export io instance for use in API routes
let ioInstance: Server | null = null;

export const setSocketIOInstance = (io: Server): void => {
  ioInstance = io;
  log.info("Socket.IO instance registered for API routes");
};

export const getSocketIOInstance = (): Server => {
  if (!ioInstance) {
    throw new Error("Socket.IO instance not initialized");
  }
  return ioInstance;
};
