import { sql, withRlsContext, type Database, type Kysely } from '@hawa/db';
import { extractSearchTokens, type SearchableItem, type SearchCategory } from '@hawa/retrieval';

/** Same OR-token/NFC/Sorani matching as Desk lexical search, before bounded database reads. */
export function searchWords(corpus: ReturnType<typeof sql>, query: string) {
  const normalized = sql`btrim(regexp_replace(regexp_replace(
    translate(lower(normalize(${corpus}, NFC)), 'كي٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', 'کی01234567890123456789'),
    ${'[\u064B-\u065F\u0670]'}, '', 'g'), ${'[\u200C-\u200F\u202A-\u202E\u2066-\u2069،؛؟]'}, ' ', 'g'))`;
  const tokens = extractSearchTokens(query);
  return tokens.length ? sql`(${sql.join(tokens.map(token => sql`strpos(${normalized}, ${token}) > 0`), sql` OR `)})` : sql`true`;
}
interface HistoryRow { id:string; category:'feedback'|'revisions'|'copy'; client_id:string; task_id:string|null;
  revision_id:string|null; title:string; body:string; status:string; created_at:Date }
/** Read-only history; RLS plus joined source identities authorize every returned field. */
export async function searchHistory(db: Kysely<Database>, scope: {tenantId:string;userId:string;role:string},
  clientId: string | undefined, query: string, category: SearchCategory) {
  const items: SearchableItem[] = [];
  let truncated = false;
  if (clientId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) return {items,truncated};
  const configured = Number(process.env.HAWA_SEARCH_HISTORY_CEILING);
  const ceiling = Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.min(20_000, Math.floor(configured))) : 5_000;
  const clientFilter = clientId ? sql`AND h.client_id=${clientId}::uuid` : sql``;
  const read = async (kind: HistoryRow['category'], rows: ReturnType<typeof sql>) => {
    if (category !== 'all' && category !== kind) return;
    const result = await withRlsContext(db, {...scope,...(clientId ? {clientId} : {})}, trx =>
      sql<HistoryRow>`WITH history AS (${rows}) SELECT h.* FROM history h
        WHERE ${searchWords(sql`concat_ws(' ',h.id,h.title,h.body,h.status,h.category)`,query)} ${clientFilter}
          ${kind==='copy' ? sql`AND nullif(btrim(h.body),'') IS NOT NULL` : sql``}
        ORDER BY h.created_at DESC,h.id DESC LIMIT ${ceiling+1}`.execute(trx));
    truncated ||= result.rows.length > ceiling;
    for (const row of result.rows.slice(0,ceiling)) items.push({id:row.id,category:row.category,clientId:row.client_id,
      title:row.title,subtitle:row.body || row.status,bodyText:`${row.title} ${row.body}`,status:row.status,tags:[row.category,row.status],
      metadata:{taskId:row.task_id,revisionId:row.revision_id},updatedAt:row.created_at.toISOString()});
  };
  await read('feedback',sql`
    SELECT 'feedback:'||f.id::text AS id,'feedback' AS category,f.client_id,f.task_id,
      coalesce(ra.id,rb.id)::text AS revision_id,f.category||' feedback' AS title,concat_ws(' ',f.comment,
        CASE WHEN f.category='client_rule_instruction' AND f.target->>'kind'='client_rule_instruction_v1'
          AND jsonb_typeof(f.target->'input'->'title')='string' THEN f.target->'input'->>'title' END,
        CASE WHEN f.category='client_rule_instruction' AND f.target->>'kind'='client_rule_instruction_v1'
          AND jsonb_typeof(f.target->'input'->'ruleText')='string' THEN f.target->'input'->>'ruleText' END) AS body,
      f.scope::text AS status,f.created_at FROM hawa.feedback_events f
      LEFT JOIN hawa.tasks t ON t.tenant_id=f.tenant_id AND t.id=f.task_id AND t.client_id=f.client_id
      LEFT JOIN hawa.design_revisions rb ON rb.tenant_id=f.tenant_id AND rb.id=f.before_revision_id AND rb.task_id=f.task_id
      LEFT JOIN hawa.design_revisions ra ON ra.tenant_id=f.tenant_id AND ra.id=f.after_revision_id AND ra.task_id=f.task_id
      WHERE f.tenant_id=${scope.tenantId}::uuid AND (f.task_id IS NULL OR t.id IS NOT NULL)
        AND (f.before_revision_id IS NULL OR rb.id IS NOT NULL) AND (f.after_revision_id IS NULL OR ra.id IS NOT NULL)
    UNION ALL
    SELECT 'studio-feedback:'||f.id::text,'feedback',t.client_id,f.task_id,NULL,f.verdict||' design feedback',
      coalesce(f.notes,''),f.verdict,f.created_at FROM hawa.design_feedback f
      JOIN hawa.tasks t ON t.tenant_id=f.tenant_id AND t.id=f.task_id
        AND (f.client_id IS NULL OR f.client_id=t.client_id)
      WHERE f.tenant_id=${scope.tenantId}::uuid AND t.client_id IS NOT NULL`);
  await read('revisions',sql`
    SELECT r.id::text AS id,'revisions' AS category,t.client_id,r.task_id,r.id::text AS revision_id,
      coalesce(CASE WHEN jsonb_typeof(r.neutral_manifest->'title')='string' THEN nullif(r.neutral_manifest->>'title','') END,t.title,'Design')||' · Revision '||r.revision AS title,
      r.studio||' revision '||r.revision AS body,r.status,r.created_at FROM hawa.design_revisions r
      JOIN hawa.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      WHERE r.tenant_id=${scope.tenantId}::uuid AND t.client_id IS NOT NULL`);
  await read('copy',sql`
    SELECT 'copy:'||r.id::text AS id,'copy' AS category,t.client_id,r.task_id,r.id::text AS revision_id,
      'Copy · Revision '||r.revision AS title,concat_ws(' ',
        (SELECT string_agg(n.value->>'text',' ' ORDER BY n.ordinality)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.neutral_manifest->'nodes')='array'
            THEN r.neutral_manifest->'nodes' ELSE '[]'::jsonb END) WITH ORDINALITY n
          WHERE n.value->>'type'='text' AND jsonb_typeof(n.value->'text')='string'),
        (SELECT string_agg(c.value#>>'{}',' ' ORDER BY c.ordinality)
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.neutral_manifest->'copy')='array'
            THEN r.neutral_manifest->'copy' ELSE '[]'::jsonb END) WITH ORDINALITY c
          WHERE jsonb_typeof(c.value)='string')) AS body,r.status,r.created_at
      FROM hawa.design_revisions r JOIN hawa.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id
      WHERE r.tenant_id=${scope.tenantId}::uuid AND t.client_id IS NOT NULL
    UNION ALL
    SELECT 'request-copy:'||t.id::text,'copy',t.client_id,t.id,NULL,'Requested copy',concat_ws(' ',
      CASE WHEN jsonb_typeof(source.payload->'copyEn')='string' THEN source.payload->>'copyEn' END,
      CASE WHEN jsonb_typeof(source.payload->'copyCkb')='string' THEN source.payload->>'copyCkb' END,
      (SELECT string_agg(c.value#>>'{}',' ' ORDER BY c.ordinality)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(source.payload->'exactCopy')='array'
          THEN source.payload->'exactCopy' ELSE '[]'::jsonb END) WITH ORDINALITY c WHERE jsonb_typeof(c.value)='string')),
      t.state::text,t.created_at FROM hawa.tasks t
      JOIN LATERAL (SELECT payload FROM hawa.outbox_commands WHERE tenant_id=t.tenant_id AND aggregate_id=t.id
        AND command_type='task.created' ORDER BY created_at DESC LIMIT 1) source ON true
      WHERE t.tenant_id=${scope.tenantId}::uuid AND t.client_id IS NOT NULL
    UNION ALL
    SELECT 'studio-copy:'||r.id::text,'copy',t.client_id,r.task_id,NULL,'Design copy',
      (SELECT string_agg(c.value->>'text',' ' ORDER BY c.ordinality)
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.request->'copyBlocks')='array'
          THEN r.request->'copyBlocks' ELSE '[]'::jsonb END) WITH ORDINALITY c
        WHERE jsonb_typeof(c.value->'text')='string'),r.status,r.created_at
      FROM hawa.design_studio_runs r JOIN hawa.tasks t ON t.tenant_id=r.tenant_id AND t.id=r.task_id AND t.client_id=r.client_id
      WHERE r.tenant_id=${scope.tenantId}::uuid AND t.client_id IS NOT NULL`);
  return {items,truncated};
}
