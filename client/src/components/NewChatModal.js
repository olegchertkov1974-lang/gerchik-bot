import React, { useState } from 'react';
import api from '../services/api';
import { useChat } from '../context/ChatContext';
import './NewChatModal.css';

export default function NewChatModal({ onClose }) {
  const [tab, setTab] = useState('direct');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [groupName, setGroupName] = useState('');
  const [selectedUsers, setSelectedUsers] = useState([]);
  const { createConversation, selectConversation } = useChat();

  const handleSearch = async (q) => {
    setSearch(q);
    if (q.length < 2) { setResults([]); return; }
    const res = await api.get(`/users/search?q=${encodeURIComponent(q)}`);
    setResults(res.data);
  };

  const startDirectChat = async (userId) => {
    const conv = await createConversation({ userId });
    selectConversation(conv);
    onClose();
  };

  const toggleUser = (user) => {
    setSelectedUsers(prev =>
      prev.some(u => u.id === user.id)
        ? prev.filter(u => u.id !== user.id)
        : [...prev, user]
    );
  };

  const createGroup = async () => {
    if (!groupName.trim() || selectedUsers.length === 0) return;
    const conv = await createConversation({
      name: groupName,
      isGroup: true,
      memberIds: selectedUsers.map(u => u.id)
    });
    selectConversation(conv);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>New Conversation</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="modal-tabs">
          <button className={tab === 'direct' ? 'active' : ''} onClick={() => setTab('direct')}>Direct Message</button>
          <button className={tab === 'group' ? 'active' : ''} onClick={() => setTab('group')}>Group Chat</button>
        </div>

        {tab === 'group' && (
          <input
            type="text"
            className="group-name-input"
            placeholder="Group name"
            value={groupName}
            onChange={e => setGroupName(e.target.value)}
          />
        )}

        <input
          type="text"
          className="search-input"
          placeholder="Search users..."
          value={search}
          onChange={e => handleSearch(e.target.value)}
        />

        {tab === 'group' && selectedUsers.length > 0 && (
          <div className="selected-users">
            {selectedUsers.map(u => (
              <span key={u.id} className="selected-chip" onClick={() => toggleUser(u)}>
                {u.username} &times;
              </span>
            ))}
          </div>
        )}

        <div className="user-results">
          {results.map(user => (
            <div key={user.id} className="user-result-item" onClick={() => tab === 'direct' ? startDirectChat(user.id) : toggleUser(user)}>
              <div className="user-result-avatar">{user.username[0].toUpperCase()}</div>
              <div className="user-result-info">
                <div className="user-result-name">{user.username}</div>
                <div className="user-result-status">{user.status}</div>
              </div>
              {tab === 'group' && selectedUsers.some(u => u.id === user.id) && (
                <span className="check-mark">&#10003;</span>
              )}
            </div>
          ))}
        </div>

        {tab === 'group' && (
          <button className="create-group-btn" onClick={createGroup} disabled={!groupName.trim() || selectedUsers.length === 0}>
            Create Group ({selectedUsers.length} members)
          </button>
        )}
      </div>
    </div>
  );
}
