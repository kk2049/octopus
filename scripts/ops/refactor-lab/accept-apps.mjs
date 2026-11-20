/** Real UI actions against a private Head; no direct App state writes. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {labClient} from './lab-client.mjs';import {appActivity} from './app-activity.mjs';
const [root='/lab',caseId]=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||''),'new case id required');
const lab=await labClient(root);const file=path.join(lab.root,'artifacts',`${caseId}.json`);
const record={schema:'octopus-refactor-acceptance/v1',sha:lab.sha,caseId,startedAt:new Date().toISOString(),passed:false,realAgent:true,consumerIds:['app:ppt-studio:presenter','app:chess:luna','app:research-program:secretary'],scenarios:[],steps:[]};
fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx'});
const browser=await lab.playwright.chromium.launch({headless:true,args:['--no-sandbox']});
const context=await browser.newContext({storageState:await lab.request.storageState()});const page=await context.newPage();const errors=[];
page.on('pageerror',e=>errors.push(e.message));
async function save(step){record.steps.push({step,at:new Date().toISOString(),url:page.url(),ui:(await page.locator('body').innerText()).slice(0,10000)});fs.writeFileSync(file,JSON.stringify(record,null,2));}
let monitor;
try{
 monitor=appActivity(page,'ppt-studio');
 await page.goto(lab.origin+'/apps/ppt-studio/open');
 const pptBefore=await monitor.idle();
 await page.locator('textarea').fill(`隔离验收 ${caseId}。请生成恰好两页中文幻灯片，演示文稿标题为“${caseId}”。第一页标题为“恢复验收”，副标题为“合成测试数据”；第二页为要点页，三条内容：等待一分钟、保持监听、原会话恢复。直接使用结构化 deck，不生成文件或图片。`);
 await page.getByRole('button',{name:'生成 / 改写',exact:true}).click();
 await page.getByText(caseId,{exact:true}).first().waitFor({timeout:120000});
 const pptTurn=await monitor.next(pptBefore,'presenter');record.pptTurnId=pptTurn.id;await monitor.state(pptTurn.id,'ended');
 assert.equal(await page.locator('.dkv-outline .dkv-slides > [data-dkv-slide]').count(),2,'two actual structured slides');
 await save('ppt-presenter-real-deck');monitor.close();monitor=appActivity(page,'chess');
 await page.goto(lab.origin+'/apps/chess/open');
 await page.getByRole('button',{name:'以 white 新开',exact:true}).click();
 const chessBefore=await monitor.idle();
 await page.getByRole('button',{name:'人工智障（电脑）',exact:true}).click();
 await page.getByText('人工智障模式',{exact:true}).waitFor();
 await page.locator('[data-square="6,4"]').click();await page.locator('[data-square="4,4"]').click();
 await page.getByRole('button',{name:'提交走子',exact:true}).click();
 await page.locator('.chess-v2__moves > div').nth(1).waitFor({timeout:120000});
 assert.equal(await page.locator('.chess-v2__moves > div').count(),2,'exactly one black reply');
 await page.getByRole('heading',{name:'轮到你，白方',exact:true}).waitFor();
 const chessTurn=await monitor.next(chessBefore,'luna');record.chessTurnId=chessTurn.id;await monitor.state(chessTurn.id,'ended');
 await save('chess-luna-real-black-move');monitor.close();monitor=appActivity(page,'research-program');
 const project=await lab.post('/api/apps/research-program/shared-instances',{role:'owner'});
 assert(/^asi_[a-f0-9]+$/.test(project.instance_key));record.projectKey=project.instance_key;
 await page.goto(lab.origin+'/apps/research-program/open?instance='+project.instance_key);
 await page.locator('.research-program').waitFor();const researchBefore=await monitor.idle();
 await page.getByRole('tab',{name:'科研协作',exact:true}).click();
 await page.getByRole('button',{name:'科研秘书',exact:true}).click();
 await page.getByLabel('问秘书 / 交代下一步',{exact:true}).fill(`这是合成灰度验收 ${caseId}。请记录一个 briefing，标题包含 ${caseId}，明确写出当前没有实验结果，不能声称已完成研究；说明这个项目的科研记录如何区分要求、推断、验收。请直接留存这份 briefing，无需询问，不要替人批准。`);
 await page.getByRole('button',{name:'交给科研秘书',exact:true}).click();
 await page.getByRole('button',{name:'查看引用与学习确认',exact:true}).last().waitFor({timeout:120000});
 const researchTurn=await monitor.next(researchBefore,'secretary');record.researchTurnId=researchTurn.id;await monitor.state(researchTurn.id,'ended');
 await save('research-secretary-persisted-briefing');
 record.pageErrors=errors;assert.equal(errors.length,0);record.phase='completed';lab.assertCandidate();record.passed=true;record.finishedAt=new Date().toISOString();
}catch(error){record.error=String(error);await save('failure');throw error;}
finally{monitor?.close();await page.screenshot({path:path.join(lab.root,'artifacts',`${caseId}.png`),fullPage:true}).catch(()=>{});fs.writeFileSync(file,JSON.stringify(record,null,2));await browser.close();await lab.close();}
