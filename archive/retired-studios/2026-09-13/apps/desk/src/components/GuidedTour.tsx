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
  {
    title: 'Welcome to Hawa Creative OS',
    badge: 'Overview',
    icon: '🏛️',
    description: 'A private, dependable creative production operating system built for high-stakes graphic design in Erbil without SaaS lock-in.',
    bullets: [
      'Engineered for agency operators, art directors, and client stakeholders.',
      'Operates 100% offline or cloud-connected with strict multi-tenant isolation.',
      'Native Kurdish Sorani (ckb, RTL) and English bilingual typography.',
    ],
  },
  {
    title: 'Canonical Office Inbox & Chat Ingress',
    badge: 'Invariant #1',
    targetScreen: 'inbox',
    icon: '📥',
    invariantNumber: 1,
    invariantText: 'The office inbox is canonical. Chat products are adapters, never the database or state machine.',
    description: 'All tasks from WhatsApp (WAHA), Telegram bots, and mobile staff arrive in one durable state machine.',
    bullets: [
      'Ingress webhook idempotency prevents duplicate task processing.',
      'Durable Restate 1.7 workflows handle pauses, retries, and manual operator overrides.',
      'Real-time SSE event streaming keeps all operator screens in sync.',
    ],
  },
  {
    title: 'Client Scope Lock & Brand DNA Governance',
    badge: 'Invariant #5',
    targetScreen: 'dna',
    icon: '🧬',
    invariantNumber: 5,
    invariantText: 'Client scope is fixed before retrieval. Cross-client search followed by model filtering is prohibited.',
    description: 'Client DNA defines immutable brand palettes, typography scales, prohibited lexicons, and Drive destinations.',
    bullets: [
      'Pre-retrieval scope locking guarantees zero cross-tenant contamination.',
      'Auto-extract brand palettes from client logos with live WCAG AAA contrast scoring.',
      'Cryptographic point-in-time snapshots with SHA-256 integrity audits.',
    ],
  },
  {
    title: 'Canva Native Studio & Lossless Editable Vector Nodes',
    badge: 'Invariant #2',
    targetScreen: 'review',
    icon: '🎨',
    invariantNumber: 2,
    invariantText: 'Every final design remains editable. Exact copy, logos, shapes, and layout are structured nodes—not flattened AI pixels.',
    description: 'A professional design canvas supporting 1:1 Feed, 9:16 Story, 4:5 Meta, and 16:9 Display artboards.',
    bullets: [
      'Full layer manipulation: drag, rotate, z-index stack, group/ungroup, and color tokens.',
      'Kurdish typography engine guarantees zero ascender/descender clipping on ڵ, ۆ, ێ, ڕ.',
      'Native studio shortcuts: Space+Drag pan, Cmd +/- zoom, Cmd+Z tree history.',
    ],
  },
  {
    title: 'Hard Deterministic QA & One-Click Master Delivery',
    badge: 'Invariant #4 & #7',
    targetScreen: 'review',
    icon: '🎁',
    invariantNumber: 7,
    invariantText: 'Hard rules outrank model judgment. The visual judge is advisory and cannot override exact-copy or RTL failures.',
    description: 'Instant verification against social safe-zones and one-click packaging for immediate client delivery.',
    bullets: [
      'Social Native UI safe-zone collision engine flags Story/Reels icon rail overlaps.',
      'One-Click Master Delivery Pack (.zip) bundles 2x Retina PNGs, SVGs, .hyc, and signed audit report.',
      'Idempotent delivery mirror to isolated Google Shared Drive targets and Sheets ledger.',
    ],
  },
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
