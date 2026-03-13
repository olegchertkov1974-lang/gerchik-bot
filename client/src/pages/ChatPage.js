import React, { useState } from 'react';
import Sidebar from '../components/Sidebar';
import ChatWindow from '../components/ChatWindow';
import SearchPanel from '../components/SearchPanel';
import Notifications from '../components/Notifications';
import './ChatPage.css';

export default function ChatPage() {
  const [showSearch, setShowSearch] = useState(false);

  return (
    <div className="chat-page">
      <Notifications />
      {showSearch && <SearchPanel onClose={() => setShowSearch(false)} />}
      <Sidebar onSearchClick={() => setShowSearch(true)} />
      <ChatWindow />
    </div>
  );
}
