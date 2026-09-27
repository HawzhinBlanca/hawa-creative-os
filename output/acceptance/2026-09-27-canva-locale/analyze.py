"""Offline inspection of retained real exports; no provider calls or human verdicts."""
import csv, hashlib, json, subprocess, zipfile, xml.etree.ElementTree as ET
from pathlib import Path
from PIL import Image, ImageChops
from pypdf import PdfReader
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
NS={'a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
def read(name):return json.loads((HERE/name).read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
fixtures,receipt=read('fixtures.json'),read('live-capture.json')
assert receipt['status']=='captured'
assert sha(ROOT/fixtures['corpus']['path'])==fixtures['corpus']['sha256']
# Captures are historical. Compare their recipe to its committed source, never today's checker.
for path,digest in fixtures['sourceHashes'].items():
 original=subprocess.check_output(['git','show',fixtures['sourceCommit']+':'+path],cwd=ROOT)
 assert hashlib.sha256(original).hexdigest()==digest,path

def objects(path):
 with zipfile.ZipFile(path) as z:root=ET.fromstring(z.read('ppt/slides/slide1.xml'))
 rows=[]
 for shape in root.findall('.//p:sp',NS):
  paragraphs=shape.findall('.//a:p',NS)
  text='\n'.join(''.join(t.text or '' for t in p.findall('.//a:t',NS)) for p in paragraphs)
  if not text:continue
  colors=[]
  for pi,p in enumerate(paragraphs):
   if pi:colors.append(('\n',None))
   for run in p.findall('./a:r',NS):
    t=''.join(t.text or '' for t in run.findall('./a:t',NS))
    color=run.find('./a:rPr/a:solidFill/a:srgbClr',NS)
    colors.extend((character,color.get('val') if color is not None else None) for character in t)
  identity=shape.find('.//p:cNvPr',NS)
  xfrm=shape.find('./p:spPr/a:xfrm',NS)
  geom=None
  if xfrm is not None:
   off,ext=xfrm.find('a:off',NS),xfrm.find('a:ext',NS)
   if off is not None and ext is not None:geom=[int(off.get('x'))/9525,int(off.get('y'))/9525,int(ext.get('cx'))/9525,int(ext.get('cy'))/9525]
  rows.append({'text':text,'shapeId':identity.get('id') if identity is not None else None,'geometryPx':geom,
   'languages':sorted({e.get('lang') for e in shape.iter() if e.get('lang')}),
   'paragraphRtl':[p.find('./a:pPr',NS).get('rtl') if p.find('./a:pPr',NS) is not None else None for p in paragraphs],
   'declaredFonts':sorted({e.get('typeface') for e in shape.iter() if e.get('typeface')}),
   'colorRuns':colors})
 return rows

results=[];review=[]
for group in fixtures['groups']:
 record=receipt['groups'][group['id']]
 assert record['captureMetadataUnchanged'] and record['captureBefore']==record['captureAfter']
 assert sha(HERE/group['file'])==group['sha256']
 for item in record['exports'].values():
  assert sha(HERE/item['file'])==item['sha256'] and (HERE/item['file']).stat().st_size==item['bytes']
  if 'qa' in item:assert sha(HERE/item['qa']['file'])==item['qa']['sha256']
 before,after=objects(HERE/group['file']),objects(HERE/record['exports']['pptx']['file'])
 exact=[c['text'] for c in group['cases']]
 assert [r['text'] for r in before]==exact
 assert [r['text'] for r in after]==exact
 assert len({r['shapeId'] for r in after})==len(exact) and all(r['shapeId'] for r in after)
 native=read(group['id']+'-native.json')
 assert native['designId']==record['design']['id']
 # Tool output loses internal paragraph breaks; this comparison is deliberately labelled lossy.
 native_matches=native['flatText']=='\n'.join(t.replace('\n','') for t in exact)
 with Image.open(HERE/record['exports']['png']['file']) as im:dimensions=list(im.size);im.load()
 pdf=PdfReader(HERE/record['exports']['pdf']['file']);assert len(pdf.pages)==1
 fonts=[{'name':f.get_object().get('/BaseFont'),'subtype':f.get_object().get('/Subtype')} for f in pdf.pages[0]['/Resources']['/Font'].values()]
 blocks=[]
 for c,b,a in zip(group['cases'],before,after):
  colors=b.pop('colorRuns')==a.pop('colorRuns')
  blocks.append({'caseId':c['id'],'exactPptxText':True,'source':b,'exported':a,'perCharacterColorsPreserved':colors,
   'allExportRunLanguageTagsMatchSource':a['languages']==b['languages']})
  review.append({'case_id':c['id'],'text':c['text'],'design_id':record['design']['id'],'png':record['exports']['png']['file'],
   'review_status':'not_reviewed','reviewer':'','reviewed_at':'','notes':''})
 row={'id':group['id'],'designId':record['design']['id'],'pngDimensions':dimensions,'blocks':blocks,
  'pdfFontResources':fonts,'nativeFlatTextMatchesWithoutParagraphBreaks':native_matches,
  'nativeElementIdentityAndLineBreaks':'unavailable_from_read_tool','humanVisualReview':'not_run'}
 if group.get('baseline'):
  assert sha(ROOT/group['baseline'])==group['baselineSha256']
  with Image.open(ROOT/group['baseline']) as old,Image.open(HERE/record['exports']['png']['file']) as current:
   assert old.size==current.size
   diff=ImageChops.difference(old.convert('RGBA'),current.convert('RGBA'))
   count=sum(any(pixel) for pixel in diff.get_flattened_data())
   row['baselineComparison']={'changedPixels':count,'totalPixels':old.width*old.height,'pngFileBytesIdentical':sha(ROOT/group['baseline'])==sha(HERE/record['exports']['png']['file'])}
 results.append(row)
summary={'schemaVersion':1,'captureSourceCommit':fixtures['sourceCommit'],'imports':2,'exports':6,'exactPptxStrings':14,'groups':results,
 'fullMultilingualAdmission':False,'limits':['Canva rewrites language tags; retain original language provenance outside its exports.',
 'Read-only native text tool concatenates internal paragraphs and gives no element IDs or style spans.',
 'Explicit false RTL on the mixed Studio block was overridden by the font-family fallback before import; requested direction is not met.',
 'Human native-language review, committed edit/save/reopen, full office corpus and deployed-image qualification are not run.',
 'Font-family/resource names do not establish actual font-file glyph coverage or licenses.',
 'Equal provider timestamps are not an atomic revision lock.']}
(HERE/'offline-analysis.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
if not (HERE/'human-review.csv').exists():
 with (HERE/'human-review.csv').open('w',newline='') as f:
  writer=csv.DictWriter(f,fieldnames=review[0]);writer.writeheader();writer.writerows(review)
print(json.dumps({'imports':2,'exports':6,'exactPptxStrings':14,'allColorRunsPreserved':all(b['perCharacterColorsPreserved'] for r in results for b in r['blocks']),
 'baseline':results[0]['baselineComparison'],'humanReview':'not_run','explicitStudioLtrControl':'failed_before_import'}))
