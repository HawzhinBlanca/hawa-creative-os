import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { encodeEditableTransfer } from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';
import { checkedCanvaExportFixture } from '../../src/canva-export-fixture.js';
import { appendFixtureCopy } from '../driver/fixture-native-edit.js';

describe('synthetic native revision fixture editing', () => {
  it('changes only the selected live text while preserving every unrelated OOXML byte', async () => {
    const originalCopy='Original page one 123.45\nPage two 678.90';
    const line='New date <2026> & exact numerals 123.45';
    const source=(await checkedCanvaExportFixture(originalCopy)).bytes;
    const edited=appendFixtureCopy(source,originalCopy,line);
    const observed=checkCanvaPptx(edited,[`${originalCopy}\n${line}`],'Verdana');
    expect(observed.copyPass,JSON.stringify(observed.sourceTextObjects)).toBe(true);
    expect(observed.fontPass).toBe(true);
    // Independent part comparison also inspects the preserved text-object styles.
    const fidelity=JSON.parse(execFileSync('python3',['-c',String.raw`
import base64, io, json, sys, zipfile
data=json.load(sys.stdin)
original=zipfile.ZipFile(io.BytesIO(base64.b64decode(data['original'])))
edited=zipfile.ZipFile(io.BytesIO(base64.b64decode(data['edited'])))
path='ppt/slides/slide1.xml'
a=original.read(path); b=edited.read(path)
addition=b'\nNew date &lt;2026&gt; &amp; exact numerals 123.45'
print(json.dumps({'sameParts':original.namelist()==edited.namelist(),
 'unrelatedPartsUnchanged':all(original.read(n)==edited.read(n) for n in original.namelist() if n!=path),
 'onlyExactTextAddition':b.replace(addition,b'',1)==a and b.count(addition)==1}))
`],{input:JSON.stringify({original:source.toString('base64'),edited:edited.toString('base64')}),encoding:'utf8'}));
    expect(fidelity).toEqual({sameParts:true,unrelatedPartsUnchanged:true,onlyExactTextAddition:true});
  });

  it('refuses a missing exact text object instead of reconstructing a fresh design', async () => {
    const source=(await checkedCanvaExportFixture('Existing exact copy')).bytes;
    expect(()=>appendFixtureCopy(source,'Other text','New date')).toThrow();
  });

  it('refuses ambiguous repeated text objects', async () => {
    const transfer=await encodeEditableTransfer({width:640,height:640,background:'#FFFFFF',shapes:[],text:[0,1].map(i=>({
      copyIndex:i,x:20,y:20+i*130,width:600,height:100,fontSize:24,fontFamily:'Verdana',color:'#000000',align:'left' as const,
    }))},['Repeated exact copy','Repeated exact copy']);
    expect(()=>appendFixtureCopy(Buffer.from(transfer.bytes),'Repeated exact copy','New date')).toThrow();
  });
});
