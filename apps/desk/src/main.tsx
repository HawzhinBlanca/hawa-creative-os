import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './services/serviceWorker.js';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register production offline Service Worker
registerServiceWorker();
