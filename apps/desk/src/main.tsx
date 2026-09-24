import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { DeskProviders, createDeskRuntime } from './DeskProviders.js';
import { eventStream } from './services/eventStream.js';
import { registerServiceWorker } from './services/serviceWorker.js';
import './index.css';

// One query cache, one session and one event stream for the tab (ADR-037).
const runtime = createDeskRuntime({ stream: eventStream, doc: document });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DeskProviders runtime={runtime}>
      <App />
    </DeskProviders>
  </React.StrictMode>
);

// Register production offline Service Worker
registerServiceWorker();
