import React, { useState } from 'react';

interface GuidedTourProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateScreen?: (screen: string) => void;
}

interface TourStep {
  title: string;
  badge: string;
  targetScreen?: string;
  icon: string;
  description: string;
  invariantNumber?: number;
  invariantText?: string;
  bullets: string[];
}

export const TOUR_STEPS: TourStep[] = [
  { title:'Your work queue', badge:'Requests', icon:'📥', targetScreen:'work',
    description:'Send requests through your authorized Telegram account or create a task here.',
    bullets:['Hawa stores the original request with the task.','Check the task for its current design and retrieved files.'] },
  { title:'Client references', badge:'Brand', icon:'🧬', targetScreen:'clients',
    description:'Keep each client’s references separate and review the exact copy before designing.',
    bullets:['The selected client determines which references can be used.','Missing or conflicting brand rules need review.'] },
  { title:'Edit in Canva', badge:'Design', icon:'🎨', targetScreen:'review',
    description:'Canva is the only design editor. Open the linked task design to change text, images and layout.',
    bullets:['Manual edits happen in Canva.','Retrieve a fresh preview after edits; old captures may be stale.'] },
  { title:'Review the actual files', badge:'Review', icon:'📋', targetScreen:'review',
    description:'Inspect the retrieved output and the checks shown on the task.',
    bullets:['A successful export is not approval or delivery.','Unverified files stay pending review.'] },
];

export const GuidedTour: React.FC<GuidedTourProps> = ({ isOpen, onClose, onNavigateScreen }) => {
  const [currentStep, setCurrentStep] = useState(0);

  if (!isOpen) return null;

  const step = TOUR_STEPS[currentStep];
  const isFirst = currentStep === 0;
  const isLast = currentStep === TOUR_STEPS.length - 1;

  const handleNext = () => {
    if (isLast) {
      handleFinish();
    } else {
      const next = currentStep + 1;
      setCurrentStep(next);
      if (TOUR_STEPS[next].targetScreen && onNavigateScreen) {
        onNavigateScreen(TOUR_STEPS[next].targetScreen!);
      }
    }
  };

  const handlePrev = () => {
    if (!isFirst) {
      const prev = currentStep - 1;
      setCurrentStep(prev);
      if (TOUR_STEPS[prev].targetScreen && onNavigateScreen) {
        onNavigateScreen(TOUR_STEPS[prev].targetScreen!);
      }
    }
  };

  const handleFinish = () => {
    try {
      localStorage.setItem('hawa_tour_completed', 'true');
    } catch (e) {
      // Ignore
    }
    onClose();
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        padding: 20,
      }}
    >
      <div
        className="panel"
        style={{
          width: 580,
          background: 'var(--panel)',
          borderRadius: 16,
          boxShadow: '0 25px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px var(--line)',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header with step progress indicator */}
        <div
          style={{
            padding: '20px 24px 14px',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 24 }}>{step.icon}</span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#10B981' }}>
                  {step.badge}
                </span>
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Step {currentStep + 1} of {TOUR_STEPS.length}
                </span>
              </div>
              <h3 style={{ margin: '2px 0 0', fontSize: 16, fontWeight: 700 }}>
                {step.title}
              </h3>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close the tour"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--muted)',
              fontSize: 18,
              cursor: 'pointer',
              padding: 4,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body content */}
        <div style={{ padding: '20px 24px', flex: 1 }}>
          <p style={{ fontSize: 13, color: 'var(--fg)', lineHeight: 1.5, margin: '0 0 14px' }}>
            {step.description}
          </p>

          {step.invariantText && (
            <div
              style={{
                background: 'rgba(16, 185, 129, 0.08)',
                border: '1px solid rgba(16, 185, 129, 0.25)',
                borderRadius: 8,
                padding: '10px 14px',
                marginBottom: 14,
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              <b style={{ color: '#10B981' }}>Master Spec Invariant #{step.invariantNumber}:</b>
              <div style={{ color: 'var(--muted)', marginTop: 2 }}>{step.invariantText}</div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {step.bullets.map((bullet, idx) => (
              <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                <span style={{ color: '#10B981', fontWeight: 'bold' }}>✓</span>
                <span style={{ color: 'var(--muted)' }}>{bullet}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer with actions and pagination dots */}
        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--line)',
            background: 'var(--soft)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          {/* Step dots */}
          <div style={{ display: 'flex', gap: 6 }}>
            {TOUR_STEPS.map((_, idx) => (
              <div
                key={idx}
                onClick={() => {
                  setCurrentStep(idx);
                  if (TOUR_STEPS[idx].targetScreen && onNavigateScreen) {
                    onNavigateScreen(TOUR_STEPS[idx].targetScreen!);
                  }
                }}
                style={{
                  width: idx === currentStep ? 20 : 6,
                  height: 6,
                  borderRadius: 3,
                  background: idx === currentStep ? '#10B981' : 'var(--line)',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                }}
              />
            ))}
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            {!isFirst && (
              <button className="btn" onClick={handlePrev} style={{ fontSize: 12 }}>
                Back
              </button>
            )}
            <button
              className="btn primary"
              onClick={handleNext}
              style={{ fontSize: 12, fontWeight: 700, background: '#10B981', color: '#fff' }}
            >
              {isLast ? 'Complete Tour 🚀' : 'Next Step →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
