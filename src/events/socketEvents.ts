import { Server, Socket } from "socket.io";

export const handleSocketEvents = (io: Server) => {
  io.on("connection", (socket: Socket) => {
    console.log(`User connected: ${socket.id}`);

    // Join a room with username
    socket.on("join-room", (data: { room: string; username: string }) => {
      socket.join(data.room);
      console.log(`${data.username} (${socket.id}) joined room ${data.room}`);

      // Notify others in the room that a new user joined
      socket
        .to(data.room)
        .emit("user_joined", `${data.username} joined the room`);

      // Optionally, send a welcome message to the user who just joined
      socket.emit("user_joined", `Welcome to room ${data.room}`);
    });

    // Handle chat messages
    socket.on(
      "message",
      (data: { room: string; message: string; sender: string }) => {
        console.log(
          `Message from ${data.sender} in room ${data.room}: ${data.message}`,
        );

        // Broadcast to everyone in the room EXCEPT the sender
        socket.to(data.room).emit("message", {
          sender: data.sender,
          message: data.message,
        });
      },
    );

    // Handle disconnect
    socket.on("disconnect", () => {
      console.log(`User disconnected: ${socket.id}`);
    });

    // Optional: Handle errors
    socket.on("error", (error) => {
      console.error(`Socket error for ${socket.id}:`, error);
    });
  });
};
