import React from 'react';

interface InboxScreenProps {
  onSelectReview: () => void;
}

export const InboxScreen: React.FC<InboxScreenProps> = ({ onSelectReview }) => {
  return (
    <section id="inbox" className="screen active">
      <div className="grid4">
        <div className="stat"><b>7</b><span>needs action</span></div>
        <div className="stat"><b>12</b><span>in production</span></div>
        <div className="stat"><b>5</b><span>awaiting review</span></div>
        <div className="stat"><b>2</b><span>blocked safely</span></div>
      </div>

      <div className="board">
        {/* Lane 1: New messages */}
        <div className="lane">
          <div className="lanehead">
            New messages <span className="pill">4</span>
          </div>
          <div className="task">
            <span className="pill">Telegram</span>
            <h3>Podcast guest card</h3>
            <p>“Use Dr. Lina Rahman and publish tomorrow…”</p>
            <div className="meta">
              <span className="pill warn">client 0.72</span>
              <span className="pill">ckb</span>
            </div>
          </div>
          <div className="task">
            <span className="pill">Hawa Desk</span>
            <h3>Summer offer variants</h3>
            <p>Exact price and three dimensions supplied.</p>
            <div className="meta">
              <span className="pill ok">Aster mapped</span>
              <span className="pill">due today</span>
            </div>
          </div>
        </div>

        {/* Lane 2: Needs input */}
        <div className="lane">
          <div className="lanehead">
            Needs input <span className="pill warn">3</span>
          </div>
          <div className="task">
            <span className="pill bad">routing blocked</span>
            <h3>“Make the same one again”</h3>
            <p>Two clients are allowed; no referenced design.</p>
            <button className="btn">Choose client</button>
          </div>
          <div className="task">
            <span className="pill warn">missing fact</span>
            <h3>Event poster</h3>
            <p>Location and time conflict between message and attachment.</p>
            <button className="btn">Resolve facts</button>
          </div>
        </div>

        {/* Lane 3: In production */}
        <div className="lane">
          <div className="lanehead">
            In production <span className="pill">12</span>
          </div>
          <div className="task">
            <span className="pill blue">asset lab</span>
            <h3>Nova One launch</h3>
            <p>1/3 visual assets complete. Source task is safe.</p>
            <div className="bar"><i style={{ width: '42%' }}></i></div>
          </div>
          <div className="task">
            <span className="pill">QA</span>
            <h3>Health awareness card</h3>
            <p>Checking exact copy, source layers, font and RTL.</p>
          </div>
        </div>

        {/* Lane 4: Review */}
        <div className="lane">
          <div className="lanehead">
            Review <span className="pill ok">5</span>
          </div>
          <div className="task">
            <span className="pill ok">critical QA pass</span>
            <h3>Summer offer · revision 3</h3>
            <p>One visual warning; editable source complete.</p>
            <button className="btn primary" onClick={onSelectReview}>Review</button>
          </div>
          <div className="task">
            <span className="pill warn">language review</span>
            <h3>Recruitment announcement</h3>
            <p>Mixed Sorani + URL + date.</p>
          </div>
        </div>
      </div>
    </section>
  );
};
