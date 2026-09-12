from pathlib import Path
import re,html,base64,csv,hashlib,json
root=Path(__file__).resolve().parent
md=(root/'REPORT.md').read_text()
# Make source references actionable in the Markdown report.
md=re.sub(r'`((?:apps|packages|infra)/[^`\s]+):(\d+)`',lambda m:f'[{m[1]}:{m[2]}](/Users/hawzhin/Hawdesign/{m[1]}:{m[2]})',md)
(root/'REPORT.md').write_text(md)
def inline(s):
 s=html.escape(s)
 s=re.sub(r'`([^`]+)`',r'<code>\1</code>',s)
 s=re.sub(r'\*\*([^*]+)\*\*',r'<strong>\1</strong>',s)
 s=re.sub(r'\[([^\]]+)\]\(([^)]+)\)',lambda m: '<code>'+m[1]+'</code>' if m[2].startswith('/Users/') else '<a href="'+m[2]+'">'+m[1]+'</a>',s)
 return s
parts=[]; paragraph=[]; inlist=None; table=False
def flush():
 if paragraph: parts.append('<p>'+inline(' '.join(paragraph))+'</p>'); paragraph.clear()
def close_lists():
 global inlist,table
 if inlist: parts.append('</'+inlist+'>');inlist=None
 if table:parts.append('</tbody></table></div>');table=False
for line in md.splitlines():
 if not line.strip(): flush(); close_lists(); continue
 img=re.fullmatch(r'!\[([^\]]+)\]\(([^)]+)\)',line)
 if img:
  flush();close_lists();data=base64.b64encode((root/img[2]).read_bytes()).decode()
  parts.append(f'<figure><img loading="eager" alt="{html.escape(img[1])}" src="data:image/png;base64,{data}"><figcaption>{html.escape(img[1])} · {html.escape(img[2])}</figcaption></figure>');continue
 h=re.match(r'^(#{1,3}) (.+)',line)
 if h:flush();close_lists();n=len(h[1]);parts.append(f'<h{n}>{inline(h[2])}</h{n}>');continue
 if line.startswith('|'):
  flush()
  if re.match(r'^\|[\s:|\-]+\|$',line):continue
  if not table: parts.append('<div class="table"><table><tbody>');table=True
  parts.append('<tr>'+''.join('<td>'+inline(c.strip())+'</td>' for c in line.strip('|').split('|'))+'</tr>');continue
 li=re.match(r'^(?:([-]) |(\d+)\. )(.+)',line)
 if li:
  flush();kind='ul' if li[1] else 'ol'
  if inlist!=kind:close_lists();parts.append('<'+kind+'>');inlist=kind
  parts.append('<li>'+inline(li[3])+'</li>');continue
 paragraph.append(line)
flush();close_lists()
css='''body{margin:0;background:#f4f5f7;color:#20242c;font:17px/1.65 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:48px 32px;background:white}h1{font-size:38px;line-height:1.15}h2{margin-top:56px;border-top:1px solid #ddd;padding-top:24px}h3{margin-top:40px}p,li{max-width:96ch}a{color:#2452a0}code{font-size:.86em;background:#f1f2f5;padding:2px 4px;overflow-wrap:anywhere}td{padding:14px;border-bottom:1px solid #ddd;vertical-align:top}tr:first-child{font-weight:700;background:#edf0f6}.table{overflow:auto}table{border-collapse:collapse;width:100%}figure{margin:24px 0 48px}img{max-width:100%;height:auto;border:1px solid #dce0e6}figcaption{font-size:13px;color:#626a77}li{margin-bottom:16px}@media(max-width:600px){main{padding:24px 16px}h1{font-size:28px}}'''
(root/'REPORT.html').write_text('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hawdesign — Independent Quality Audit</title><style>'+css+'</style><main>'+''.join(parts)+'</main></html>')
rows=[
('HQ-01','critical','FR-060;NFR-001;NFR-003','C;H','Maps lose task across process; no registered Restate services','probes.json;restart-probe.json;runtime.log'),
('HQ-02','critical','FR-047;FR-048;FR-049;FR-050','G','Publisher/reconciler manufacture success','probes.json'),
('HQ-03','critical','FR-043;FR-044;FR-069;NFR-015','B;F','Unverified sessions and cross-task revision decisions accepted','probes.json'),
('HQ-04','critical','FR-015;FR-041;FR-045','E;F;G','Absent QA defaults to pass; empty design approved','probes.json;screenshots/04-live-review.png'),
('HQ-05','high','FR-028;FR-029;FR-030','A','Canonical Figma path operates locally without real readback','probes.json;screenshots/05-figma-proof.png'),
('HQ-06','high','FR-065','D','Wrong model gets 200/200; visual rubric gets 10/10 without model','probes.json;screenshots/09-evaluations.png'),
('HQ-07','high','FR-064;FR-071;NFR-003','C;H','Literal health and simulated restore','runtime.log;screenshots/08-operations.png'),
('HQ-08','high','FR-017;FR-063','B;F','Fixed workload counts and client hardcode in intake','screenshots/02-desktop-inbox.png;screenshots/03-new-task.png'),
('HQ-09','high','FR-041','F','Review overload and weak visible composition','screenshots/04-live-review.png'),
('HQ-10','high','FR-041','F','Focus escapes dialog; mobile canvas clips and fit remains 100%','screenshots/03-new-task.png;screenshots/11-mobile-review.png;screenshots/12-mobile-canvas.png;screenshots/13-mobile-fit.png'),
('HQ-11','high','FR-020;FR-023;FR-025','D','Fixed creative topology and synthetic vector/rerank scores','source-fingerprints.json'),
('HQ-12','medium','NFR-011','release','Three suite failures; monolithic control paths','tests.log;desk-build.log')]
with (root/'findings.csv').open('w',newline='') as f:
 w=csv.writer(f);w.writerow(['finding','severity','requirements','gates','observation','evidence']);w.writerows(rows)
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file() and p.name!='evidence-sha256.json'}
(root/'evidence-sha256.json').write_text(json.dumps(manifest,indent=2))
print('Report generated:',len(md.split()),'words;',len(list((root/'screenshots').glob('*.png'))),'screenshots')
