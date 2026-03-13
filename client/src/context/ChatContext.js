import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../services/api';
import { connectSocket, disconnectSocket, getSocket } from '../services/socket';
import { useAuth } from './AuthContext';

const ChatContext = createContext();

export function ChatProvider({ children }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState({});
  const [onlineUsers, setOnlineUsers] = useState({});
  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    if (!user) return;

    const token = localStorage.getItem('token');
    const socket = connectSocket(token);

    api.get('/conversations').then(res => setConversations(res.data));

    socket.on('message:new', (message) => {
      setMessages(prev => {
        if (prev.some(m => m.id === message.id)) return prev;
        return [...prev, message];
      });

      setConversations(prev => prev.map(c => {
        if (c.id === message.conversation_id) {
          return { ...c, last_message: message.content, last_message_at: message.created_at, unread_count: (c.unread_count || 0) + (message.sender_id !== user.id ? 1 : 0) };
        }
        return c;
      }).sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0)));

      if (message.sender_id !== user.id) {
        setNotifications(prev => [...prev, { id: message.id, type: 'message', content: message.content, sender: message.sender_name }]);
      }
    });

    socket.on('message:typing', ({ conversationId, userId, username }) => {
      setTypingUsers(prev => ({ ...prev, [conversationId]: { userId, username } }));
      setTimeout(() => {
        setTypingUsers(prev => {
          const next = { ...prev };
          delete next[conversationId];
          return next;
        });
      }, 3000);
    });

    socket.on('user:online', ({ userId, status }) => {
      setOnlineUsers(prev => ({ ...prev, [userId]: status }));
    });

    socket.on('message:read', ({ conversationId }) => {
      setConversations(prev => prev.map(c =>
        c.id === conversationId ? { ...c, unread_count: 0 } : c
      ));
    });

    return () => disconnectSocket();
  }, [user]);

  const sendMessage = useCallback((conversationId, content, type = 'text', replyTo = null) => {
    const socket = getSocket();
    if (socket) {
      socket.emit('message:send', { conversationId, content, type, replyTo });
    }
  }, []);

  const sendTyping = useCallback((conversationId) => {
    const socket = getSocket();
    if (socket) {
      socket.emit('message:typing', { conversationId });
    }
  }, []);

  const markAsRead = useCallback((conversationId) => {
    const socket = getSocket();
    if (socket) {
      socket.emit('message:read', { conversationId });
    }
    setConversations(prev => prev.map(c =>
      c.id === conversationId ? { ...c, unread_count: 0 } : c
    ));
  }, []);

  const loadMessages = useCallback(async (conversationId) => {
    const res = await api.get(`/messages/${conversationId}`);
    setMessages(res.data);
  }, []);

  const selectConversation = useCallback(async (conversation) => {
    setActiveConversation(conversation);
    await loadMessages(conversation.id);
    markAsRead(conversation.id);
  }, [loadMessages, markAsRead]);

  const createConversation = useCallback(async (data) => {
    const res = await api.post('/conversations', data);
    setConversations(prev => {
      if (prev.some(c => c.id === res.data.id)) return prev;
      return [res.data, ...prev];
    });
    return res.data;
  }, []);

  const dismissNotification = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  return (
    <ChatContext.Provider value={{
      conversations, activeConversation, messages, typingUsers, onlineUsers, notifications,
      sendMessage, sendTyping, markAsRead, selectConversation, createConversation, dismissNotification,
      setActiveConversation
    }}>
      {children}
    </ChatContext.Provider>
  );
}

export const useChat = () => useContext(ChatContext);
