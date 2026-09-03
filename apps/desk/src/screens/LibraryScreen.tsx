import React from 'react';

export const LibraryScreen: React.FC = () => {
  return (
    <section id="library" className="screen active">
      <div className="toolbar">
        <button className="btn primary">+ Import approved work</button>
        <button className="btn">Templates</button>
        <button className="btn">Assets</button>
        <button className="btn">Negative examples</button>
      </div>

      <div className="grid4">
        <div className="stat"><b>318</b><span>approved designs</span></div>
        <div className="stat"><b>46</b><span>editable templates</span></div>
        <div className="stat"><b>1,204</b><span>verified assets</span></div>
        <div className="stat"><b>67</b><span>negative examples</span></div>
      </div>

      <div className="board" style={{ gridTemplateColumns: 'repeat(3, minmax(260px, 1fr))', minHeight: 0 }}>
        {/* Card 1 */}
        <div className="card" style={{ padding: 14 }}>
          <div className="canvaswrap" style={{ minHeight: 240 }}>
            <div className="canvas" style={{ width: '55%' }}>
              <div className="t1" dir="rtl" lang="ckb" style={{ fontSize: 24 }}>میوانی نوێ</div>
              <div className="shape"></div>
            </div>
          </div>
          <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Podcast guest · approved</h3>
          <div className="meta">
            <span className="pill ok">editable .hyc</span>
            <span className="pill">Aster</span>
            <span className="pill">ckb</span>
          </div>
        </div>

        {/* Card 2 */}
        <div className="card" style={{ padding: 14 }}>
          <div className="canvaswrap" style={{ minHeight: 240 }}>
            <div className="canvas" style={{ width: '55%', background: 'linear-gradient(135deg, #f4ecdd, #e9b666)' }}>
              <div className="copy" style={{ color: '#17191c', fontSize: 16 }}>SUMMER OFFER</div>
            </div>
          </div>
          <h3 style={{ margin: '10px 0 4px', fontSize: 14 }}>Retail offer family</h3>
          <div className="meta">
            <span className="pill ok">template v7</span>
            <span className="pill">3 formats</span>
          </div>
        </div>

        {/* Card 3: Retrieval Evidence */}
        <div className="card" style={{ padding: 14 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>Retrieval evidence</h3>
          <div className="rule">
            <b>Why this appears</b>
            <p>Same client (Aster), campaign type (retail_offer), language (ckb), and active template family. Approved after one revision.</p>
          </div>
          <div className="rule">
            <b>Source integrity</b>
            <p>Design hash, manifest, Drive ID and Client DNA version are available and locked.</p>
          </div>
          <button className="btn" style={{ marginTop: 10 }}>Open semantic source</button>
        </div>
      </div>
    </section>
  );
};
