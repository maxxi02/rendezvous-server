import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

export const connectDatabase = async () => {
  try {
    const conn = await mongoose.connect(process.env.DATABASE_URL!);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("Database connection error:", error);
    process.exit(1);
  }
};
