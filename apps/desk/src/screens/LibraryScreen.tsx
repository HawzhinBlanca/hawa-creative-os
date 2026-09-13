import React from 'react';

/** Canva owns editing and its design library. No local insertion or template emulator. */
export const LibraryScreen: React.FC = () => (
  <section aria-label="Canva design library" className="card" style={{padding:24}}>
    <h2>Design library</h2>
    <p>Open a task to edit its linked design in Canva. Use Canva to manage templates, uploads and design assets.</p>
    <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:20}}>
      <a className="btn primary" href="#/work">Open work queue</a>
      <a className="btn" href="https://www.canva.com/" target="_blank" rel="noopener noreferrer">Open Canva library</a>
    </div>
    <p style={{marginTop:20}}>Hawa keeps the request, client references and retrieved export evidence with the task. Each export still requires review before delivery.</p>
  </section>
);
