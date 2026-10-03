import React, { useState, useEffect } from 'react';
import { useAuthorizedImage } from '../services/authorizedImage.js';

export interface VectorInspectorProps {
  svgContent?: string;
  previewUrl?: string;
  title?: string;
  clientName?: string;
  dimensions?: { width: number; height: number };
  exactCopy?: {
    headlineEn?: string;
    headlineCkb?: string;
    copyEn?: string;
    copyCkb?: string;
  };
  sha256?: string;
  status?: string;
}

// Read-only evidence preview. Native editing and export belong to Canva.
export const VectorInspector: React.FC<VectorInspectorProps> = ({ svgContent, previewUrl, title = 'Captured design', dimensions }) => {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // The sanitizer (DOMPurify) is loaded only for a design that carries SVG markup, which few do: it
  // stays out of the Desk's entry chunk. Nothing unsanitized is ever shown while it loads.
  const [sanitized, setSanitized] = useState<{ raw: string; svg: string } | null>(null);
  useEffect(() => {
    if (!svgContent) return;
    let live = true;
    void import('../services/sanitizer.js').then(({ sanitizeSvgContent }) => {
      if (live) setSanitized({ raw: svgContent, svg: sanitizeSvgContent(svgContent) });
    });
    return () => { live = false; };
  }, [svgContent]);
  const sanitizedSvg = svgContent && sanitized?.raw === svgContent ? sanitized.svg : '';
  // The preview is a signed-in Core address (/v1/tasks/:id/exports/:exportId/content), fetched with
  // the session's header (ADR-035); an <img src> alone sends none.
  const image = useAuthorizedImage(previewUrl);
  const hasImage = Boolean(image.src && failedUrl !== previewUrl);
  const loading = Boolean(previewUrl && !image.src && !image.failed);
  return (
    <div className="captured-preview" style={{ padding: 24, minHeight: 240, display: 'grid', placeItems: 'center', background: '#0b0f19', color: '#e2e8f0', borderRadius: 12 }}>
      {sanitizedSvg ? (
        <div aria-label={title} style={{ width: '100%', maxWidth: 640 }} dangerouslySetInnerHTML={{ __html: sanitizedSvg }} />
      ) : hasImage ? (
        <img src={image.src} alt={title} style={{ maxWidth: '100%', maxHeight: 720, objectFit: 'contain' }} onError={() => setFailedUrl(previewUrl!)} />
      ) : loading ? (
        <div role="status">Loading preview…</div>
      ) : (
        <div role="status" style={{ textAlign: 'center', maxWidth: 420 }}>
          <h3>{previewUrl ? 'Preview could not be loaded' : 'No captured design yet'}</h3>
          <p>A task brief or Canva link is not a captured design. A verified native export is required before review.</p>
        </div>
      )}
      {dimensions && <small>{dimensions.width} × {dimensions.height} px · recorded dimensions</small>}
    </div>
  );
};
