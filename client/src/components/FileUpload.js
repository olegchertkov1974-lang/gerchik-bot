import React, { useRef } from 'react';
import api from '../services/api';
import { useChat } from '../context/ChatContext';
import './FileUpload.css';

export default function FileUpload({ conversationId, onClose }) {
  const fileRef = useRef();
  const { sendMessage } = useChat();

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await api.post(`/messages/${conversationId}/file`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      onClose();
    } catch (err) {
      alert('Failed to upload file');
    }
  };

  return (
    <div className="file-upload-overlay" onClick={onClose}>
      <div className="file-upload-panel" onClick={e => e.stopPropagation()}>
        <h3>Send a file</h3>
        <div className="upload-area" onClick={() => fileRef.current.click()}>
          <span className="upload-icon">&#128228;</span>
          <p>Click to select a file</p>
          <p className="upload-hint">Max 10MB. Images, documents, audio, video.</p>
        </div>
        <input ref={fileRef} type="file" hidden onChange={handleUpload} />
        <button className="upload-cancel" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
