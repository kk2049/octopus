/** Observe one exact App turn through a named provider outage and optional stop. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {labClient} from './lab-client.mjs';import {appActivity} from './app-activity.mjs';
const [root,caseId,mode='resume']=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||''));assert(['resume','stop','preflight'].includes(mode));
const lab=await labClient(root);const browser=await lab.playwright.chromium.launch({headless:true,args:['--no-sandbox']});
const file=path.join(root,'artifacts',`${caseId}${mode==='preflight'?'-preflight':''}.json`);const record={schema:mode==='preflight'?'octopus-refactor-setup/v1':'octopus-refactor-acceptance/v1',scenario:'app-'+mode+'-while-offline',realAgent:mode==='resume',consumerIds:mode==='resume'?['app:ppt-studio:presenter']:[],scenarios:mode==='preflight'?[]:['minute-visible-wait',...(mode==='stop'?['stop-while-waiting']:[])],sha:lab.sha,caseId,passed:false,startedAt:new Date().toISOString()};
fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx'});let monitor;
try{
 const context=await browser.newContext({storageState:await lab.request.storageState()});const page=await context.newPage();monitor=appActivity(page,'ppt-studio');
 await page.goto(lab.origin+'/apps/ppt-studio/open');const before=await monitor.idle();
 if(mode==='preflight'){record.idle=true;lab.assertCandidate();record.passed=true;}
 else {
  await page.locator('textarea').fill(`这是合成断网验收 ${caseId}。请用结构化 deck 制作恰好两页，演示文稿标题=${caseId}，第一页标题=自动恢复，第二页标题=原任务继续。禁止生成外部文件、图片或发消息。`);
  await page.getByRole('button',{name:'生成 / 改写',exact:true}).click();
  const turn=await monitor.next(before,'presenter');record.turnId=turn.id;
  const activity=page.getByRole('region',{name:'应用任务'});
  await monitor.state(turn.id,'reconnecting',30000);record.reconnectingAt=new Date().toISOString();
  await monitor.state(turn.id,'waiting_resource',90000);record.waitingAt=new Date().toISOString();
  await activity.getByText('presenter · 等待运行环境',{exact:true}).first().waitFor();
  const delay=Date.parse(record.waitingAt)-Date.parse(record.reconnectingAt);assert(delay>=45000&&delay<=90000,`visible grace ${delay}ms`);record.visibleGraceMs=delay;
  await activity.locator('summary').click();
  await page.screenshot({path:path.join(root,'artifacts',`${caseId}-waiting.png`),fullPage:true});
  if(mode==='stop'){
   assert.deepEqual(monitor.snapshot().filter(row=>row.canStop).map(row=>row.id),[turn.id]);
   await activity.getByRole('button',{name:'停止此任务',exact:true}).click();
   await monitor.state(turn.id,'stopped');await activity.getByText('presenter · 已停止',{exact:true}).first().waitFor();record.stoppedAt=new Date().toISOString();
  }
  fs.writeFileSync(path.join(root,'artifacts',`${caseId}-ready.json`),JSON.stringify({mode,sha:lab.sha,caseId,turnId:turn.id,waitingAt:record.waitingAt}));
  const deadline=Date.now()+120000;while(!fs.existsSync(path.join(root,'artifacts',`${caseId}-restored.json`))){assert(Date.now()<deadline,'provider restoration timeout');await page.waitForTimeout(500);}
  if(mode==='resume'){
   await page.getByText(caseId,{exact:true}).first().waitFor({timeout:120000});
   await monitor.state(turn.id,'ended',180000);
   assert.equal(await page.locator('.dkv-outline .dkv-slides > [data-dkv-slide]').count(),2,'two actual structured slides');record.resultVisible=true;
  }else{
   await page.waitForTimeout(35000);assert.equal(await page.getByText(caseId,{exact:true}).count(),0,'stopped task must not commit deck');
   assert.equal(monitor.snapshot().find(row=>row.id===turn.id)?.state,'stopped');assert(monitor.snapshot().every(row=>before.has(row.id)||row.id===turn.id),'stop must not silently create another task');record.remainedStopped=true;
  }
  record.ui=(await activity.innerText()).slice(0,8000);record.finalActivity=monitor.snapshot().find(row=>row.id===turn.id);lab.assertCandidate();record.passed=true;
 }
 record.finishedAt=new Date().toISOString();
}catch(error){record.error=String(error);throw error;}
finally{monitor?.close();fs.writeFileSync(file,JSON.stringify(record,null,2));await browser.close();await lab.close();console.log(JSON.stringify({caseId,passed:record.passed,error:record.error}));}
