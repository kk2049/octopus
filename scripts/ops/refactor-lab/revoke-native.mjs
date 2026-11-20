/** Revoke only this synthetic session's currently bound execution token via normal owner API. */
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {labClient} from './lab-client.mjs';
const [root,sid]=process.argv.slice(2);assert(/^[a-f0-9-]{36}$/.test(sid||''));const lab=await labClient(root);
const Database=createRequire(path.join(process.cwd(),'packages/bot/package.json'))('better-sqlite3');
const db=new Database(path.join(root,'state/bot.db'),{readonly:true,fileMustExist:true});
try{
 const row=db.prepare("SELECT token_hash,execution_device FROM session_execution_bindings WHERE owner='lab_alice' AND runtime_device='lab_alice_model' AND source='codex' AND session_id=?").get(sid);
 assert(row&&row.execution_device==='lab_alice_execution');
 const reply=await lab.post('/api/mcp/tokens/revoke',{token_hash:row.token_hash});assert(reply.changed);
 lab.assertCandidate();console.log(JSON.stringify({sha:lab.sha,sessionId:sid,revoked:true}));
}finally{db.close();await lab.close();}
