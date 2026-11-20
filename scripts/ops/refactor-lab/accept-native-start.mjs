/** Starts one real split Codex task, exactly once; the operator then injects faults. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {labClient} from './lab-client.mjs';
const [root='/lab',caseId]=process.argv.slice(2);
assert(caseId && /^[a-z0-9-]{1,60}$/.test(caseId),'explicit new case id required');
const lab=await labClient(root);
const artifact=path.join(lab.root,'artifacts',`${caseId}.json`);
const record={schema:'octopus-refactor-acceptance/v1',scenario:'native-split-recovery',sha:lab.sha,caseId,
 startedAt:new Date().toISOString(),phase:'before-dispatch',passed:false,observations:[]};
fs.writeFileSync(artifact,JSON.stringify(record,null,2),{flag:'wx'});
const browser=await lab.playwright.chromium.launch({headless:true,args:['--no-sandbox']});
try {
 await lab.post('/api/session-plus/trust',{decision:'trust',follow_updates:true});
 const context=await browser.newContext({storageState:await lab.request.storageState()});
 const page=await context.newPage(); const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(lab.origin+'/sessions-plus',{waitUntil:'domcontentloaded'});
 await page.locator('[data-av-session-action="new-anywhere"]').first().click();
 await page.locator('[data-av-new-session-action="toggle-placement"]').click();
 await page.locator('[data-av-new-session-control="runtime-device"]').selectOption('lab_alice_model');
 await page.locator('[data-av-new-session-control="execution-device"]').selectOption('lab_alice_execution');
 await page.getByLabel('Agent 后端',{exact:true}).selectOption('codex');
 await page.getByLabel('模型',{exact:true}).selectOption('gpt-5.6-sol');
 await page.getByLabel('Effort',{exact:true}).selectOption('low');
 const workspace=page.locator('[data-av-new-session-control="workspace"]');
 await page.waitForFunction(()=>[...document.querySelector('[data-av-new-session-control="workspace"]').options].some(o=>o.text.includes('Sessions')));
 const choice=await workspace.locator('option').evaluateAll(xs=>xs.find(x=>x.text.includes('Sessions'))?.value);
 assert(choice,'synthetic Sessions workspace');await workspace.selectOption(choice);
 await page.getByLabel('第一条需求',{exact:true}).fill(`这是隔离故障恢复验收 ${caseId}，只操作当前工作目录。任务有两个阶段：若 ${caseId}-started.txt 不存在，创建它，内容只写一行 started；然后执行 sleep 240 等待测试注入故障。若你恢复时发现 started 文件已存在，则跳过第一阶段与 sleep，继续检查第二阶段。第二阶段：若 ${caseId}-done.txt 不存在，创建它，内容只写一行 done。最后读取两个文件，只回复验收完成。已有文件不覆盖、不追加，不访问其他目录，不部署，不给他人发送消息。`);
 page.on('response',async response=>{
  if(!response.url().endsWith('/api/session-plus/act'))return;
  try {const body=await response.json();record.observations.push({status:response.status(),ok:body.ok,error:body.error,
   operation:body.operation?.id,resultStatus:body.result?.status});}catch{}
 });
 record.phase='dispatch-requested';fs.writeFileSync(artifact,JSON.stringify(record,null,2));
 await page.getByRole('button',{name:'启动 Agent',exact:true}).click();
 await page.waitForTimeout(8000);
 record.phase='awaiting-workspace-started-marker';record.pageErrors=errors;
 record.ui=(await page.locator('body').innerText()).slice(0,8000);
 fs.writeFileSync(artifact,JSON.stringify(record,null,2));
 await page.screenshot({path:path.join(lab.root,'artifacts',`${caseId}-started.png`),fullPage:true});
 console.log(JSON.stringify({caseId,sha:lab.sha,phase:record.phase,pageErrors:errors}));
}finally{await browser.close();await lab.close();}
