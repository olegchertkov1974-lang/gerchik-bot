import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import NewChatModal from './NewChatModal';
import { formatDistanceToNow } from 'date-fns';
import './Sidebar.css';

export default function Sidebar({ onSearchClick }) {
  const { user, logout } = useAuth();
  const { conversations, activeConversation, selectConversation, onlineUsers } = useChat();
  const [showNewChat, setShowNewChat] = useState(false);

  const getConversationName = (conv) => {
    if (conv.is_group) return conv.name || 'Group Chat';
    const other = conv.members?.find(m => m.id !== user.id);
    return other?.username || 'Chat';
  };

  const getConversationAvatar = (conv) => {
    if (conv.is_group) return conv.name?.[0]?.toUpperCase() || 'G';
    const other = conv.members?.find(m => m.id !== user.id);
    return other?.username?.[0]?.toUpperCase() || '?';
  };

  const isOnline = (conv) => {
    if (conv.is_group) return false;
    const other = conv.members?.find(m => m.id !== user.id);
    return other && (onlineUsers[other.id] === 'online' || other.status === 'online');
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-user">
          <div className="avatar">{user.username[0].toUpperCase()}</div>
          <span className="sidebar-username">{user.username}</span>
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={onSearchClick} title="Search">&#128269;</button>
          <button className="icon-btn" onClick={() => setShowNewChat(true)} title="New chat">&#43;</button>
          <button className="icon-btn" onClick={logout} title="Logout">&#10145;</button>
        </div>
      </div>

      <div className="conversation-list">
        {conversations.map(conv => (
          <div
            key={conv.id}
            className={`conversation-item ${activeConversation?.id === conv.id ? 'active' : ''}`}
            onClick={() => selectConversation(conv)}
          >
            <div className="conversation-avatar">
              {getConversationAvatar(conv)}
              {isOnline(conv) && <span className="online-dot" />}
            </div>
            <div className="conversation-info">
              <div className="conversation-name">{getConversationName(conv)}</div>
              <div className="conversation-preview">{conv.last_message || 'No messages yet'}</div>
            </div>
            <div className="conversation-meta">
              {conv.last_message_at && (
                <span className="conversation-time">
                  {formatDistanceToNow(new Date(conv.last_message_at), { addSuffix: false })}
                </span>
              )}
              {conv.unread_count > 0 && (
                <span className="unread-badge">{conv.unread_count}</span>
              )}
            </div>
          </div>
        ))}
        {conversations.length === 0 && (
          <div className="no-conversations">No conversations yet. Start a new chat!</div>
        )}
      </div>

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
    </div>
  );
}
