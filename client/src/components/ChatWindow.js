import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import MessageBubble from './MessageBubble';
import FileUpload from './FileUpload';
import { format } from 'date-fns';
import './ChatWindow.css';

export default function ChatWindow() {
  const { user } = useAuth();
  const { activeConversation, messages, sendMessage, sendTyping, typingUsers } = useChat();
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [showFileUpload, setShowFileUpload] = useState(false);
  const messagesEndRef = useRef(null);
  const typingTimeout = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (!activeConversation) {
    return (
      <div className="chat-window empty">
        <div className="empty-state">
          <div className="empty-icon">&#128172;</div>
          <h2>Welcome to Messenger</h2>
          <p>Select a conversation or start a new chat</p>
        </div>
      </div>
    );
  }

  const otherUser = activeConversation.members?.find(m => m.id !== user.id);
  const chatName = activeConversation.is_group
    ? (activeConversation.name || 'Group Chat')
    : (otherUser?.username || 'Chat');
  const typing = typingUsers[activeConversation.id];

  const handleSend = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    sendMessage(activeConversation.id, text.trim(), 'text', replyTo?.id);
    setText('');
    setReplyTo(null);
  };

  const handleTyping = () => {
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    sendTyping(activeConversation.id);
    typingTimeout.current = setTimeout(() => {}, 3000);
  };

  const groupMessagesByDate = () => {
    const groups = {};
    messages.filter(m => m.conversation_id === activeConversation.id).forEach(msg => {
      const date = format(new Date(msg.created_at), 'yyyy-MM-dd');
      if (!groups[date]) groups[date] = [];
      groups[date].push(msg);
    });
    return groups;
  };

  const dateGroups = groupMessagesByDate();

  return (
    <div className="chat-window">
      <div className="chat-header">
        <div className="chat-header-info">
          <div className="conversation-avatar small">
            {chatName[0].toUpperCase()}
          </div>
          <div>
            <div className="chat-header-name">{chatName}</div>
            <div className="chat-header-status">
              {typing ? `${typing.username} is typing...` :
                activeConversation.is_group
                  ? `${activeConversation.members?.length || 0} members`
                  : (otherUser?.status === 'online' ? 'Online' : 'Offline')}
            </div>
          </div>
        </div>
      </div>

      <div className="messages-container">
        {Object.entries(dateGroups).map(([date, msgs]) => (
          <div key={date}>
            <div className="date-divider">
              <span>{format(new Date(date), 'MMMM d, yyyy')}</span>
            </div>
            {msgs.map(msg => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isOwn={msg.sender_id === user.id}
                onReply={() => setReplyTo(msg)}
              />
            ))}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {replyTo && (
        <div className="reply-bar">
          <div className="reply-content">
            <strong>{replyTo.sender_name}</strong>
            <span>{replyTo.content}</span>
          </div>
          <button className="reply-close" onClick={() => setReplyTo(null)}>&times;</button>
        </div>
      )}

      <form className="message-input" onSubmit={handleSend}>
        <button type="button" className="attach-btn" onClick={() => setShowFileUpload(!showFileUpload)}>&#128206;</button>
        <input
          type="text"
          placeholder="Type a message..."
          value={text}
          onChange={e => { setText(e.target.value); handleTyping(); }}
        />
        <button type="submit" className="send-btn" disabled={!text.trim()}>&#10148;</button>
      </form>

      {showFileUpload && (
        <FileUpload
          conversationId={activeConversation.id}
          onClose={() => setShowFileUpload(false)}
        />
      )}
    </div>
  );
}
