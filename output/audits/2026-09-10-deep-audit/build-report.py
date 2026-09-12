from pathlib import Path
from markdown_it import MarkdownIt
import base64, re, json, hashlib, html

root=Path(__file__).resolve().parent
source=(root/'REPORT.md').read_text()
renderer=MarkdownIt('commonmark').enable('table')
body=renderer.render(source)
for shot in sorted((root/'screenshots').glob('*.png')):
    body=body.replace(str(shot),'data:image/png;base64,'+base64.b64encode(shot.read_bytes()).decode())
# Absolute workspace links work in Codex Markdown, but are not HTTP routes.
body=re.sub(r'<a href="(/Users/[^\"]+)">(.*?)</a>',lambda m:'<span title="'+m[1]+'">'+m[2]+'</span>',body)
body=re.sub(r'<h2>(.*?)</h2>',lambda m:'<h2 id="'+re.sub('[^a-z0-9]+','-',m[1].lower()).strip('-')+'">'+m[1]+'</h2>',body)
css='''
:root{color-scheme:dark;--bg:#10151d;--panel:#18212c;--ink:#e7eaf0;--muted:#a9b4c4;--line:#344153;--accent:#e9bd75}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.75 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.mast{border-bottom:1px solid var(--line);padding:22px max(24px,calc((100vw - 1050px)/2));font-size:12px;letter-spacing:.16em;color:var(--accent)}
main{max-width:1050px;margin:auto;padding:48px 34px 100px}h1{font-size:clamp(38px,6vw,66px);line-height:1.1;letter-spacing:-.045em;margin:0 0 26px}h2{font-size:30px;line-height:1.25;letter-spacing:-.025em;margin:68px 0 22px;padding-top:26px;border-top:1px solid var(--line)}
h3{font-size:24px;line-height:1.35;color:var(--accent);margin:48px 0 16px}p,li{max-width:88ch}strong{color:#fff}a{color:#96c8ff;text-underline-offset:4px}li{margin:10px 0}code{font: .85em ui-monospace,monospace;background:#222f3e;padding:3px 6px;border-radius:4px;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:14px;border:1px solid var(--line);vertical-align:top}th{background:var(--panel)}
img{display:block;max-width:100%;height:auto;max-height:1000px;margin:25px auto 60px;border:1px solid var(--line);border-radius:12px;box-shadow:0 20px 50px #0004}
.lead{background:var(--panel);border-left:4px solid #e9bd75;padding:20px 26px;margin:28px 0 40px;border-radius:0 12px 12px 0}.lead p{margin:0}.jump{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0 32px}.jump a{padding:6px 0;margin-right:16px;font-size:14px}
@media(max-width:650px){main{padding:32px 18px 64px}body{font-size:16px}h2{font-size:26px}h3{font-size:21px}table{display:block;overflow:auto}.mast{padding:18px}img{border-radius:6px}}
@media print{body{background:white;color:#17212c}strong{color:#17212c}h3{color:#634722}img{max-height:700px;box-shadow:none}a{color:#234f86}.mast,.jump{display:none}}
'''
body=body.replace('<h2 id="verdict">Verdict</h2>','<nav class="jump"><a href="#release-blockers">Release blockers</a><a href="#repair-order-and-exact-exit-conditions">Repair order</a><a href="#captured-walkthrough">Screenshots</a><a href="#fresh-validation-results">Test results</a><a href="REPORT.md" download>Markdown + source links</a></nav><h2 id="verdict">Verdict</h2>')
page='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hawa — deep independent audit · 10 September 2026</title><style>'+css+'</style></head><body><div class="mast">HAWA / INDEPENDENT QUALITY AUDIT / 10 SEPTEMBER 2026</div><main>'+body+'</main></body></html>'
(root/'REPORT.html').write_text(page)
findings=[]
for match in re.finditer(r'### (D\d+) · (P\d) — (.+)\n([\s\S]*?)(?=\n### |\n## |\Z)',source):
    findings.append({'id':match[1],'priority':match[2],'title':match[3],'details':match[4].strip()})
(root/'findings.json').write_text(json.dumps(findings,indent=2,ensure_ascii=False))
files=[p for p in root.rglob('*') if p.is_file() and 'probe-state' not in p.parts and 'fresh-state' not in p.parts and p.name!='evidence-sha256.json']
(root/'evidence-sha256.json').write_text(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},indent=2))
print(f'Rendered {len(findings)} findings and {len(list((root/"screenshots").glob("*.png")))} screenshots.')
