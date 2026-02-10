// config/db.ts
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

let isConnected = false;

export const connectDatabase = async () => {
  if (isConnected) {
    console.log("Using existing MongoDB connection");
    return mongoose.connection;
  }

  try {
    const conn = await mongoose.connect(process.env.DATABASE_URL!, {
      bufferCommands: false,
      maxPoolSize: 10,
    });

    isConnected = true;
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn.connection;
  } catch (error) {
    console.error("Database connection error:", error);
    throw error;
  }
};

// Export the mongoose instance for use in models
export const MONGODB = mongoose.connection;

// For better-auth adapter
export { mongoose as default };
