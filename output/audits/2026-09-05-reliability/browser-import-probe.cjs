// Harmless local-only imported-markup execution probe. No remote access or real task writes.
const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 await page.route('**/*',r=>{const q=r.request(),u=new URL(q.url());return (!['127.0.0.1','localhost'].includes(u.hostname)||!['GET','HEAD'].includes(q.method()))?r.abort():r.continue()});
 await page.goto('http://127.0.0.1:5187/#/review',{waitUntil:'networkidle'});
 const fixture={canvas:{format:'feed',brandKitId:'hawa',languageMode:'en'},nodes:[{id:'audit-markup',role:'image_custom',name:'Harmless security fixture',x:40,y:40,width:200,height:100,visible:true,svgContent:'<img src="data:image/png;base64,invalid" onerror="window.__hawaAuditMarkupExecuted=true">'}]};
 await page.locator('input[type=file]').first().setInputFiles({name:'audit.hyc',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))});
 await page.waitForFunction(()=>window.__hawaAuditMarkupExecuted===true,{},{timeout:3000}).catch(()=>{});
 const executed=await page.evaluate(()=>window.__hawaAuditMarkupExecuted===true);
 fs.writeFileSync(path.join(__dirname,'browser-import-probe.json'),JSON.stringify({at:new Date().toISOString(),expected:'Imported SVG event handlers never execute',executed,violation:executed,scope:'Fresh development browser context, harmless flag only; external calls and state-changing API requests blocked; not an assertion about a separately hardened production CSP'},null,2));
 console.log({executed});await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
