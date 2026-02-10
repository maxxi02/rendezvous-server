// models/User.ts (on your Socket.IO server)
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    name: String,
    email: { type: String, required: true },
    emailVerified: Boolean,
    role: { type: String, default: "staff" },
    phoneNumber: String,
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    banned: Boolean,
    banReason: String,
    banExpiresAt: Date,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  {
    collection: "user", // Match better-auth collection name
    timestamps: false, // We handle this manually
  },
);

export const User = mongoose.models.User || mongoose.model("User", userSchema);
