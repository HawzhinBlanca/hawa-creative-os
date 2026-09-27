"""Offline acceptance inventory; no provider calls and no invented human verdicts."""
import csv
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageChops
from pypdf import PdfReader

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(name):
    return json.loads((HERE / name).read_text())


fixtures = read('fixtures.json')
receipt = read('live-capture.json')
assert digest(ROOT / fixtures['corpus']['path']) == fixtures['corpus']['sha256']
for name, sha in fixtures['sourceHashes'].items():
    assert digest(ROOT / name) == sha, name

checked = []
for group in receipt['groups'].values():
    for artifact in group['exports'].values():
        assert digest(HERE / artifact['file']) == artifact['sha256'], artifact['file']
        assert (HERE / artifact['file']).stat().st_size == artifact['bytes']
        checked.append(artifact['file'])
        if 'qa' in artifact:
            assert digest(HERE / artifact['qa']['file']) == artifact['qa']['sha256']

groups = []
review_rows = []
for fixture in fixtures['groups']:
    name = fixture['id']
    accepted = name if name != 'group-1' else 'group-1-round-2'
    capture = receipt['groups'][accepted]
    assert capture['status'] == 'captured' and capture['captureMetadataUnchanged'] is True
    assert capture['captureBefore'] == capture['captureAfter']
    assert digest(HERE / fixture['file']) == fixture['sha256']
    native = read(f'{name}-native.json')
    assert native['designId'] == capture['design']['id']
    assert len(native['richtexts']) == len(fixture['cases']) == 10
    assert len({item['element_id'] for item in native['richtexts']}) == 10
    native_text = [''.join(region.get('text', '') for region in item['regions']) for item in native['richtexts']]
    assert native_text == [case['text'] for case in fixture['cases']], name
    qa = read(capture['exports']['pptx']['qa']['file'])
    assert qa['copyPass'] is True and qa['fontPass'] is True
    assert qa['rtlNote'] and qa['fullReleasePass'] is False
    png_path = HERE / capture['exports']['png']['file']
    with Image.open(png_path) as im:
        assert im.size == (1200, 2000)
        im.load()
    pdf = PdfReader(HERE / capture['exports']['pdf']['file'])
    assert len(pdf.pages) == 1
    fonts = []
    for resource, ref in pdf.pages[0]['/Resources']['/Font'].items():
        font = ref.get_object()
        fonts.append({'resource': str(resource), 'baseFont': str(font.get('/BaseFont')) if font.get('/BaseFont') else None,
                      'subtype': str(font.get('/Subtype'))})
    groups.append({'id': name, 'acceptedCapture': accepted, 'designId': native['designId'],
                   'caseCount': 10, 'nativeExactCopyPass': True, 'independentNativeTextObjects': 10,
                   'pptxCopyPass': True, 'declaredFontFamilyPass': True, 'declaredFamilies': qa['observedFonts'],
                   'pdfFonts': fonts, 'pngDimensions': [1200, 2000], 'metadataUnchangedDuringCapture': True,
                   'humanVisualReview': 'not_run', 'renderedGlyphCoverage': None})
    for case, element in zip(fixture['cases'], native['richtexts']):
        review_rows.append({'case_id': case['id'], 'language': case['language'], 'exact_copy': case['text'],
                            'checks_requested': ', '.join(case['checks']), 'design_id': native['designId'],
                            'element_id': element['element_id'], 'png': png_path.name,
                            'review_status': 'not_reviewed', 'reviewer': '', 'reviewed_at': '', 'notes': ''})

with Image.open(HERE / 'group-1-canva.png') as first, Image.open(HERE / 'group-1-round-2-canva.png') as second:
    diff = ImageChops.difference(first.convert('RGBA'), second.convert('RGBA'))
    changed = sum(any(pixel) for pixel in diff.get_flattened_data())

summary = {
    'schemaVersion': 1, 'observedDate': '2026-09-27', 'captureSourceCommit': fixtures['sourceCommit'],
    'corpus': fixtures['corpus'], 'imports': 4, 'exports': len(checked), 'groups': groups,
    'totalExactNativeStrings': len(review_rows),
    'firstCaptureRefusal': {'status': receipt['groups']['group-1']['status'],
                            'reason': 'Provider metadata changed during capture; artifacts retained but excluded from accepted set.',
                            'replacement': 'group-1-round-2', 'pngDecodedChangedPixels': changed,
                            'pngBytesIdentical': digest(HERE / 'group-1-canva.png') == digest(HERE / 'group-1-round-2-canva.png')},
    'failures': receipt.get('failures', []),
    'fullMultilingualAdmission': False,
    'limits': [
        'Native read inspection establishes independent addressable text, not committed manual edit/save/reopen.',
        'Direction is explicitly set from the golden oracle; automatic direction inference is not tested.',
        'RTL-038 and RTL-039 keep literal ** markers; actual styled runs are not tested.',
        'One declared family and one wide layout; approved multiple fonts and narrow layouts are not tested.',
        'PDF font resources include NotoSans-Regular in addition to NotoSansArabic-Regular; group 4 also has unnamed Type3 resources.',
        'PDF text extraction is not an authoritative logical-text oracle for these RTL exports.',
        'Font names do not establish exact font-file coverage, fallback correctness or licensing.',
        'Metadata samples are not an atomic Canva revision lock.',
        'Native reader visual review, 20 real Sorani, 10 Arabic and 10 mixed office designs remain unexecuted.',
        'No full Hawa task/review/approval/delivery or deployment was exercised.',
    ],
    'artifactHashes': {path.name: digest(path) for path in sorted(HERE.iterdir())
                       if path.is_file() and path.suffix in {'.png', '.pdf', '.pptx', '.json'}
                       and path.name != 'offline-analysis.json'},
}
(HERE / 'offline-analysis.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
review_path = HERE / 'human-review.csv'
# A rerun must never overwrite human decisions.
if not review_path.exists():
    with review_path.open('w', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=list(review_rows[0]), lineterminator='\n')
        writer.writeheader()
        writer.writerows(review_rows)
print(json.dumps({'nativeExactStrings': len(review_rows), 'imports': 4, 'exports': len(checked),
                  'firstRecaptureChangedPixels': changed, 'fullMultilingualAdmission': False}))
