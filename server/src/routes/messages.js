const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const auth = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.get('/:conversationId', auth, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const messages = db.prepare(`
      SELECT m.*, u.username as sender_name, u.avatar as sender_avatar
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.params.conversationId, limit, offset);

    res.json(messages.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:conversationId', auth, (req, res) => {
  try {
    const { content, type, replyTo } = req.body;
    const id = uuidv4();

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, content, type, reply_to)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, req.params.conversationId, req.userId, content, type || 'text', replyTo || null);

    const message = db.prepare(`
      SELECT m.*, u.username as sender_name, u.avatar as sender_avatar
      FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?
    `).get(id);

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:conversationId/file', auth, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const id = uuidv4();
    const fileUrl = `/uploads/${req.file.filename}`;
    const type = req.file.mimetype.startsWith('image/') ? 'image' : 'file';

    db.prepare(`
      INSERT INTO messages (id, conversation_id, sender_id, content, type, file_url, file_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.params.conversationId, req.userId, req.body.content || '', type, fileUrl, req.file.originalname);

    const message = db.prepare(`
      SELECT m.*, u.username as sender_name, u.avatar as sender_avatar
      FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?
    `).get(id);

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/read/:messageId', auth, (req, res) => {
  try {
    db.prepare('INSERT OR IGNORE INTO message_reads (message_id, user_id) VALUES (?, ?)').run(req.params.messageId, req.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
