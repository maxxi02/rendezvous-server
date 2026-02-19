import { Db, ObjectId } from "mongodb";

// ─── Collection Names ─────────────────────────────────────────────

export const COLLECTIONS = {
  CONVERSATIONS: "conversations",
  MESSAGES: "messages",
  USERS: "user", // better-auth uses "user" (singular)
} as const;

// ─── Index Setup (run once on startup) ───────────────────────────

export async function ensureMessagingIndexes(db: Db): Promise<void> {
  // Conversations: fast lookup by participant
  await db
    .collection(COLLECTIONS.CONVERSATIONS)
    .createIndex({ participants: 1 }, { background: true });
  await db
    .collection(COLLECTIONS.CONVERSATIONS)
    .createIndex({ participants: 1, updatedAt: -1 }, { background: true });

  // Messages: fast lookup by conversation + time
  await db
    .collection(COLLECTIONS.MESSAGES)
    .createIndex({ conversationId: 1, createdAt: -1 }, { background: true });
  await db
    .collection(COLLECTIONS.MESSAGES)
    .createIndex(
      { conversationId: 1, "readBy.userId": 1 },
      { background: true },
    );

  console.log("✅ Messaging indexes ensured");
}

// ─── Conversation Helpers ─────────────────────────────────────────

export function getConversationsCollection(db: Db) {
  return db.collection(COLLECTIONS.CONVERSATIONS);
}

export function getMessagesCollection(db: Db) {
  return db.collection(COLLECTIONS.MESSAGES);
}

export function getUsersCollection(db: Db) {
  return db.collection(COLLECTIONS.USERS);
}

// ─── Find or Create DM Conversation ──────────────────────────────

export async function findOrCreateDMConversation(
  db: Db,
  userAId: string,
  userBId: string,
): Promise<string> {
  const conversations = getConversationsCollection(db);

  // Check if DM already exists between these two users
  const existing = await conversations.findOne({
    participants: { $all: [userAId, userBId], $size: 2 },
    isGroup: false,
  });

  if (existing) {
    return existing._id.toString();
  }

  const toUserFilter = (id: string) => ({
    $or: [{ id }, { _id: new ObjectId(id) }],
  });

  // Fetch both users for participant details
  const users = getUsersCollection(db);
  const [userA, userB] = await Promise.all([
    users.findOne(toUserFilter(userAId)),
    users.findOne(toUserFilter(userBId)),
  ]);
  const now = new Date();
  const result = await conversations.insertOne({
    participants: [userAId, userBId],
    participantDetails: [
      {
        userId: userAId,
        name: userA?.name || "Unknown",
        image: userA?.image || null,
        isOnline: userA?.isOnline || false,
        lastSeen: userA?.lastSeen || now,
      },
      {
        userId: userBId,
        name: userB?.name || "Unknown",
        image: userB?.image || null,
        isOnline: userB?.isOnline || false,
        lastSeen: userB?.lastSeen || now,
      },
    ],
    isGroup: false,
    lastMessage: null,
    createdAt: now,
    updatedAt: now,
  });

  return result.insertedId.toString();
}

// ─── Insert Message ───────────────────────────────────────────────

export async function insertMessage(
  db: Db,
  data: {
    conversationId: string;
    senderId: string;
    senderName: string;
    senderImage?: string;
    content: string;
  },
) {
  const messages = getMessagesCollection(db);
  const conversations = getConversationsCollection(db);
  const now = new Date();

  const messageDoc = {
    conversationId: data.conversationId,
    senderId: data.senderId,
    senderName: data.senderName,
    senderImage: data.senderImage || null,
    content: data.content,
    type: "text",
    readBy: [{ userId: data.senderId, readAt: now }],
    createdAt: now,
    updatedAt: now,
  };

  const result = await messages.insertOne(messageDoc);

  // Update conversation's lastMessage + updatedAt
  await conversations.updateOne(
    { _id: new ObjectId(data.conversationId) },
    {
      $set: {
        lastMessage: {
          content: data.content,
          senderId: data.senderId,
          sentAt: now,
        },
        updatedAt: now,
      },
    },
  );

  return { ...messageDoc, _id: result.insertedId };
}

// ─── Mark Messages as Read ────────────────────────────────────────

export async function markMessagesAsRead(
  db: Db,
  conversationId: string,
  userId: string,
): Promise<string[]> {
  const messages = getMessagesCollection(db);
  const now = new Date();

  // Find unread messages in this conversation not sent by this user
  const unread = await messages
    .find({
      conversationId,
      senderId: { $ne: userId },
      "readBy.userId": { $ne: userId },
    })
    .project({ _id: 1 })
    .toArray();

  if (unread.length === 0) return [];

  const ids = unread.map((m) => m._id);

  await messages.updateMany(
    { _id: { $in: ids } },
    { $push: { readBy: { userId, readAt: now } } as any },
  );

  return ids.map((id) => id.toString());
}
