import { execFileSync } from 'node:child_process';

/**
 * Synthetic operator action only. Append to one existing live-text object in the
 * copied fixture; keep every other OOXML part and all unrelated shape/style bytes.
 * Python's standard library is already required by the recovery rehearsal.
 * This is not a Canva editing capability or native preservation admission.
 */
export function appendFixtureCopy(bytes: Buffer, originalCopy: string, line: string): Buffer {
  return execFileSync('python3', ['-c', String.raw`
import io, re, sys, zipfile, xml.etree.ElementTree as ET
from xml.sax.saxutils import escape
data = sys.stdin.buffer.read(25 * 1024 * 1024 + 1)
if len(data) > 25 * 1024 * 1024: raise ValueError('Oversized synthetic deck')
source = zipfile.ZipFile(io.BytesIO(data))
parts = source.infolist()
if len(parts) > 500 or len(set(p.filename for p in parts)) != len(parts) or sum(p.file_size for p in parts) > 64 * 1024 * 1024:
    raise ValueError('Unsupported synthetic ZIP')
path = 'ppt/slides/slide1.xml'
xml = source.read(path).decode('utf-8')
matches = 0
def patch(shape):
    global matches
    node = ET.fromstring('<root xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' + shape.group() + '</root>')
    ns = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
    text = '\n'.join(''.join(t.text or '' for t in p.findall('.//a:t', ns)) for p in node.findall('.//a:p', ns))
    if text != sys.argv[1]: return shape.group()
    matches += 1
    texts = list(re.finditer(r'<a:t(?:\s[^>]*)?>([\s\S]*?)</a:t>', shape.group()))
    if not texts: raise ValueError('Missing live fixture text')
    last = texts[-1]
    at = last.end(1)
    return shape.group()[:at] + '\n' + escape(sys.argv[2]) + shape.group()[at:]
patched = re.sub(r'<p:sp>[\s\S]*?</p:sp>', patch, xml)
if matches != 1: raise ValueError('Expected exactly one matching fixture copy object')
output = io.BytesIO()
with zipfile.ZipFile(output, 'w') as result:
    for part in parts:
        result.writestr(part, patched.encode('utf-8') if part.filename == path else source.read(part.filename))
sys.stdout.buffer.write(output.getvalue())
`, originalCopy, line], { input: bytes, maxBuffer: 26 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
