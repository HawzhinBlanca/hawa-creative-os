/**
 * ADR-256: a small Canva-like export made in-test: a one-page PPTX (a plain title frame and a Sorani
 * line inside a Canva-style scaled group) and the PNG captured from it (glyph-like bars in each frame's
 * text colour). Core has no archive or image dependency, so both are written by hand.
 */
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/** A stored (uncompressed) ZIP, as canva-export-qc.test.ts writes it. */
export function zipSync(files: Record<string, Uint8Array>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name, 'utf8');
    const d = Buffer.from(data);
    const crc = crc32(d);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(d.length, 18);
    local.writeUInt32LE(d.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, d);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(d.length, 20);
    cen.writeUInt32LE(d.length, 24);
    cen.writeUInt16LE(n.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
export const u8 = (text: string) => new Uint8Array(Buffer.from(text, 'utf8'));
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** An RGBA PNG written by hand (Core has no image dependency): a fill, then rectangles. */
export function png(width: number, height: number, background: string, rects: Array<{ x: number; y: number; w: number; h: number; color: string }> = []): Buffer {
  const rgb = (hex: string) => [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16));
  const pixels = Buffer.alloc(width * height * 4);
  const paint = (x0: number, y0: number, w: number, h: number, hex: string) => {
    const [r, g, b] = rgb(hex);
    for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(width, x0 + w); x++) pixels.set([r, g, b, 255], (y * width + x) * 4);
    }
  };
  paint(0, 0, width, height, background);
  for (const r of rects) paint(r.x, r.y, r.w, r.h, r.color);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const COPY = ['KAAE Summit', 'کۆنفرانسی نیشتمانی'];
export const SENT = { fontsByIndex: ['Cinzel', 'Amiri'] };
// A 1080 x 1350 slide (9525 EMU a pixel), captured here as a 108 x 135 PNG: one PNG pixel is 95250 EMU.
export const PX = 95250;
export const SLIDE = { cx: 1080 * 9525, cy: 1350 * 9525 };

export interface Frame { x: number; y: number; w: number; h: number; color?: string; scheme?: string; sz?: number }

/**
 * The title as a plain frame, the Sorani line inside a Canva-style group whose child space is scaled
 * by 3/4 (chExt 4/3 of ext), as Canva exports text. Frame positions are in PNG pixels.
 */
export function pptx(title: Frame, sorani: Frame | null = { x: 20, y: 80, w: 68, h: 12, color: '14253D' }, copy: string[] = COPY) {
  const fill = (f: Frame) => f.scheme ? `<a:solidFill><a:schemeClr val="${f.scheme}"/></a:solidFill>`
    : f.color ? `<a:solidFill><a:srgbClr val="${f.color}"/></a:solidFill>` : '';
  const offExt = (f: Frame) => `<a:off x="${f.x * PX}" y="${f.y * PX}"/><a:ext cx="${f.w * PX}" cy="${f.h * PX}"/>`;
  const at = (f: Frame) => `<a:xfrm>${offExt(f)}</a:xfrm>`;
  const k = 4 / 3;
  return zipSync({
    'ppt/presentation.xml': u8(`<p:presentation><p:sldSz cx="${SLIDE.cx}" cy="${SLIDE.cy}"/></p:presentation>`),
    'ppt/slides/slide1.xml': u8(
      '<p:sld><p:cSld><p:spTree>' +
        `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr><p:spPr>${at(title)}</p:spPr><p:txBody><a:p><a:r><a:rPr sz="${title.sz ?? 4800}">${fill(title)}<a:latin typeface="Cinzel"/></a:rPr><a:t>${copy[0]}</a:t></a:r></a:p></p:txBody></p:sp>` +
        (!sorani ? '' : `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="3" name="Group"/></p:nvGrpSpPr><p:grpSpPr><a:xfrm>${offExt(sorani)}<a:chOff x="0" y="0"/><a:chExt cx="${Math.round(sorani.w * PX * k)}" cy="${Math.round(sorani.h * PX * k)}"/></a:xfrm></p:grpSpPr>` +
          `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Sorani"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(sorani.w * PX * k)}" cy="${Math.round(sorani.h * PX * k)}"/></a:xfrm></p:spPr><p:txBody><a:p><a:pPr rtl="1"/><a:r><a:rPr sz="${sorani.sz ?? 2400}">${fill(sorani)}<a:cs typeface="Amiri"/></a:rPr><a:t>${copy[1]}</a:t></a:r></a:p></p:txBody></p:sp>` +
        '</p:grpSp>') +
      '</p:spTree></p:cSld></p:sld>'),
  });
}

/** Glyph-like bars inside each frame, in its text colour, on a white page. */
export function capture(frames: Array<Frame & { ink: string }>, background = '#FFFFFF') {
  return png(108, 135, background, frames.flatMap((f) => [
    { x: f.x + 2, y: f.y + 2, w: Math.max(1, Math.floor(f.w / 3)), h: 2, color: f.ink },
    { x: f.x + 2, y: f.y + 6, w: Math.max(1, Math.floor(f.w / 4)), h: 2, color: f.ink },
  ]));
}

