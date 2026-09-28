import zlib
from pathlib import Path

def pdf(pages):
 objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'']
 for text in pages:
  page_id=len(objects)+1
  objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents {page_id+1} 0 R >>'.encode())
  data=zlib.compress(b'BT /F1 12 Tf 72 700 Td ('+text.encode()+b') Tj ET')
  objects.append(f'<< /Length {len(data)} /Filter /FlateDecode >>\nstream\n'.encode()+data+b'\nendstream')
 objects[1]=f'<< /Type /Pages /Count {len(pages)} /Kids ['.encode()+b' '.join(f'{i} 0 R'.encode() for i in range(3,len(objects)+1,2))+b'] >>'
 out=b'%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'; offsets=[0]
 for i,obj in enumerate(objects,1):
  offsets.append(len(out));out+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
 xref=len(out)
 out+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
 out+=b''.join(f'{n:010d} 00000 n \n'.encode() for n in offsets[1:])
 out+=f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
 return out
Path(__file__).with_name('two-pages.pdf').write_bytes(pdf(['Hawa source page one 123.45','Hawa source page two 678.90']))
Path(__file__).with_name('blank.pdf').write_bytes(pdf(['']))
Path(__file__).with_name('too-many-pages.pdf').write_bytes(pdf(['text']*41))
