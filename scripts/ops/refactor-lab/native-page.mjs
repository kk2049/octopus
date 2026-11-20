import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
/** A synthetic owner's normal one-command approval, never a provider policy override. */
export async function finishNative(lab,sid,filename,record){
 assert(/^[a-z0-9-]+\.txt$/.test(filename));
 const browser=await lab.playwright.chromium.launch({headless:true,args:['--no-sandbox']});let page;
 try{
  const context=await browser.newContext({storageState:await lab.request.storageState()});page=await context.newPage();
  await page.goto(lab.origin+'/sessions-plus');
  const toggle=page.locator('[data-av-recent-sessions-toggle]');await toggle.waitFor();if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
  const resource=Buffer.from(JSON.stringify(['lab_alice','lab_alice_model','codex',sid])).toString('base64url');
  await page.locator(`[data-av-session-row="${resource}"]`).first().click();
  const deadline=Date.now()+150000,seen=new Set();record.nativeApprovals=0;
  const output=path.join(lab.root,'workspaces/sessions',filename);
  while(!fs.existsSync(output)){
   assert(Date.now()<deadline,'native child did not finish through the owner approval UI');
   const card=page.locator('[data-av-agent-interaction]:not([data-agent-interaction-state="resolved"])').first();
   if(await card.count()){
    const id=await card.getAttribute('data-av-agent-interaction');
    if(!seen.has(id)){
     const detail=await card.innerText();
     assert(detail.includes(filename) || detail.includes('octopus_execution') && detail.includes('run_workspace_command'),
      'only the named synthetic output or its one-call workspace tool confirmation may be approved');
     assert(!/\b(rm|sudo|curl|wget|ssh|scp|git|deploy|shutdown|reboot)\b/.test(detail),'unexpected command requires inspection');
     seen.add(id);await card.getByRole('button',{name:'允许一次并继续',exact:true}).click();record.nativeApprovals++;
    }
   }
   await page.waitForTimeout(500);
  }
  record.output=fs.readFileSync(output,'utf8').trim();
  await page.screenshot({path:path.join(lab.root,'artifacts',record.caseId+'-native.png'),fullPage:true});
 }finally{if(page){record.nativeUi=(await page.locator('body').innerText()).slice(-10000);await page.screenshot({path:path.join(lab.root,'artifacts',record.caseId+'-native.png'),fullPage:true}).catch(()=>{});}await browser.close();}
}
