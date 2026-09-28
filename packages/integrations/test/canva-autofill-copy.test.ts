import {describe,it,expect,vi} from 'vitest';
import {CanvaConnectClient} from '../src/canva-connect-client.js';

const source='DA_source';
const request=()=>({designId:source,title:'Synthetic amended copy',text:{'Event date':'2026-10-02'},dataset:{'Event date':{type:'text' as const}}});
const design=(id='DA_copy')=>({id,created_at:100,updated_at:200,urls:{edit_url:`https://www.canva.com/design/${id}/edit`,view_url:`https://www.canva.com/design/${id}/view`}});
describe('native text autofill copies',()=>{
  it('sends only the explicit copy mode and exact named text',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({job:{id:'job_one',status:'in_progress'}}));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    const input=request();input.text['Event date']='ڕۆژ ٢٠٢٦ —  10/02\n';
    await expect(client.createTextAutofillCopy(input)).resolves.toEqual({job:{id:'job_one',status:'in_progress'}});
    const [url,init]=fetcher.mock.calls[0];expect(url).toBe('https://api.canva.com/rest/v1/autofills');
    expect(init?.method).toBe('POST');expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-token');
    expect(JSON.parse(String(init?.body))).toEqual({type:'create_from_design',design_id:source,title:input.title,data:{'Event date':{type:'text',text:input.text['Event date']}}});
  });
  it.each(['missing','wrong_type','empty','oversized','bad_id','large_total'] as const)('refuses %s input before provider access',async kind=>{
    const fetcher=vi.fn<typeof fetch>(),client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    const input:{designId:string;title:string;text:Record<string,string>;dataset:Record<string,{type:'text'|'image'}>}=request();
    if(kind==='missing')input.dataset={};
    if(kind==='wrong_type')input.dataset['Event date']={type:'image'};
    if(kind==='empty')input.text={};
    if(kind==='oversized')input.text['Event date']='x'.repeat(16385);
    if(kind==='bad_id')input.designId='../other';
    if(kind==='large_total')for(let i=0;i<10;i++){input.text[`field${i}`]='x'.repeat(16000);input.dataset[`field${i}`]={type:'text'};}
    await expect(client.createTextAutofillCopy(input)).rejects.toThrow(/Invalid Canva|Canva autofill field/);expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not retry uncertain server errors or lost responses',async()=>{
    for(const outcome of ['server','lost']){
      const fetcher=outcome==='server'?vi.fn<typeof fetch>().mockResolvedValue(new Response('private body',{status:503})):
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection lost'));
      const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher,createRetryDelaysMs:[0,0]});
      await expect(client.createTextAutofillCopy(request())).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('retries definite throttling and transient job reads within the configured bound',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('',{status:429})).mockResolvedValueOnce(Response.json({job:{id:'job_one',status:'in_progress'}}))
      .mockResolvedValueOnce(new Response('',{status:503})).mockResolvedValueOnce(Response.json({job:{id:'job_one',status:'success',result:{type:'create_design',design:design()}}}));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher,createRetryDelaysMs:[0],readRetryDelaysMs:[0]});
    await client.createTextAutofillCopy(request());
    expect((await client.getTextAutofillCopyJob('job_one',source)).job).toMatchObject({id:'job_one',status:'success',result:{type:'create_design',design:{id:'DA_copy'}}});
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    {id:'job_one',status:'success',result:{type:'update_design',design:design()}},
    {id:'job_one',status:'success',result:{type:'create_design',design:design(source)}},
    {id:'job_other',status:'success',result:{type:'create_design',design:design()}},
    {id:'job_one',status:'success'},
    {id:'job_one',status:'new_state'},
  ])('refuses mismatched or malformed job evidence %j',async job=>{
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:vi.fn<typeof fetch>().mockResolvedValue(Response.json({job})),readRetryDelaysMs:[]});
    await expect(client.getTextAutofillCopyJob('job_one',source)).rejects.toThrow(/Invalid Canva autofill/);
  });
  it('retains a safe failure code without a provider message or extra fields',async()=>{
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:vi.fn<typeof fetch>().mockResolvedValue(Response.json({job:{id:'job_one',status:'failed',error:{code:'autofill_error',message:'private provider body'}}}))});
    expect(await client.getTextAutofillCopyJob('job_one',source)).toEqual({job:{id:'job_one',status:'failed',error:{code:'autofill_error'}}});
  });
  it('requires an own dataset field and handles special names without prototype mutation',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({job:{id:'job_one',status:'in_progress'}}));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    await expect(client.createTextAutofillCopy({...request(),dataset:Object.create({'Event date':{type:'text'}})})).rejects.toThrow('not an observed text field');
    expect(fetcher).not.toHaveBeenCalled();
    await client.createTextAutofillCopy({...request(),text:Object.fromEntries([['__proto__',' exact \n']]),dataset:Object.fromEntries([['__proto__',{type:'text' as const}]])});
    const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(Object.hasOwn(body.data,'__proto__')).toBe(true);
    expect(body.data.__proto__).toEqual({type:'text',text:' exact \n'});
  });
  it.each(['title','field_count','field_name','utf8_total'] as const)('enforces %s bounds before dispatch',async kind=>{
    const input=request() as {designId:string;title:string;text:Record<string,string>;dataset:Record<string,{type:'text'}>};
    if(kind==='title')input.title='x'.repeat(256);
    if(kind==='field_name') {input.text={['x'.repeat(1025)]:'value'};input.dataset={['x'.repeat(1025)]:{type:'text'}};}
    if(kind==='field_count')for(let i=0;i<33;i++){input.text[String(i)]='value';input.dataset[String(i)]={type:'text'};}
    if(kind==='utf8_total')for(let i=0;i<5;i++){input.text[String(i)]='ڕ'.repeat(16000);input.dataset[String(i)]={type:'text'};}
    const fetcher=vi.fn<typeof fetch>();
    await expect(new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher}).createTextAutofillCopy(input)).rejects.toThrow('Invalid Canva');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['json','shape'] as const)('does not resubmit an accepted response with malformed %s',async kind=>{
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>kind==='json'?new Response('{'):Response.json({job:{id:'job_one',status:'success'}}));
    await expect(new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher,createRetryDelaysMs:[0,0]}).createTextAutofillCopy(request())).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('compares the returned copy with the dispatched source despite caller mutation',async()=>{
    const input=request();
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>{
      input.designId='DA_mutated';
      return Response.json({job:{id:'job_one',status:'success',result:{type:'create_design',design:design(source)}}});
    });
    await expect(new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher}).createTextAutofillCopy(input)).rejects.toThrow('Invalid Canva autofill copy metadata');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    {...design(),urls:{edit_url:'https://attacker.invalid/design/x',view_url:'https://www.canva.com/design/x/view'}},
    {...design(),updated_at:'200'},
    {...design(),created_at:-1},
    {...design(),page_count:1.5},
  ])('refuses invalid native metadata',async invalid=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({job:{id:'job_one',status:'success',result:{type:'create_design',design:invalid}}}));
    await expect(new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher}).getTextAutofillCopyJob('job_one',source)).rejects.toThrow('Invalid Canva autofill copy metadata');
  });
  it('returns only validated copy metadata and does not expose remote failure bodies',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({private:'discard',job:{id:'job_one',status:'success',result:{type:'create_design',design:{...design(),private:'discard'}}}}))
      .mockResolvedValueOnce(new Response('private failure',{status:403}));
    const client=new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher});
    expect(await client.getTextAutofillCopyJob('job_one',source)).toEqual({job:{id:'job_one',status:'success',result:{type:'create_design',design:design()}}});
    await expect(client.createTextAutofillCopy(request())).rejects.toThrow('Canva autofill copy failed (HTTP 403)');
  });
  it.each(['failed','in_progress'] as const)('refuses contradictory %s status with a creation result',async status=>{
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(Response.json({job:{id:'job_one',status,
      result:{type:'create_design',design:design()},error:{code:'autofill_error'}}}));
    await expect(new CanvaConnectClient({accessToken:'synthetic-token',customFetch:fetcher}).getTextAutofillCopyJob('job_one',source))
      .rejects.toThrow('Invalid Canva autofill');
  });
});
