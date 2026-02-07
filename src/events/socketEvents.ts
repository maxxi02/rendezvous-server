import { Server, Socket } from "socket.io";

export const handleSocketEvents = (io: Server) => {
  io.on("connection", (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    // Example: Join a room
    socket.on("join-room", (roomId: string) => {
      socket.join(roomId);
      console.log(`Socket ${socket.id} joined room ${roomId}`);
      socket.to(roomId).emit("user-joined", socket.id);
    });

    // Example: Send message
    socket.on("send-message", (data: { roomId: string; message: string }) => {
      io.to(data.roomId).emit("receive-message", {
        socketId: socket.id,
        message: data.message,
        timestamp: new Date(),
      });
    });

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id}`);
    });
  });
};
