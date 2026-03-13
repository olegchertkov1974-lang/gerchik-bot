import React, { useState } from 'react';
import api from '../services/api';
import { useChat } from '../context/ChatContext';
import './SearchPanel.css';

export default function SearchPanel({ onClose }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState({ messages: [], users: [], conversations: [] });
  const { selectConversation, createConversation } = useChat();

  const handleSearch = async (q) => {
    setQuery(q);
    if (q.length < 2) { setResults({ messages: [], users: [], conversations: [] }); return; }
    const res = await api.get(`/search?q=${encodeURIComponent(q)}`);
    setResults(res.data);
  };

  const openUserChat = async (userId) => {
    const conv = await createConversation({ userId });
    selectConversation(conv);
    onClose();
  };

  return (
    <div className="search-overlay" onClick={onClose}>
      <div className="search-panel" onClick={e => e.stopPropagation()}>
        <div className="search-header">
          <input
            type="text"
            placeholder="Search messages, users, conversations..."
            value={query}
            onChange={e => handleSearch(e.target.value)}
            autoFocus
          />
          <button onClick={onClose}>&times;</button>
        </div>

        <div className="search-results">
          {results.users.length > 0 && (
            <div className="search-section">
              <h4>Users</h4>
              {results.users.map(user => (
                <div key={user.id} className="search-item" onClick={() => openUserChat(user.id)}>
                  <div className="search-item-avatar">{user.username[0].toUpperCase()}</div>
                  <span>{user.username}</span>
                </div>
              ))}
            </div>
          )}

          {results.messages.length > 0 && (
            <div className="search-section">
              <h4>Messages</h4>
              {results.messages.map(msg => (
                <div key={msg.id} className="search-item message-result">
                  <div className="search-msg-sender">{msg.sender_name}</div>
                  <div className="search-msg-content">{msg.content}</div>
                  {msg.conversation_name && <div className="search-msg-conv">in {msg.conversation_name}</div>}
                </div>
              ))}
            </div>
          )}

          {results.conversations.length > 0 && (
            <div className="search-section">
              <h4>Conversations</h4>
              {results.conversations.map(conv => (
                <div key={conv.id} className="search-item">
                  <span>{conv.name}</span>
                </div>
              ))}
            </div>
          )}

          {query.length >= 2 && !results.users.length && !results.messages.length && !results.conversations.length && (
            <div className="no-results">No results found</div>
          )}
        </div>
      </div>
    </div>
  );
}
