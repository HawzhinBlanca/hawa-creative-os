from pathlib import Path
import hashlib
import json
import struct
import xml.etree.ElementTree as ET
import zipfile
from pypdf import PdfReader

root = Path(__file__).resolve().parent
expected = [
    'HAWA EDITABLE IMPORT TEST',
    'Exact copy: Mr. / Ms. / Dr. [EDITABLE TEST]',
    '13 September 2026 | 2:30 PM',
]
manifest = json.loads((root / 'baseline-capture.json').read_text())
for row in manifest['formats'].values():
    content = (root / row['file']).read_bytes()
    assert len(content) == row['bytes']
    assert hashlib.sha256(content).hexdigest() == row['sha256']
pdf = PdfReader(root / 'baseline.pdf')
assert len(pdf.pages) == 1
page = pdf.pages[0]
text = page.extract_text()
assert all(value in text for value in expected)
assert '[REOPEN CHECK]' not in text
fonts = []
for ref in page['/Resources']['/Font'].values():
    font = ref.get_object()
    fonts.append({'baseFont': str(font['/BaseFont']), 'type': str(font['/Subtype'])})
ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
      'p': 'http://schemas.openxmlformats.org/presentationml/2006/main'}
objects = []
with zipfile.ZipFile(root / 'baseline.pptx') as archive:
    tree = ET.fromstring(archive.read('ppt/slides/slide1.xml'))
    for shape in tree.findall('.//p:sp', ns):
        runs = shape.findall('.//a:t', ns)
        if runs:
            identity = shape.find('.//p:cNvPr', ns)
            objects.append({'id': identity.attrib['id'],
                            'text': ''.join(run.text or '' for run in runs),
                            'fonts': sorted({font.attrib['typeface'] for font in shape.findall('.//a:latin', ns)})})
assert [obj['text'] for obj in objects] == expected
assert len({obj['id'] for obj in objects}) == 3
pixels = struct.unpack('>II', (root / 'baseline.png').read_bytes()[16:24])
assert pixels == (1024, 768)
receipt = {
    'schemaVersion': 1, 'artifactHashesMatch': True,
    'png': {'pixels': pixels},
    'pdf': {'pages': 1, 'sizePoints': [float(x) for x in page.mediabox],
            'exactTextPresent': True, 'fonts': fonts},
    'pptx': {'pages': 1, 'textObjects': objects, 'exactCopyPass': True},
    'draftIsolation': {'uncommittedReplacementAbsentInPdfAndPptx': True},
    'limits': ['English-only three-text fixture; no print certification or multilingual glyph review.',
               'PPTX object IDs are not native Canva element IDs.'],
}
(root / 'artifact-inspection.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt, indent=2))
