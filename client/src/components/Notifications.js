import React, { useEffect } from 'react';
import { useChat } from '../context/ChatContext';
import './Notifications.css';

export default function Notifications() {
  const { notifications, dismissNotification } = useChat();

  useEffect(() => {
    if (notifications.length > 0) {
      const timer = setTimeout(() => {
        dismissNotification(notifications[0].id);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [notifications, dismissNotification]);

  if (notifications.length === 0) return null;

  return (
    <div className="notifications-container">
      {notifications.slice(0, 3).map(n => (
        <div key={n.id} className="notification" onClick={() => dismissNotification(n.id)}>
          <div className="notification-sender">{n.sender}</div>
          <div className="notification-content">{n.content}</div>
        </div>
      ))}
    </div>
  );
}
