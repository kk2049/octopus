import assert from 'node:assert/strict';
/** Observe the trusted UI's existing reads; correlate every result with its turn. */
export function appActivity(page, appId) {
 let rows=null, failure=null, closed=false;
 const response=async reply=>{
  if(!reply.url().includes('/api/app-view/agent-activity?app='+encodeURIComponent(appId)))return;
  try {
   if(!reply.ok())throw new Error('App activity read refused: '+reply.status());
   const body=await reply.json();assert(Array.isArray(body.activity));
   if(!closed)rows=body.activity;
  }catch(error){if(!closed)failure=error;}
 };
 page.on('response',response);
 async function until(predicate,timeout=180000){
  const deadline=Date.now()+timeout;
  while(true){
   if(failure)throw failure;
   if(rows!==null){const result=predicate(rows);if(result)return result;}
   assert(Date.now()<deadline,'exact App turn did not reach expected state');
   await page.waitForTimeout(250);
  }
 }
 return {
  async idle(){await until(rows=>rows.every(row=>!row.canStop));return new Set(rows.map(row=>row.id));},
  async next(before,agent){return until(rows=>{
   const fresh=rows.filter(row=>row.agent===agent&&!before.has(row.id));
   assert(fresh.length<=1,'multiple new turns: acceptance is not isolated');return fresh[0];
  });},
  state(id,state,timeout){return until(rows=>rows.find(row=>row.id===id&&row.state===state),timeout);},
  snapshot(){return rows;},
  close(){closed=true;page.off('response',response);},
 };
}
