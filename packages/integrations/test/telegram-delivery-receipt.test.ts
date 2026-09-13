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
  it('does not claim delivery without credentials',async()=>{
    const fetch=vi.spyOn(globalThis,'fetch');
    expect(await new TelegramBridgeDaemon().dispatchOutboundMessage(123,{text:'Status'})).toEqual({success:false,error:'TELEGRAM_NOT_CONFIGURED'});
    expect(fetch).not.toHaveBeenCalled();
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
