const express = require('express');
const db = require('../database');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/', auth, (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json({ messages: [], users: [], conversations: [] });

    const messages = db.prepare(`
      SELECT m.*, u.username as sender_name, c.name as conversation_name
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      JOIN conversations c ON m.conversation_id = c.id
      JOIN conversation_members cm ON c.id = cm.conversation_id AND cm.user_id = ?
      WHERE m.content LIKE ?
      ORDER BY m.created_at DESC LIMIT 20
    `).all(req.userId, `%${q}%`);

    const users = db.prepare(`
      SELECT id, username, avatar, status FROM users
      WHERE username LIKE ? AND id != ? LIMIT 10
    `).all(`%${q}%`, req.userId);

    const conversations = db.prepare(`
      SELECT c.* FROM conversations c
      JOIN conversation_members cm ON c.id = cm.conversation_id AND cm.user_id = ?
      WHERE c.name LIKE ? LIMIT 10
    `).all(req.userId, `%${q}%`);

    res.json({ messages, users, conversations });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
