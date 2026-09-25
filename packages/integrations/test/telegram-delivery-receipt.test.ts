import {afterEach,describe,expect,it,vi} from 'vitest';
import {TelegramBridgeDaemon} from '../src/telegram-bridge.js';
afterEach(()=>vi.restoreAllMocks());
describe('Telegram outbound receipts',()=>{
  it('returns only Telegram message IDs and sends plain text without implicit Markdown',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({ok:true,result:{message_id:42,chat:{id:123}}})));
    const bridge=new TelegramBridgeDaemon({botToken:'test'});
    expect(await bridge.dispatchOutboundMessage(123,{text:'copy_with_[brackets]'})).toEqual({success:true,messageId:'42'});
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).not.toHaveProperty('parse_mode');
    expect(bridge.getSentMessages()).toHaveLength(1);
  });
  it.each([
    [{ok:false,error_code:403},403,'TELEGRAM_REJECTED_403'],
    [{ok:false,error_code:429},200,'TELEGRAM_REJECTED_429'],
    [{ok:true,result:{message_id:42,chat:{id:999}}},200,'TELEGRAM_RECEIPT_INVALID'],
    [{ok:true},200,'TELEGRAM_RECEIPT_INVALID'],
  ])('does not invent successful delivery for a rejected or invalid receipt',async(body,status,error)=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify(body),{status}));
    const bridge=new TelegramBridgeDaemon({botToken:'test'});
    expect(await bridge.dispatchOutboundMessage(123,{text:'Status'})).toEqual({success:false,error});
    expect(bridge.getSentMessages()).toHaveLength(0);
  });
  it('does not replay an ambiguous network outcome',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('timeout'));
    const bridge=new TelegramBridgeDaemon({botToken:'test'});
    expect(await bridge.dispatchOutboundMessage(123,{text:'Status'})).toEqual({success:false,error:'TELEGRAM_DELIVERY_UNCERTAIN'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('holds a 5xx and an unreadable successful HTTP response as uncertain', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 502 }, { status: 502 }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 200 }));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundMessage(123, { text: 'Status' }))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(await bridge.dispatchOutboundMessage(123, { text: 'Status' }))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(await bridge.dispatchOutboundMessage(123, { text: 'Status' }))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('holds a 5xx during the plain-text fallback as uncertain', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 400,
        description: "Bad Request: can't parse entities" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 502 }, { status: 502 }));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundMessage(123, { text: '<b>Status</b>', parse_mode: 'HTML' }))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { message_id: 42, chat: { id: 999 } },
    { message_id: 0, chat: { id: 123 } },
    { message_id: 42 },
  ])('rejects a malformed plain-text fallback receipt after a parse failure', async (result) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 400,
        description: "Bad Request: can't parse entities" }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result }));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundMessage(123, { text: '<b>Status</b>', parse_mode: 'HTML' }))
      .toEqual({ success: false, error: 'TELEGRAM_RECEIPT_INVALID' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(bridge.getSentMessages()).toHaveLength(0);
  });
  it('distinguishes pre-connection network errors from ambiguous delivery outcomes', async () => {
    const connError = new TypeError('fetch failed');
    (connError as any).cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 149.154.167.220:443' };
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(connError);
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundMessage(123, { text: 'Status' })).toEqual({
      success: false,
      error: 'TELEGRAM_NETWORK_ERROR',
    });
    const photoRes = await bridge.dispatchOutboundPhoto(123, Buffer.from('png-bytes'), 'Photo caption');
    expect(photoRes).toEqual({
      success: false,
      error: 'TELEGRAM_NETWORK_ERROR',
    });
  });
  it('does not claim delivery without credentials',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch');
    expect(await new TelegramBridgeDaemon().dispatchOutboundMessage(123,{text:'Status'})).toEqual({success:false,error:'TELEGRAM_NOT_CONFIGURED'});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never retries a captioned photo after a 5xx and rejects a wrong-chat photo receipt', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ ok: false, error_code: 502 }, { status: 502 }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { message_id: 21, chat: { id: 999 } } }))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 200 }));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    expect(await bridge.dispatchOutboundPhoto(123, Buffer.from('png'), 'caption'))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await bridge.dispatchOutboundPhoto(123, Buffer.from('png')))
      .toEqual({ success: false, error: 'TELEGRAM_RECEIPT_INVALID' });
    expect(await bridge.dispatchOutboundPhoto(123, Buffer.from('png')))
      .toEqual({ success: false, error: 'TELEGRAM_DELIVERY_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('caps in-memory sentMessages history to 500 entries to prevent memory leaks', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 123 } } })));
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    for (let i = 0; i < 550; i++) {
      await bridge.dispatchOutboundMessage(123, { text: `Message ${i}` });
    }
    const messages = bridge.getSentMessages();
    expect(messages.length).toBe(500);
    expect(messages[messages.length - 1].text).toBe('Message 549');
    expect(messages[0].text).toBe('Message 50');
  });
  it('rejects dispatchOutboundPhoto with empty or invalid buffer', async () => {
    const bridge = new TelegramBridgeDaemon({ botToken: 'test' });
    const emptyRes = await bridge.dispatchOutboundPhoto(123, Buffer.alloc(0), 'caption');
    expect(emptyRes).toEqual({ success: false, error: 'INVALID_PHOTO_BUFFER' });
    const nullRes = await bridge.dispatchOutboundPhoto(123, null as any, 'caption');
    expect(nullRes).toEqual({ success: false, error: 'INVALID_PHOTO_BUFFER' });
  });
});

describe('Telegram ingress acknowledgment ordering',()=>{
  it('retains a failed update and retries it before consuming later updates',async()=>{
    const remote=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>Response.json({ok:true,result:[{update_id:101},{update_id:102}]}));
    const bridge=new TelegramBridgeDaemon({botToken:'test'});
    await bridge.pollOnce(async()=>{throw new Error('Database unavailable');});
    expect(bridge.getStatus().lastUpdateId).toBe(0);
    const delivered:number[]=[];
    await bridge.pollOnce(async u=>{delivered.push(u.update_id);});
    expect(delivered).toEqual([101,102]);expect(bridge.getStatus().lastUpdateId).toBe(102);
    expect(String(remote.mock.calls[1][0])).toContain('offset=1&');
  });
});
