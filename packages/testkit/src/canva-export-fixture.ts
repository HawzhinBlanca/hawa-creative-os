import { encodeEditableTransfer } from '@hawa/creative';
import { checkCanvaPptx } from '@hawa/qa';

/** A real one-page editable deck for approval-flow tests, with a capture receipt from its bytes. */
export async function checkedCanvaExportFixture(copy = 'Exact copy') {
  const transfer = await encodeEditableTransfer({
    width: 640, height: 640, background: '#FFFFFF', shapes: [],
    text: [{ copyIndex: 0, x: 20, y: 20, width: 600, height: 100, fontSize: 24,
      fontFamily: 'Verdana', color: '#000000', align: 'left' }],
  }, [copy]);
  const bytes = Buffer.from(transfer.bytes);
  const contentCheck = { ...checkCanvaPptx(bytes, [copy], 'Verdana'), expectedCopy: [copy] };
  if (!contentCheck.copyPass || !contentCheck.fontPass || !contentCheck.rtlPass) {
    throw new Error('Canva test fixture did not pass its own source check');
  }
  return { bytes, contentCheck };
}
