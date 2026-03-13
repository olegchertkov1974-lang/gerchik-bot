const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const auth = require('../middleware/auth');

const router = express.Router();

router.get('/', auth, (req, res) => {
  try {
    const conversations = db.prepare(`
      SELECT c.*, cm.role,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
        (SELECT COUNT(*) FROM messages m
         WHERE m.conversation_id = c.id
         AND m.sender_id != ?
         AND m.id NOT IN (SELECT message_id FROM message_reads WHERE user_id = ?)) as unread_count
      FROM conversations c
      JOIN conversation_members cm ON c.id = cm.conversation_id AND cm.user_id = ?
      ORDER BY last_message_at DESC NULLS LAST
    `).all(req.userId, req.userId, req.userId);

    const result = conversations.map(conv => {
      const members = db.prepare(`
        SELECT u.id, u.username, u.avatar, u.status
        FROM users u JOIN conversation_members cm ON u.id = cm.user_id
        WHERE cm.conversation_id = ?
      `).all(conv.id);
      return { ...conv, members };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { userId, name, isGroup, memberIds } = req.body;

    if (!isGroup && userId) {
      const existing = db.prepare(`
        SELECT c.id FROM conversations c
        JOIN conversation_members cm1 ON c.id = cm1.conversation_id AND cm1.user_id = ?
        JOIN conversation_members cm2 ON c.id = cm2.conversation_id AND cm2.user_id = ?
        WHERE c.is_group = 0
      `).get(req.userId, userId);

      if (existing) {
        const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id);
        const members = db.prepare(`
          SELECT u.id, u.username, u.avatar, u.status
          FROM users u JOIN conversation_members cm ON u.id = cm.user_id
          WHERE cm.conversation_id = ?
        `).all(conv.id);
        return res.json({ ...conv, members, unread_count: 0 });
      }
    }

    const id = uuidv4();
    db.prepare('INSERT INTO conversations (id, name, is_group, created_by) VALUES (?, ?, ?, ?)').run(id, name || null, isGroup ? 1 : 0, req.userId);
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(id, req.userId, 'admin');

    if (isGroup && memberIds) {
      const insert = db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)');
      memberIds.forEach(mId => insert.run(id, mId, 'member'));
    } else if (userId) {
      db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)').run(id, userId, 'member');
    }

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    const members = db.prepare(`
      SELECT u.id, u.username, u.avatar, u.status
      FROM users u JOIN conversation_members cm ON u.id = cm.user_id
      WHERE cm.conversation_id = ?
    `).all(id);

    res.status(201).json({ ...conv, members, unread_count: 0 });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/members', auth, (req, res) => {
  try {
    const { userIds } = req.body;
    const insert = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)');
    userIds.forEach(userId => insert.run(req.params.id, userId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
