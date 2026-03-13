const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const auth = require('../middleware/auth');

const router = express.Router();

router.post('/register', (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ? OR username = ?').get(email, username);
    if (existing) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const id = uuidv4();

    db.prepare('INSERT INTO users (id, username, email, password) VALUES (?, ?, ?, ?)').run(id, username, email, hashedPassword);

    const token = jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id, username, email, avatar: null, status: 'online' } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    db.prepare('UPDATE users SET status = ? WHERE id = ?').run('online', user.id);
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, avatar: user.avatar, status: 'online' } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', auth, (req, res) => {
  try {
    const user = db.prepare('SELECT id, username, email, avatar, status FROM users WHERE id = ?').get(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/profile', auth, (req, res) => {
  try {
    const { username, avatar } = req.body;
    if (username) {
      db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.userId);
    }
    if (avatar) {
      db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatar, req.userId);
    }
    const user = db.prepare('SELECT id, username, email, avatar, status FROM users WHERE id = ?').get(req.userId);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
