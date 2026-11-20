/** Build, declare and activate only this candidate's Apps on the marked test Head. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {labClient} from './lab-client.mjs';
const lab=await labClient(process.argv[2]);
const installed=[];
const catalog=await (await lab.request.get('/api/apps')).json();
try {
 for(const app of ['session-plus','research-program','ppt-studio','chess']) {
  const artifact=path.join(lab.root,'artifacts',`${app}-${lab.sha}.bundle.json`);
  execFileSync(process.execPath,['--import','tsx',...(app==='session-plus'?['packages/bot/src/app-registry/pack-cli.ts']:['packages/bot/src/app-registry/app-pack-cli.ts',`packages/${app}-view/src/pack.ts`]),'--out',artifact],{stdio:['ignore','pipe','pipe']});
  const bundle=JSON.parse(fs.readFileSync(artifact,'utf8'));
  const existing=catalog.apps.find(row=>row.stableAppId===app);
  if(existing) assert.equal(existing.publisher,bundle.descriptor.publisher,'existing App publisher');
  else if(app!=='session-plus') await lab.post('/api/apps/declare',{app,publisher:bundle.descriptor.publisher,title:`Lab · ${app}`});
  const packed=await lab.post('/api/apps/install',{bundle});
  const active=await lab.post('/api/apps/activate',{app,package_digest:packed.package_digest});
  installed.push({app,packageDigest:packed.package_digest,active});
 }
 const receipt={schema:'octopus-refactor-apps/v1',sha:lab.sha,installed};
 fs.writeFileSync(path.join(lab.root,'artifacts',`apps-${lab.sha}.json`),JSON.stringify(receipt,null,2));
 console.log(JSON.stringify(receipt));
}finally{await lab.close();}
