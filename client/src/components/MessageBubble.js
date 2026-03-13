import React from 'react';
import { format } from 'date-fns';
import './MessageBubble.css';

export default function MessageBubble({ message, isOwn, onReply }) {
  const renderContent = () => {
    if (message.type === 'image') {
      return (
        <div className="message-image">
          <img src={`http://localhost:5000${message.file_url}`} alt={message.file_name} />
          {message.content && <p>{message.content}</p>}
        </div>
      );
    }
    if (message.type === 'file') {
      return (
        <div className="message-file">
          <a href={`http://localhost:5000${message.file_url}`} target="_blank" rel="noopener noreferrer">
            <span className="file-icon">&#128196;</span>
            <span className="file-name">{message.file_name}</span>
          </a>
          {message.content && <p>{message.content}</p>}
        </div>
      );
    }
    return <p className="message-text">{message.content}</p>;
  };

  return (
    <div className={`message-bubble ${isOwn ? 'own' : 'other'}`}>
      {!isOwn && <div className="message-sender">{message.sender_name}</div>}
      {renderContent()}
      <div className="message-footer">
        <span className="message-time">{format(new Date(message.created_at), 'HH:mm')}</span>
        <button className="reply-btn" onClick={onReply} title="Reply">&#8617;</button>
      </div>
    </div>
  );
}
