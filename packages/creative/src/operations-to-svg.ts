import type { StudioOperation } from '@hawa/contracts';
import { spawnSync } from 'node:child_process';

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sniffImageType } from './studio/image-type.js';

let cachedKaaeLogoDataUri: string | null = null;

/**
 * Returns the data URI for the authentic KAAE official logo (kaae-official-logo.png).
 * Resolves across canonical asset paths and caches the base64 string in memory.
 */
export function getKaaeOfficialLogoDataUri(): string {
  if (cachedKaaeLogoDataUri) return cachedKaaeLogoDataUri;

  const candidatePaths = [
    path.join(process.cwd(), 'packages/creative/assets/logos/kaae-official-logo.png'),
    path.join(process.cwd(), 'apps/desk/public/assets/logos/kaae-official-logo.png'),
    path.join(process.cwd(), 'data/kaae-graphics/references/kaae-logo.png'),
    '/app/packages/creative/assets/logos/kaae-official-logo.png',
    '/app/assets/logos/kaae-official-logo.png',
    '/app/apps/core/assets/logos/kaae-official-logo.png',
    '/Users/hawzhin/Hawdesign/packages/creative/assets/logos/kaae-official-logo.png',
    '/Users/hawzhin/Hawdesign/apps/desk/public/assets/logos/kaae-official-logo.png',
    '/Users/hawzhin/Hawdesign/data/kaae-graphics/references/kaae-logo.png',
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const bytes = fs.readFileSync(p);
        // Typed from its bytes, not its .png name (ADR-036): a logo replaced by a JPEG keeps the name.
        const type = sniffImageType(bytes);
        if (bytes.length > 750 && type) {
          cachedKaaeLogoDataUri = `data:${type};base64,${bytes.toString('base64')}`;
          return cachedKaaeLogoDataUri;
        }
      }
    } catch {}
  }
  return '';
}

/** Accepts any value: style fields such as fontWeight arrive as numbers, and a throw here abandons the whole preview. */
export function escapeXml(unsafe: unknown): string {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function wrapTextToLines(text: string, maxCharsPerLine = 48): string[] {
  const result: string[] = [];
  const paragraphs = text.split('\n');
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      result.push('');
      continue;
    }
    const words = trimmed.split(/\s+/).filter(Boolean);
    let currentLine = words[0] || '';
    for (let i = 1; i < words.length; i++) {
      if ((currentLine + ' ' + words[i]).length <= maxCharsPerLine) {
        currentLine += ' ' + words[i];
      } else {
        result.push(currentLine);
        currentLine = words[i];
      }
    }
    if (currentLine) {
      result.push(currentLine);
    }
  }
  return result;
}

/**
 * Converts a sequence of StudioOperations into a self-contained, valid SVG document.
 */
export function renderOperationsToSvg(
  operations: StudioOperation[],
  width = 1080,
  height = 1350
): string {
  const bodyParts: string[] = [];
  const defsParts: string[] = [];

  for (const op of operations) {
    if (op.op === 'addVector') {
      const source = op.source || '';
      // Extract <defs> if present
      const defsMatch = source.match(/<defs>([\s\S]*?)<\/defs>/i);
      if (defsMatch) {
        defsParts.push(defsMatch[1]);
      }
      // Extract inner content inside <svg ...> ... </svg>
      const svgMatch = source.match(/<svg[^>]*>([\s\S]*?)<\/svg>/i);
      const inner = svgMatch ? svgMatch[1].replace(/<defs>[\s\S]*?<\/defs>/gi, '').trim() : source;
      bodyParts.push(
        `<g id="${escapeXml(op.nodeId || 'vec')}" transform="translate(${op.x || 0}, ${op.y || 0})">${inner}</g>`
      );
    } else if (op.op === 'addImage') {
      const sha = op.asset.sha256.replace(/^sha256_/, '');
      if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error(`Unverified asset hash: ${op.nodeId}`);
      const roots = [
        fileURLToPath(new URL('../assets/logos/', import.meta.url)),
        path.resolve(process.cwd(), 'packages/creative/assets/logos'),
      ];
      // Resolve only local approved bytes by hash. Names/client labels cannot authorize assets.
      let bytes: Buffer | undefined;
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
          const candidate = path.join(root, name);
          if (!fs.statSync(candidate).isFile()) continue;
          const content = fs.readFileSync(candidate);
          if (createHash('sha256').update(content).digest('hex') === sha) { bytes = content; break; }
        }
        if (bytes) break;
      }
      if (!bytes) throw new Error(`Approved asset bytes unavailable: ${op.nodeId}`);
      if (op.asset.mimeType !== 'image/png' || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        throw new Error(`Unsupported or mismatched image format: ${op.nodeId}`);
      }
      const dataUri = `data:image/png;base64,${bytes.toString('base64')}`;
      bodyParts.push(`<image id="${escapeXml(op.nodeId)}" x="${op.x}" y="${op.y}" width="${op.width}" height="${op.height}" xlink:href="${dataUri}" data-asset-sha="${sha}" preserveAspectRatio="xMidYMid meet"/>`);
    } else if (op.op === 'addText') {
      const x = op.x || 0;
      const y = op.y || 0;
      const w = op.width || width - 120;
      const style = (op.style || {}) as Record<string, any>;
      const fontSize = Number(style.fontSize) || 20;
      const fontWeight = style.fontWeight || 'normal';
      const color = style.color || '#FFFFFF';
      const textAlign = style.textAlign || 'left';
      const fontFamily = (style.fontFamily || 'Inter, sans-serif').replace(/"/g, "'");
      const lineHeightMultiplier = Number(style.lineHeight) || 1.45;
      const lineHeight = fontSize * lineHeightMultiplier;

      let textX = x;
      let anchor = 'start';
      if (textAlign === 'center') {
        textX = x + w / 2;
        anchor = 'middle';
      } else if (textAlign === 'right') {
        textX = x + w;
        anchor = 'end';
      }

      // Compute character width threshold and split lines
      let textToWrap = op.text || '';
      const charWidthEst = fontSize * 0.58;
      const maxChars = Math.max(16, Math.floor(w / charWidthEst));
      const lines = wrapTextToLines(textToWrap, maxChars);
      if (fontSize + (lines.length - 1) * lineHeight > op.height + 0.1) {
        throw new Error(`Text overflow: ${op.nodeId} requires more than ${op.height}px`);
      }

      // A blank line is 0.8 of a line of extra space before the next line, carried on that line's dy.
      // It used to be a tspan holding a single space: whitespace-only character data, which each
      // renderer collapses, keeps or positions by its own rules (ADR-036).
      let textContent = '';
      let pendingDy = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line && i > 0) {
          pendingDy += lineHeight * 0.8;
          continue;
        }
        textContent += `<tspan x="${textX}" dy="${(i === 0 ? 0 : lineHeight) + pendingDy}">${escapeXml(line)}</tspan>`;
        pendingDy = 0;
      }

      const fontStyleAttr = style.fontStyle ? ` font-style="${style.fontStyle}"` : '';
      bodyParts.push(
        `<text id="${escapeXml(op.nodeId || 'txt')}" x="${textX}" y="${y + fontSize}" fill="${escapeXml(color)}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}px" font-weight="${escapeXml(fontWeight)}"${fontStyleAttr} text-anchor="${anchor}" letter-spacing="${escapeXml(style.letterSpacing || '0px')}">${textContent}</text>`
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    ${defsParts.join('\n')}
  </defs>
  ${bodyParts.join('\n')}
</svg>`.trim();
}

/** Local previews use one renderer; missing assets/fonts/rendering never become success. */
function renderPreview(operations: StudioOperation[], width: number, height: number, format: 'png' | 'pdf'): Buffer {
  const config = fileURLToPath(new URL('../assets/fonts/fonts.conf', import.meta.url));
  if (!fs.existsSync(config)) throw new Error('Pinned preview font configuration is missing');
  const svg = renderOperationsToSvg(operations, width, height);
  const temp = fs.mkdtempSync(path.join(tmpdir(), 'hawa-preview-'));
  try {
    const source = path.join(temp, 'source.svg');
    fs.writeFileSync(source, svg, { mode: 0o600 });
    // Use a private, complete SVG file as the renderer input.
    // Remove temporary source material on every success or failure path.
    const result = spawnSync('rsvg-convert', ['-w', String(width), '-h', String(height), '-f', format, source], {
      env: { ...process.env, FONTCONFIG_FILE: config },
      maxBuffer: 32 * 1024 * 1024, timeout: 15000,
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length < 100) {
      throw new Error(`Preview ${format} rendering failed; no artifact was produced`);
    }
    return result.stdout;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export function renderOperationsToPng(operations: StudioOperation[], width = 1080, height = 1350): Buffer {
  return renderPreview(operations, width, height, 'png');
}

/** Digital RGB preview only. This is not native Canva capture or CMYK print output. */
export function renderOperationsToPdf(operations: StudioOperation[], width = 1080, height = 1350): Buffer {
  return renderPreview(operations, width, height, 'pdf');
}
