import mongoose, { Document, Schema } from "mongoose";

export interface ILastMessage {
  content: string;
  senderId: string;
  senderName: string;
  timestamp: Date;
}

export interface IConversation extends Document {
  type: "group" | "direct";
  name: string;
  slug: string; // unique identifier — e.g. "group:all-staff" | "direct:idA:idB"
  participants: string[];
  lastMessage?: ILastMessage;
  createdAt: Date;
  updatedAt: Date;
}

const LastMessageSchema = new Schema<ILastMessage>(
  {
    content: { type: String, required: true },
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    timestamp: { type: Date, required: true },
  },
  { _id: false },
);

const ConversationSchema = new Schema<IConversation>(
  {
    type: { type: String, enum: ["group", "direct"], required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    participants: { type: [String], required: true, default: [] },
    lastMessage: { type: LastMessageSchema },
  },
  { timestamps: true },
);

ConversationSchema.index({ participants: 1 });
ConversationSchema.index({ updatedAt: -1 });

export const ConversationModel: mongoose.Model<IConversation> =
  mongoose.models.Conversation ??
  mongoose.model<IConversation>("Conversation", ConversationSchema);
