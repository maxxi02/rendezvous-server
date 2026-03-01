// src/models/ChatMessage.ts

import mongoose from "mongoose";

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    senderRole: {
      type: String,
      enum: ["customer", "staff"],
      required: true,
    },
    message: { type: String, required: true },
  },
  {
    collection: "chat_messages",
    timestamps: true,
  },
);

// Compound index for fetching chat history
chatMessageSchema.index({ sessionId: 1, createdAt: 1 });

export const ChatMessage =
  mongoose.models.ChatMessage ||
  mongoose.model("ChatMessage", chatMessageSchema);
