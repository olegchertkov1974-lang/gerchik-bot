const express = require('express');
const db = require('../database');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/search', auth, (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);

    const users = db.prepare(`
      SELECT id, username, email, avatar, status
      FROM users WHERE username LIKE ? AND id != ?
      LIMIT 20
    `).all(`%${q}%`, req.userId);

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/contacts', auth, (req, res) => {
  try {
    const contacts = db.prepare(`
      SELECT DISTINCT u.id, u.username, u.avatar, u.status
      FROM users u
      JOIN conversation_members cm ON u.id = cm.user_id
      WHERE cm.conversation_id IN (
        SELECT conversation_id FROM conversation_members WHERE user_id = ?
      ) AND u.id != ?
    `).all(req.userId, req.userId);

    res.json(contacts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
