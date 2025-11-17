const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

/*
rooms = {
  [roomId]: {
    password: "string|null",
    hostId: "socketId",
    users: { [socketId]: { name, isHost } },
    lobby: { [socketId]: { name } }
  }
}
*/
const rooms = {};

function broadcastParticipants(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit("participants-update", {
    users: room.users,
    hostId: room.hostId,
  });
}

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("join-room", (data) => {
    const { roomId, username, password, isHost } = data;
    if (!roomId) return;

    let room = rooms[roomId];

    // First person -> host & room create
    if (!room) {
      rooms[roomId] = {
        password: password || null,
        hostId: socket.id,
        users: {},
        lobby: {},
      };
      room = rooms[roomId];
      room.users[socket.id] = { name: username || "Host", isHost: true };
      socket.join(roomId);

      socket.emit("joined-room", {
        roomId,
        isHost: true,
      });

      // No one else yet
      socket.emit("all-users", []);
      broadcastParticipants(roomId);
      return;
    }

    // Room already exists, check password
    if (room.password && room.password !== password) {
      socket.emit("join-error", "Incorrect room password.");
      return;
    }

    // Non-host users go to lobby first
    room.lobby[socket.id] = { name: username || "Guest" };
    socket.join(roomId + "-lobby"); // optional lobby room
    socket.emit("lobby-wait", "Waiting for host to admit you...");

    // Notify host
    const hostSocket = io.sockets.sockets.get(room.hostId);
    if (hostSocket) {
      hostSocket.emit("lobby-update", {
        lobby: room.lobby,
        roomId,
      });
    }
  });

  socket.on("approve-user", ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    const userInfo = room.lobby[userId];
    if (!userInfo) return;

    delete room.lobby[userId];
    room.users[userId] = { name: userInfo.name, isHost: false };

    const userSocket = io.sockets.sockets.get(userId);
    if (userSocket) {
      userSocket.join(roomId);
      userSocket.leave(roomId + "-lobby");

      userSocket.emit("joined-room", {
        roomId,
        isHost: false,
      });

      // Send the list of existing users to the newly approved one
      const otherUsers = Object.keys(room.users).filter((id) => id !== userId);
      userSocket.emit("all-users", otherUsers);
    }

    // Update lobby list to host and participants list to everyone
    const hostSocket = io.sockets.sockets.get(room.hostId);
    if (hostSocket) {
      hostSocket.emit("lobby-update", {
        lobby: room.lobby,
        roomId,
      });
    }
    broadcastParticipants(roomId);
  });

  socket.on("reject-user", ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    if (!room.lobby[userId]) return;

    const userSocket = io.sockets.sockets.get(userId);
    delete room.lobby[userId];

    if (userSocket) {
      userSocket.emit("join-error", "Host rejected your request.");
      userSocket.leave(roomId + "-lobby");
      userSocket.disconnect(true);
    }

    const hostSocket = io.sockets.sockets.get(room.hostId);
    if (hostSocket) {
      hostSocket.emit("lobby-update", {
        lobby: room.lobby,
        roomId,
      });
    }
  });

  // WebRTC signaling
  socket.on("sending-signal", (payload) => {
    io.to(payload.userToSignal).emit("user-joined", {
      signal: payload.signal,
      callerId: payload.callerId,
    });
  });

  socket.on("returning-signal", (payload) => {
    io.to(payload.callerId).emit("receiving-returned-signal", {
      signal: payload.signal,
      id: socket.id,
    });
  });

  // Chat
  socket.on("chat-message", ({ roomId, message }) => {
    const room = rooms[roomId];
    if (!room || !room.users[socket.id]) return;
    const user = room.users[socket.id];
    io.to(roomId).emit("chat-message", {
      from: user.name,
      message,
      time: new Date().toISOString(),
    });
  });

  // File sharing (simple, for small files)
  socket.on("file-share", ({ roomId, fileName, fileDataUrl, mimeType }) => {
    const room = rooms[roomId];
    if (!room || !room.users[socket.id]) return;
    const user = room.users[socket.id];
    io.to(roomId).emit("file-share", {
      from: user.name,
      fileName,
      fileDataUrl,
      mimeType,
      time: new Date().toISOString(),
    });
  });

  // Whiteboard
  socket.on("whiteboard-draw", ({ roomId, line }) => {
    socket.to(roomId).emit("whiteboard-draw", { line });
  });

  socket.on("whiteboard-clear", ({ roomId }) => {
    socket.to(roomId).emit("whiteboard-clear");
  });

  // Live captions
  socket.on("caption-update", ({ roomId, text }) => {
    const room = rooms[roomId];
    if (!room || !room.users[socket.id]) return;
    const user = room.users[socket.id];
    socket.to(roomId).emit("caption-update", {
      from: user.name,
      text,
    });
  });

  // Host controls
  socket.on("host-mute-user", ({ roomId, userId, type }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    io.to(userId).emit("force-mute", { type });
  });

  socket.on("remove-user", ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room || socket.id !== room.hostId) return;
    const target = io.sockets.sockets.get(userId);
    if (target) {
      target.emit("removed-by-host");
      target.leave(roomId);
      target.disconnect(true);
    }
    if (room.users[userId]) delete room.users[userId];
    broadcastParticipants(roomId);
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const [roomId, room] of Object.entries(rooms)) {
      let changed = false;
      if (room.users[socket.id]) {
        delete room.users[socket.id];
        changed = true;

        io.to(roomId).emit("user-left", socket.id);

        // If host leaves, destroy room
        if (room.hostId === socket.id) {
          io.to(roomId).emit("room-ended");
          delete rooms[roomId];
          continue;
        }
      }
      if (room.lobby[socket.id]) {
        delete room.lobby[socket.id];
        changed = true;
      }
      if (changed) broadcastParticipants(roomId);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
