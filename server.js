import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import admin from 'firebase-admin';

// --- THIS IS THE FIX ---
// The old 'assert' syntax has been replaced with the modern 'with' syntax
// to ensure compatibility with the latest versions of Node.js.
import serviceAccount from './serviceAccountKey.json' with { type: 'json' };

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const boardsCollection = db.collection('boards');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

const socketToRoom = {};
const rooms = {}; // Keep this for managing the live user list in memory

const broadcastUsersUpdate = (roomId) => {
  if (rooms[roomId] && rooms[roomId].users) {
    const users = Object.entries(rooms[roomId].users).map(([id, username]) => ({ id, username }));
    io.to(roomId).emit('room-users-update', users);
  }
};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', async ({ roomId, username }) => {
    socket.join(roomId);
    socketToRoom[socket.id] = roomId;

    if (!rooms[roomId]) {
      rooms[roomId] = {
        users: {},
      };
    }
    rooms[roomId].users[socket.id] = username;
    console.log(`User ${username} (${socket.id}) joined room ${roomId}`);

    const boardDocRef = boardsCollection.doc(roomId);
    const docSnapshot = await boardDocRef.get();

    if (docSnapshot.exists) {
      const data = docSnapshot.data();
      socket.emit('load-initial-state', { notes: data.notes || [], canvasState: data.canvasState || null });
    } else {
      await boardDocRef.set({ notes: [], canvasState: null });
      socket.emit('load-initial-state', { notes: [], canvasState: null });
    }
    
    broadcastUsersUpdate(roomId);
  });

  socket.on('canvas-state-update', async (dataUrl) => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      await boardsCollection.doc(roomId).set({ canvasState: dataUrl }, { merge: true });
      socket.to(roomId).emit('canvas-state-update', dataUrl);
    }
  });

  socket.on('clear', async () => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      await boardsCollection.doc(roomId).set({ notes: [], canvasState: null }, { merge: true });
      socket.to(roomId).emit('clear');
    }
  });

  const runNoteTransaction = async (roomId, operation) => {
    if (!roomId) return;
    const boardDocRef = boardsCollection.doc(roomId);
    try {
      await db.runTransaction(async (transaction) => {
        const doc = await transaction.get(boardDocRef);
        if (!doc.exists) {
          return;
        }
        const notes = doc.data().notes || [];
        const updatedNotes = operation(notes);
        transaction.update(boardDocRef, { notes: updatedNotes });
      });
    } catch (e) {
      console.error("Transaction failed: ", e);
    }
  };

  socket.on('note-create', async (note) => {
    const roomId = socketToRoom[socket.id];
    await runNoteTransaction(roomId, (notes) => [...notes, note]);
    socket.to(roomId).emit('note-create', note);
  });

  socket.on('note-move', async (data) => {
    const roomId = socketToRoom[socket.id];
    await runNoteTransaction(roomId, (notes) =>
      notes.map(n => n.id === data.id ? { ...n, position: data.position } : n)
    );
    socket.to(roomId).emit('note-move', data);
  });

  socket.on('note-update-text', async (data) => {
    const roomId = socketToRoom[socket.id];
    await runNoteTransaction(roomId, (notes) =>
      notes.map(n => n.id === data.id ? { ...n, text: data.text } : n)
    );
    socket.to(roomId).emit('note-update-text', data);
  });

  socket.on('note-delete', async (noteId) => {
    const roomId = socketToRoom[socket.id];
    await runNoteTransaction(roomId, (notes) =>
      notes.filter(n => n.id !== noteId)
    );
    socket.to(roomId).emit('note-delete', noteId);
  });


  socket.on('cursor-move', (cursorData) => {
    const roomId = socketToRoom[socket.id];
    if (roomId) {
      socket.to(roomId).emit('cursor-move', { ...cursorData, id: socket.id });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    const roomId = socketToRoom[socket.id];
    if (roomId && rooms[roomId] && rooms[roomId].users) {
      delete rooms[roomId].users[socket.id];
      socket.to(roomId).emit('user-left', socket.id);
      broadcastUsersUpdate(roomId);

      if (Object.keys(rooms[roomId].users).length === 0) {
        delete rooms[roomId];
      }
    }
    delete socketToRoom[socket.id];
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
