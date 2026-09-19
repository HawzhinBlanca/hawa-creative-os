import type { NeutralManifest, StudioOperation } from '@hawa/contracts';

/**
 * The neutral manifest of a generated design, read from the studio operations that build it. QA
 * inspects this manifest, and the revision stores its nodes.
 *
 * /generate used to map operations by a `type` field they do not have ('insert_text'), so every node
 * became an untyped 'element' with no text role, no geometry and no logo hash: nothing QA could check,
 * and an empty exact-copy list on the review desk.
 */
export function manifestFromOperations(
  ops: StudioOperation[],
  pages: NeutralManifest['pages']
): NeutralManifest {
  const nodes: any[] = [];
  const assets: NeutralManifest['assets'] = [];
  const fonts = new Set<string>();
  const defaultPageId = pages[0]?.id || 'v1';

  ops.forEach((op: any, index) => {
    const zIndex = index + 1;
    if (op.op === 'addText') {
      const style = (op.style || {}) as Record<string, any>;
      if (style.fontFamily) fonts.add(String(style.fontFamily));
      nodes.push({
        id: op.nodeId,
        pageId: op.pageId || defaultPageId,
        type: 'text',
        role: op.role,
        text: op.text,
        font: style.fontFamily,
        fontFamily: style.fontFamily,
        color: style.color,
        textStyle: style,
        locked: Boolean(op.locked),
        zIndex,
        box: { x: op.x, y: op.y, width: op.width, height: op.height },
      });
    } else if (op.op === 'addImage') {
      const role = /logo/i.test(op.nodeId) ? 'logo_primary' : 'image';
      assets.push({ sha256: op.asset.sha256, mimeType: op.asset.mimeType, sourceId: role, role } as any);
      nodes.push({
        id: op.nodeId,
        pageId: op.pageId || defaultPageId,
        type: 'image',
        role,
        assetSha256: op.asset.sha256,
        locked: Boolean(op.locked),
        zIndex,
        box: { x: op.x, y: op.y, width: op.width, height: op.height },
      });
    } else if (op.op === 'addVector') {
      const fill = /fill="(#[0-9a-fA-F]{3,8})"/.exec(String(op.source || ''))?.[1];
      const isBackground = /(^|_)bg($|_)|background/i.test(op.nodeId);
      nodes.push({
        id: op.nodeId,
        pageId: op.pageId || defaultPageId,
        type: 'vector',
        role: isBackground ? 'background' : 'vector',
        ...(fill ? { fillColor: fill } : {}),
        locked: Boolean(op.locked),
        zIndex,
        box: { x: op.x, y: op.y, width: op.width, height: op.height },
      });
    }
  });

  return {
    pages,
    nodes,
    fonts: Array.from(fonts).map((family) => ({ family, style: 'Regular' })),
    assets,
    warnings: [],
  };
}
