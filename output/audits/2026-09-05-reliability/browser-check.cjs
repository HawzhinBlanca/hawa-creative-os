const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const results=[];
 for(const [name,width,height] of [['desktop',1440,1000],['laptop',1024,768],['mobile',390,844]]){
  const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];const blocked=[];
  page.on('pageerror',e=>errors.push(e.message));
  // UI inspection only: block every remote provider and every state-changing API operation.
  await page.route('**/*',async route=>{
   const r=route.request(),u=new URL(r.url());
   if(!['127.0.0.1','localhost'].includes(u.hostname)){blocked.push(u.origin);return route.abort();}
   if(!['GET','HEAD'].includes(r.method())){blocked.push(r.method()+' '+u.pathname);return route.fulfill({status:503,contentType:'application/json',body:'{"detail":"Audit: writes disabled"}'});}
   return route.continue();
  });
  await page.goto('http://127.0.0.1:5187/#/review',{waitUntil:'networkidle'});
  await page.screenshot({path:path.join(__dirname,name+'.png'),fullPage:true});
  const metrics=await page.evaluate(()=>({viewport:innerWidth,bodyScroll:document.body.scrollWidth,docScroll:document.documentElement.scrollWidth,text:document.body.innerText.slice(0,16000),buttons:[...document.querySelectorAll('button')].map(b=>({text:b.innerText,title:b.title,label:b.getAttribute('aria-label'),rect:{width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height},visible:!!b.getClientRects().length})),landmarks:{main:document.querySelectorAll('main,[role=main]').length,dialogs:document.querySelectorAll('[role=dialog]').length},overflow:[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+4||r.left < -4)}).slice(0,20).map(e=>({tag:e.tagName,cls:e.className,text:e.textContent?.slice(0,60)}))}));
  const focus=[];for(let i=0;i<12;i++){await page.keyboard.press('Tab');focus.push(await page.evaluate(()=>({tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label'),text:document.activeElement?.textContent?.slice(0,50)})));}
  results.push({name,width,height,errors,blocked,metrics,focus});await context.close();
 }
 fs.writeFileSync(path.join(__dirname,'browser.json'),JSON.stringify({at:new Date().toISOString(),scope:'Read-only Chrome development UI, external fonts blocked, reduced motion, no screen-reader or real mobile test',results},null,2));
 await browser.close();console.log(JSON.stringify(results.map(x=>({name:x.name,errors:x.errors,scrollWidth:x.metrics.docScroll,buttons:x.metrics.buttons.length,unnamed:x.metrics.buttons.filter(b=>!b.text&&!b.title&&!b.label).length})),null,2));
})().catch(e=>{console.error(e);process.exit(1)});
