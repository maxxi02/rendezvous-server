import mongoose, { Document, Schema } from "mongoose";

export interface IMessage extends Document {
  conversationId: string;
  senderId: string;
  senderName: string;
  senderAvatar: string;
  content: string;
  readBy: string[];
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: { type: String, required: true },
    senderId: { type: String, required: true },
    senderName: { type: String, required: true },
    senderAvatar: { type: String, default: "" },
    content: { type: String, required: true, maxlength: 5000 },
    readBy: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Compound index: efficient cursor-paginated queries per conversation
MessageSchema.index({ conversationId: 1, _id: -1 });

export const MessageModel: mongoose.Model<IMessage> =
  mongoose.models.Message ?? mongoose.model<IMessage>("Message", MessageSchema);
