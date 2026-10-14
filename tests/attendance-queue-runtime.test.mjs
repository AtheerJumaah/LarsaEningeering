import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function writer(review=false, confirmation={reached:true,status:'Out'}){
  const page=readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
  const source=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const declarations=new Map();
  function visit(node){if(ts.isVariableDeclaration(node)&&['punchClock','punchClockGuarded'].includes(node.name.getText(source)))declarations.set(node.name.getText(source),node.getText(source));ts.forEachChild(node,visit);}
  visit(source);assert.equal(declarations.size,2);
  const user={id:'e',name:'Employee',enabled:true};
  const data=new Map([['larsaStaffV8',JSON.stringify({users:[user],logs:[]})]]);
  const events=[];const confirmCalls=[];let release;
  const context=vm.createContext({useCallback:fn=>fn,sessionUserRef:{current:user},punchLock:{current:false},accessUsers:[user],
    attendancePunchQueueKey:uid=>'queue:'+uid,parseStore:key=>JSON.parse(data.get(key)||'null'),
    localStorage:{setItem:(k,v)=>data.set(k,v)},serverNowIso:()=>new Date().toISOString(),serverNowMs:()=>Date.now(),
    confirmClockState:async(...args)=>{confirmCalls.push(args);return confirmation;},
    notify(){},pushSyncedKeyNow(){},refreshStaffEngine(){},setStorageTick(){},markAttendanceEventSent(){},
    recordAttendancePunch:async event=>{
      events.push(event);
      if(events.length===1)await new Promise(resolve=>{release=resolve;});
      return review&&events.length===1?{outcome:'needs_review'}:{outcome:'recorded',status:event.status,at:event.occurred_at,eventId:event.client_event_id};
    },
  });
  vm.runInContext(ts.transpileModule(`const ${declarations.get('punchClock')};const ${declarations.get('punchClockGuarded')};this.guard=punchClockGuarded;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {context,data,events,confirmCalls,release:()=>release()};
}
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
for(const review of [false,true])test(`a deliberate Out during an in-flight save survives ${review?'review rejection':'confirmation'} of the earlier event`,async()=>{
  const w=writer(review);
  const first=w.context.guard('Office','first','In');await settle();
  await w.context.guard('Office','deliberate close','Out');
  const queued=JSON.parse(w.data.get('queue:e'));
  assert.deepEqual(queued.map(e=>e.status),['In','Out']);
  const original=queued[1];w.release();await first;await settle();
  assert.deepEqual(w.events.map(e=>e.status),['In','Out']);
  assert.equal(w.events[1].client_event_id,original.client_event_id);
  assert.equal(w.events[1].occurred_at,original.occurred_at);
  assert.equal(JSON.parse(w.data.get('queue:e')).length,0);
  assert.equal(JSON.parse(w.data.get('larsaStaffV8')).logs.at(-1).status,'Out');
  if(review)assert.equal(JSON.parse(w.data.get('larsaAttendancePunchReviewV1:e')).length,1);
});

test('same-intent clicks while saving reuse the one pending event',async()=>{
  const w=writer();const first=w.context.guard('Office','first','In');await settle();
  await w.context.guard('Office','second click','In');
  assert.equal(JSON.parse(w.data.get('queue:e')).length,1);
  w.release();await first;assert.equal(w.events.length,1);
});

test('explicit In preserves the displayed intent and skips confirmation',async()=>{
  const w=writer(false,{reached:true,status:'In'});
  const pending=w.context.guard('Office','deliberate clock in','In');await settle();
  assert.equal(w.confirmCalls.length,0);
  assert.equal(w.events[0].status,'In');
  w.release();await pending;
});

test('an intent-free compatibility punch uses the confirmed server state',async()=>{
  const w=writer(false,{reached:true,status:'In'});
  const pending=w.context.guard('Office','compatibility caller');await settle();
  assert.equal(w.confirmCalls.length,1);
  assert.equal(w.confirmCalls[0][0],'e');
  assert.equal(w.confirmCalls[0][1].length,0);
  assert.equal(w.events[0].status,'Out');
  w.release();await pending;
});

test('an intent-free punch fails safely when server confirmation is unavailable',async()=>{
  const w=writer(false,{reached:false,status:null});
  const result=await w.context.guard('Office','compatibility caller');
  assert.equal(result,false);
  assert.equal(w.confirmCalls.length,1);
  assert.equal(w.events.length,0);
  assert.equal(w.data.has('queue:e'),false);
});

test('switching accounts stops the old employee queue without discarding its original Out',async()=>{
  const w=writer();const first=w.context.guard('Office','first','In');await settle();
  await w.context.guard('Office','deliberate close','Out');
  const original=JSON.parse(w.data.get('queue:e'))[1];
  w.context.sessionUserRef.current={id:'other'};w.release();await first;
  assert.equal(w.events.length,1);
  const queued=JSON.parse(w.data.get('queue:e'));assert.equal(queued.length,1);
  assert.equal(queued[0].client_event_id,original.client_event_id);
  w.context.sessionUserRef.current={id:'e',name:'Employee'};
  await w.context.guard('Office','ignored', 'Out',true);
  assert.equal(w.events.length,2);assert.equal(w.events[1].client_event_id,original.client_event_id);
});
