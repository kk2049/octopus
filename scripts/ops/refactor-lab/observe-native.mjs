/** Read the live trusted UI; optional explicit stop is a synthetic user's action. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {labClient} from './lab-client.mjs';
const [root,caseId,sid,mode='waiting']=process.argv.slice(2);assert(/^[a-z0-9-]+$/.test(caseId)&&/^[a-f0-9-]+$/.test(sid));assert(['waiting','stop','completed','unknown'].includes(mode));
const lab=await labClient(root);const browser=await lab.playwright.chromium.launch({headless:true,args:['--no-sandbox']});
const record={schema:'octopus-refactor-native-ui/v1',sha:lab.sha,caseId,sid,mode,passed:false};
let page;
try{
 const context=await browser.newContext({storageState:await lab.request.storageState()});page=await context.newPage();
 await page.goto(lab.origin+'/sessions-plus');
 const toggle=page.locator('[data-av-recent-sessions-toggle]');await toggle.waitFor();if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
 const resource=Buffer.from(JSON.stringify(['lab_alice','lab_alice_model','codex',sid])).toString('base64url');
 await page.locator(`[data-av-session-row="${resource}"]`).first().click({timeout:30000});
 if(mode==='unknown'){
  await page.locator('[data-agent-recovery="unknown"]').waitFor({timeout:30000});record.unknownVisible=true;
 }else if(mode!=='completed'){
  await page.locator('[data-agent-recovery="waiting_resource"]').waitFor({timeout:30000});
  record.waitingVisible=true;
  if(mode==='stop'){
   await page.getByRole('button',{name:'停止自动恢复',exact:true}).click();
   await page.locator('[data-agent-recovery="waiting_resource"]').waitFor({state:'detached',timeout:30000});
   record.stopAcknowledged=true;
  }
 }
 record.ui=(await page.locator('body').innerText()).slice(-12000);
 await page.screenshot({path:path.join(root,'artifacts',`${caseId}-${mode}.png`),fullPage:true});
 lab.assertCandidate();record.passed=true;
}catch(error){record.error=String(error);throw error;}
finally{if(page){record.ui=(await page.locator('body').innerText()).slice(0,15000);record.rows=await page.locator('[data-av-session-row]').evaluateAll(xs=>xs.map(x=>({id:x.dataset.avSessionRow,text:x.textContent})));await page.screenshot({path:path.join(root,'artifacts',`${caseId}-${mode}.png`),fullPage:true}).catch(()=>{});}fs.writeFileSync(path.join(root,'artifacts',`${caseId}-${mode}.json`),JSON.stringify(record,null,2));await browser.close();await lab.close();console.log(JSON.stringify({caseId,mode,passed:record.passed,error:record.error}));}
