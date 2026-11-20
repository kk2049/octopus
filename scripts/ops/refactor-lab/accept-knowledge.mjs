/** The real knowledge service: original request dedupe, owner isolation, one answer. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {labClient} from './lab-client.mjs';
const [root,caseId,mode='normal']=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||''));assert(['normal','brief-offline'].includes(mode));
const lab=await labClient(root);const record={schema:'octopus-refactor-acceptance/v1',sha:lab.sha,caseId,realAgent:true,consumerIds:['knowledge-chat'],scenarios:['cross-owner-isolation',...(mode==='brief-offline'?['brief-network-outage']:[])],passed:false,startedAt:new Date().toISOString()};
const file=path.join(root,'artifacts',caseId+'.json');fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx'});
try{
 const input={message:`合成恢复验收 ${caseId}。请简短解释为什么网络暂时离线不等于用户取消；没有事实证据时不要宣称实验完成。`,request_id:caseId};
 const created=await lab.post('/api/knowledge/chats',input);record.chatId=created.chat.id;assert(created.running);
 const duplicate=await lab.post('/api/knowledge/chats',input);assert(duplicate.duplicate);assert.equal(duplicate.chat.id,record.chatId);
 fs.writeFileSync(path.join(root,'artifacts',caseId+'-ready.json'),JSON.stringify({sha:lab.sha,chatId:record.chatId}));
 // Give the synthetic peer normal feature access so this checks owner isolation, not a page-level denial.
 await lab.post('/api/admin/grant',{username:'lab_bob',capability:'dev',value:true});
 const bob=await labClient(root,'lab_bob');try{assert.equal((await bob.request.get('/api/knowledge/chats')).status(),200);assert.equal((await bob.request.get('/api/knowledge/chat?id='+record.chatId)).status(),404);}finally{await bob.close();}
 const deadline=Date.now()+180000;let history;
 while(true){history=await (await lab.request.get('/api/knowledge/chat?id='+record.chatId)).json();if(history.messages?.some(m=>m.role==='assistant'))break;assert(Date.now()<deadline,'original knowledge task did not answer');await new Promise(r=>setTimeout(r,1000));}
 const users=history.messages.filter(m=>m.role==='user'),answers=history.messages.filter(m=>m.role==='assistant');assert.equal(users.length,1);assert.equal(answers.length,1);assert(answers[0].content.trim());
 record.inputCount=users.length;record.answerCount=answers.length;record.answerCharacters=answers[0].content.length;lab.assertCandidate();record.passed=true;record.finishedAt=new Date().toISOString();
}catch(error){record.error=String(error);throw error;}
finally{fs.writeFileSync(file,JSON.stringify(record,null,2));await lab.close();console.log(JSON.stringify(record));}
