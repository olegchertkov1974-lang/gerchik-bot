require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const db = require('./database');

const authRoutes = require('./routes/auth');
const conversationRoutes = require('./routes/conversations');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');
const searchRoutes = require('./routes/search');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: 'http://localhost:3000', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/search', searchRoutes);

// Socket.IO
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = decoded.userId;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  onlineUsers.set(userId, socket.id);
  db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run('online', userId);
  io.emit('user:online', { userId, status: 'online' });

  socket.on('message:send', (data) => {
    const { conversationId, content, type, replyTo, fileUrl, fileName } = data;
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, content, type, file_url, file_name, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, userId, content, type || 'text', fileUrl || null, fileName || null, replyTo || null);

    const message = db.prepare(`
      SELECT m.*, u.username as sender_name, u.avatar as sender_avatar
      FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?
    `).get(id);

    const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
    members.forEach(member => {
      const memberSocketId = onlineUsers.get(member.user_id);
      if (memberSocketId) {
        io.to(memberSocketId).emit('message:new', message);
      }
    });
  });

  socket.on('message:typing', ({ conversationId }) => {
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
    members.forEach(member => {
      if (member.user_id !== userId) {
        const memberSocketId = onlineUsers.get(member.user_id);
        if (memberSocketId) {
          io.to(memberSocketId).emit('message:typing', { conversationId, userId, username: user.username });
        }
      }
    });
  });

  socket.on('message:read', ({ conversationId }) => {
    const unread = db.prepare(`
      SELECT id FROM messages WHERE conversation_id = ? AND sender_id != ?
      AND id NOT IN (SELECT message_id FROM message_reads WHERE user_id = ?)
    `).all(conversationId, userId, userId);

    const insert = db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)');
    unread.forEach(msg => insert.run(msg.id, userId));

    const members = db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId);
    members.forEach(member => {
      const memberSocketId = onlineUsers.get(member.user_id);
      if (memberSocketId) {
        io.to(memberSocketId).emit('message:read', { conversationId, userId });
      }
    });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    db.prepare('UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?').run('offline', userId);
    io.emit('user:online', { userId, status: 'offline' });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
