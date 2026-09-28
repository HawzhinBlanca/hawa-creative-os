import {describe,it,expect,vi} from 'vitest';
import {CanvaConnectClient} from '../src/canva-connect-client.js';

describe('actual Canva capability and dataset reads',()=>{
  it('reads capabilities and exact field names through the authenticated GET client',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({capabilities:['autofill','brand_template']})))
      .mockResolvedValueOnce(new Response(JSON.stringify({dataset:{'Event date':{type:'text'},'Portrait':{type:'image'}}})));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    expect(await client.getCapabilities()).toEqual({capabilities:['autofill','brand_template']});
    expect(await client.getDesignDataset('DA_test')).toEqual({dataset:{'Event date':{type:'text'},Portrait:{type:'image'}}});
    expect(fetcher.mock.calls.map(([url])=>url)).toEqual(['https://api.canva.com/rest/v1/users/me/capabilities','https://api.canva.com/rest/v1/designs/DA_test/dataset']);
    expect(fetcher.mock.calls.every(([,options])=>!options.method || options.method==='GET')).toBe(true);
    expect(fetcher.mock.calls.every(([,options])=>new Headers(options.headers).get('authorization')==='Bearer synthetic-token')).toBe(true);
  });
  it('distinguishes absent optional data from supported capability',async()=>{
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:vi.fn().mockImplementation(async()=>new Response('{}'))});
    expect(await client.getCapabilities()).toEqual({capabilities:[]});
    expect(await client.getDesignDataset('DA_test')).toEqual({dataset:{}});
  });
  it.each([{capabilities:'autofill'},{capabilities:[true]},{dataset:[]},{dataset:{date:{type:'new_unknown_type'}}},{dataset:{date:{type:['text']}}}])('refuses malformed or unsupported provider evidence %j',async(body)=>{
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:vi.fn().mockResolvedValue(new Response(JSON.stringify(body)))});
    await expect('capabilities' in body?client.getCapabilities():client.getDesignDataset('DA_test')).rejects.toThrow(/Invalid Canva/);
  });
  it('preserves safe HTTP classification without exposing the provider body',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response('sensitive provider body',{status:403}));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    await expect(client.getCapabilities()).rejects.toMatchObject({status:403,message:'Canva capabilities failed (HTTP 403)'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds inventories and retains unusual field names as data',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(Response.json({capabilities:Array(101).fill('autofill')}))
      .mockResolvedValueOnce(Response.json({dataset:Object.fromEntries(Array.from({length:513},(_,i)=>[`field${i}`,{type:'text'}]))}))
      .mockResolvedValueOnce(new Response('{"dataset":{"__proto__":{"type":"text"},"ڕۆژ / date":{"type":"text"}}}'));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    await expect(client.getCapabilities()).rejects.toThrow('Invalid Canva capabilities');
    await expect(client.getDesignDataset('DA_test')).rejects.toThrow('Invalid Canva dataset size');
    const result=await client.getDesignDataset('DA_test');
    expect(Object.keys(result.dataset)).toEqual(['__proto__','ڕۆژ / date']);
    expect(Object.getPrototypeOf(result.dataset)).toBe(Object.prototype);
  });
  it('retries temporary reads and validates design IDs before network use',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(new Response('{"dataset":{}}'));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher,readRetryDelaysMs:[0]});
    await expect(client.getDesignDataset('DA_test')).resolves.toEqual({dataset:{}});
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(client.getDesignDataset('../other')).rejects.toThrow('Invalid Canva design ID');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
