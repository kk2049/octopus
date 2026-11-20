import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {labClient} from './lab-client.mjs';
const [root,caseId,phase='inspect']=process.argv.slice(2);assert(/^[a-z0-9-]{1,60}$/.test(caseId||''));
const lab=await labClient(root);const started=JSON.parse(fs.readFileSync(path.join(root,'artifacts',caseId+'.json'),'utf8'));
const body=await (await lab.request.get('/api/tickets/'+started.ticketId)).json();assert(body.ticket);
const Database=createRequire(path.join(process.cwd(),'packages/bot/package.json'))('better-sqlite3');const db=new Database(path.join(root,'state/bot.db'),{readonly:true,fileMustExist:true});
try{
 const turns=db.prepare('SELECT id,state FROM dev_runner_turns WHERE ticket_id=? ORDER BY rowid').all(started.ticketId);
 const jobs=db.prepare("SELECT id,observed FROM managed_executions WHERE source='ticket' AND json_extract(record,'$.reference')=?").all(String(started.ticketId));
 function find(dir,name,depth=0){if(depth>9)return null;for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name===name&&entry.isFile())return path.join(dir,entry.name);if(entry.isDirectory()&&!['node_modules','.git'].includes(entry.name)){const found=find(path.join(dir,entry.name),name,depth+1);if(found)return found;}}return null;}
 const start=find(path.join(root,'workspaces/sessions'),caseId+'-started.txt');const done=start&&path.join(path.dirname(start),caseId+'-done.txt');
 const record={ticketId:started.ticketId,sessionId:body.ticket.session_id,turnStartedAt:body.ticket.turn_started_at,paused:body.ticket.chat_paused,status:body.ticket.dev_status,turns,jobs,started:Boolean(start),done:Boolean(done&&fs.existsSync(done)),sha:lab.sha};
 if(phase==='finish'){
  assert(record.done&&!record.turnStartedAt&&!record.paused);assert.equal(fs.readFileSync(start,'utf8').trim(),'started');assert.equal(fs.readFileSync(done,'utf8').trim(),'5');assert.equal(turns.length,1);assert.equal(turns[0].state,'finished');assert(jobs.some(j=>j.observed==='completed'));
 }
 console.log(JSON.stringify(record));
}finally{db.close();await lab.close();}
