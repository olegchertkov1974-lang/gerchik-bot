# Messenger App

Real-time messenger built with React and Node.js.

## Features

- User registration and authentication (JWT)
- Real-time messaging via Socket.IO
- Direct messages and group chats
- File and image sharing (up to 10MB)
- Typing indicators and online status
- Message search across conversations
- Push notifications for new messages
- Message replies
- Read receipts

## Tech Stack

- **Frontend:** React 18, React Router, Socket.IO Client, Axios
- **Backend:** Node.js, Express, Socket.IO, SQLite (better-sqlite3)
- **Auth:** JWT + bcrypt

## Getting Started

```bash
# Install all dependencies
npm run install-all

# Run both server and client
npm run dev
```

- Server runs on `http://localhost:5000`
- Client runs on `http://localhost:3000`
