import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { encodeEditableTransfer } from '@hawa/creative';
import { createDb, sql, withRlsContext } from '@hawa/db';
import { CanvaConnectService } from '../src/services/canva-connect-service.js';
import { nativeRevisionHandoff, confirmNativeRevisionCopy } from '../src/services/native-revision-handoff.js';
import { computeDnaHash } from '../src/core-helpers.js';

/**
 * Hunt 3 (2026-10-03): the PDF capture of a natively revised design is read against the copy the office
 * confirmed for that revision (the frozen checking policy, ADR-126/ADR-276), not the copy of the source it
 * was first imported from; and a capitals block of that source keeps its capitals allowance only where the
 * confirmed copy left it unchanged, as the PPTX capture does.
 */
function pdfOf(lines: string[]): Buffer {
  const chars = [...new Set(lines.flatMap((l) => Array.from(l)))];
  const code = new Map(chars.map((c, i) => [c, i + 3]));
  const hex4 = (n: number) => n.toString(16).padStart(4, '0').toUpperCase();
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n${chars.length} beginbfchar\n${chars.map((c) =>
    `<${hex4(code.get(c)!)}> <${Buffer.from(c, 'utf16le').swap16().toString('hex').toUpperCase()}>`).join('\n')}\nendbfchar\nendcmap end end`;
  const content = lines.map((l, i) => `BT\n/F21 40 Tf\n1 0 0 -1 0 ${100 + i * 60} Tm\n<${Array.from(l).map((c) => hex4(code.get(c)!)).join('')}> Tj\nET`).join('\n');
  const stream = (data: Buffer) => `<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString('latin1')}\nendstream`;
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [10 0 R] /Count 1 >>';
  objs[3] = stream(deflateSync(Buffer.from(content, 'latin1')));
  objs[4] = '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Verdana /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>';
  objs[5] = '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Verdana /FontDescriptor 7 0 R >>';
  objs[6] = stream(deflateSync(Buffer.from(cmap, 'latin1')));
  objs[7] = '<< /Type /FontDescriptor /FontName /ABCDEF+Verdana /FontFile2 8 0 R >>';
  objs[8] = stream(deflateSync(Buffer.from('font program')));
  objs[10] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 480 480] /Resources << /Font << /F21 4 0 R >> >> /Contents 3 0 R >>';
  const body = objs.map((o, n) => (o === undefined ? '' : `${n} 0 obj\n${o}\nendobj\n`)).join('');
  return Buffer.from(`%PDF-1.4\n${body}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R >>\nstartxref\n9\n%%EOF\n`, 'latin1');
}

const url = process.env.HAWA_ISOLATED_TEST_DB;
describe.skipIf(!url)('PDF capture of a natively revised design (synthetic Canva transport)', () => {
  const db = createDb(url || 'postgres://localhost/hawa_repair');
  const tenantId = '00000000-0000-4000-a000-000000000001', actorId = '00000000-0000-4000-b000-000000000001';
  const scope = { tenantId, actorId, role: 'operator' };
  let clientId: string, taskId: string, parentTaskId: string, designId: string, canva: CanvaConnectService;
  let pdf: Buffer;
  const tx = <T>(fn: Parameters<typeof withRlsContext<T>>[2]) => withRlsContext(db, { tenantId, userId: actorId, role: 'operator' }, fn);
  const remote = vi.fn<typeof fetch>(async (input, init) => {
    const u = String(input);
    if (u.endsWith('/oauth/token')) return Response.json({ access_token: randomUUID(), refresh_token: randomUUID(), expires_in: 3600 });
    if (u.includes('/designs/')) return Response.json({ design: { id: designId, created_at: 100, updated_at: 200, page_count: 1,
      urls: { edit_url: `https://www.canva.com/design/${designId}/edit`, view_url: `https://www.canva.com/design/${designId}/view` } } });
    if (u.endsWith('/exports') && init?.method === 'POST') return Response.json({ job: { id: randomUUID(), status: 'in_progress' } });
    if (u.includes('/exports/')) return Response.json({ job: { id: u.split('/').at(-1), status: 'success', urls: [`https://export-download.canva.com/${u.split('/').at(-1)}`] } });
    if (u.startsWith('https://export-download.canva.com/')) return new Response(new Uint8Array(pdf));
    throw new Error(`Unexpected transport: ${new URL(u).pathname}`);
  });
  const options = { clientId: 'synthetic', clientSecret: 'synthetic', encryptionKey: 'a1'.repeat(32),
    redirectUri: 'http://localhost:8772/v1/integrations/canva/callback', fetcher: remote };
  async function bind(id: string, nativeId: string) {
    await sql`INSERT INTO hawa.canva_bindings(id,tenant_id,task_id,client_id,canva_design_id,edit_url,status,version)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${id}::uuid,${clientId}::uuid,${nativeId},${`https://www.canva.com/design/${nativeId}/edit`},'bound',1)`.execute(db);
  }
  beforeEach(async () => {
    clientId = randomUUID(); taskId = randomUUID(); parentTaskId = randomUUID(); designId = `pdf_${randomUUID()}`;
    await sql`INSERT INTO hawa.clients(id,tenant_id,code,name) VALUES(${clientId}::uuid,${tenantId}::uuid,${clientId},'PDF revision fixture')`.execute(db);
    for (const id of [parentTaskId, taskId]) {
      await sql`INSERT INTO hawa.tasks(id,tenant_id,client_id,title,description,state,version)
        VALUES(${id}::uuid,${tenantId}::uuid,${clientId}::uuid,'PDF revision fixture','','failed_operator',1)`.execute(db);
      const data = { studioOptions: id === taskId ? { parentTaskId, revisionDirective: 'Change the date only.' } : {}, exactCopy: [{ text: 'Original exact date 2025' }] };
      await sql`INSERT INTO hawa.task_events(tenant_id,task_id,event_type,aggregate_version,actor_type,actor_id,correlation_id,data)
        VALUES(${tenantId}::uuid,${id}::uuid,'task.created',1,'user',${actorId},${randomUUID()}::uuid,${JSON.stringify(data)}::jsonb)`.execute(db);
    }
    await bind(parentTaskId, `parent_${randomUUID()}`);
    const dna = { tenantId, clientId, version: 1, status: 'active', fonts: [{ family: 'Verdana', license: 'test fixture', supportedLocales: ['en'] }] };
    await sql`INSERT INTO hawa.client_dna_versions(tenant_id,client_id,version,status,dna,content_hash,created_by)
      VALUES(${tenantId}::uuid,${clientId}::uuid,1,'active',${JSON.stringify(dna)}::jsonb,${computeDnaHash(dna)},${actorId}::uuid)`.execute(db);
    canva = new CanvaConnectService(db, options);
    const auth = await canva.startAuthorization(scope); await canva.finishAuthorization(auth.state, auth.state, 'test-code'); remote.mockClear();
  });
  afterAll(() => db.destroy());

  /** The revised design is bound, its copy confirmed, and the source it was imported from is on record. */
  async function revised(confirmed: string, sourceCopy: string, capitals: boolean) {
    await bind(taskId, designId);
    const h = await tx(trx => nativeRevisionHandoff(trx, tenantId, taskId));
    if (!h?.available) throw new Error('Expected scoped handoff');
    await tx(trx => confirmNativeRevisionCopy(trx, scope, taskId, randomUUID(), { expectedTaskVersion: h.taskVersion, basisSha256: h.basisSha256,
      copy: [confirmed], reviewedCurrentDesign: true, preservedUnrequestedChanges: true }));
    const plan = { width: 640, height: 640, background: '#FFFFFF', shapes: [], text: [{ copyIndex: 0, x: 20, y: 20, width: 600, height: 100,
      fontSize: 24, fontFamily: 'Verdana', color: '#000000', align: 'left' as const, rtl: false, ...(capitals ? { textTransform: 'uppercase' as const } : {}) }] };
    const source = Buffer.from((await encodeEditableTransfer(plan, [sourceCopy])).bytes);
    const operationId = randomUUID();
    await sql`INSERT INTO hawa.canva_remote_operations(id,tenant_id,task_id,client_id,actor_id,request_key,request_hash,kind,status,design_id,binding_version)
      VALUES(${operationId}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${randomUUID()},'pdf-source','create','retrieved',${designId},1)`.execute(db);
    await sql`INSERT INTO hawa.canva_editable_sources(id,tenant_id,task_id,client_id,actor_id,operation_id,sha256,content,manifest)
      VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${taskId}::uuid,${clientId}::uuid,${actorId},${operationId}::uuid,
        ${createHash('sha256').update(source).digest('hex')},${source},${JSON.stringify({ copy: [sourceCopy], plan })}::jsonb)`.execute(db);
  }
  async function capturePdf() {
    const admitted = await canva.startExport(scope, taskId, randomUUID(), 'pdf', 1);
    const checked = await new CanvaConnectService(db, options).exportStatus(scope, taskId, admitted.operationId);
    return checked.artifact.content_check as { copyPass: boolean | null; expectedCopy: string[]; copy: { missing: string[] } };
  }

  it('reads the PDF against the confirmed revised copy, not the imported source copy', async () => {
    await revised('New exact date 2026', 'Original exact date 2025', false);
    pdf = pdfOf(['New exact date 2026']);
    const check = await capturePdf();
    expect(check.expectedCopy).toEqual(['New exact date 2026']);
    expect(check.copyPass).toBe(true);
  });

  it('fails a PDF that still shows the imported copy the office replaced', async () => {
    await revised('New exact date 2026', 'Original exact date 2025', false);
    pdf = pdfOf(['Original exact date 2025']);
    const check = await capturePdf();
    expect(check.copyPass).toBe(false);
    expect(check.copy.missing).toEqual(['New exact date 2026']);
  });

  it('keeps an unchanged capitals block case-folded, and only that one', async () => {
    await revised('New exact date 2026', 'New exact date 2026', true);
    pdf = pdfOf(['NEW EXACT DATE 2026']);
    expect((await capturePdf()).copyPass).toBe(true);
  });
});
