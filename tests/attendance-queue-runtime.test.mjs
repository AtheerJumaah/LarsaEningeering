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
  const events=[];const confirmCalls=[];const recovery=[];let release;
  const context=vm.createContext({useCallback:fn=>fn,sessionUserRef:{current:user},punchLock:{current:false},attendanceCommittedEventIds:{current:new Set()},accessUsers:[user],
    attendancePunchQueueKey:uid=>'queue:'+uid,attendanceAuthBlockedKey:uid=>'larsaAttendanceAuthBlockedV1:'+uid,parseStore:key=>JSON.parse(data.get(key)||'null'),
    localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)},serverNowIso:()=>new Date().toISOString(),serverNowMs:()=>Date.now(),
    confirmClockState:async(...args)=>{confirmCalls.push(args);return confirmation;},
    notify(){},pushSyncedKeyNow(){},refreshStaffEngine(){},setStorageTick(){},
    setAttendanceAuthRecovery:value=>recovery.push(value),
    recordAttendancePunch:async event=>{
      events.push(event);
      if(events.length===1)await new Promise(resolve=>{release=resolve;});
      return review&&events.length===1?{outcome:'needs_review'}:{outcome:'recorded',status:event.status,at:event.occurred_at,eventId:event.client_event_id};
    },
  });
  vm.runInContext(ts.transpileModule(`const ${declarations.get('punchClock')};const ${declarations.get('punchClockGuarded')};this.guard=punchClockGuarded;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {context,data,events,confirmCalls,recovery,release:()=>release()};
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

test('a forbidden Auth identity is held for review and removed from the retry queue',async()=>{
  const w=writer();
  w.context.recordAttendancePunch=async()=>({outcome:'forbidden',reason:'anonymous_session'});
  const result=await w.context.guard('Office','anonymous attempt','In');
  assert.equal(result,false);
  assert.equal(w.data.has('queue:e'),true);
  assert.equal(JSON.parse(w.data.get('queue:e')).length,0);
  const denied=JSON.parse(w.data.get('larsaAttendanceAuthBlockedV1:e'));
  assert.equal(denied.length,1);
  assert.equal(denied[0].status,'In');
  assert.match(denied[0].review_reason,/approved employee Auth/);
});

test('an expired punch hands off visibly to correction review without changing its evidence',async()=>{
  const w=writer(true);
  const pending=w.context.guard('Office','expired action','In');await settle();
  const original={...JSON.parse(w.data.get('queue:e'))[0]};
  w.release();
  assert.equal(await pending,false);
  const review=JSON.parse(w.data.get('larsaAttendancePunchReviewV1:e'));
  assert.equal(review.length,1);
  assert.equal(review[0].client_event_id,original.client_event_id);
  assert.equal(review[0].occurred_at,original.occurred_at);
  assert.equal(w.data.has('queue:e'),true);
  assert.equal(JSON.parse(w.data.get('queue:e')).length,0);
  assert.equal(w.recovery.at(-1).phase,'review');
  assert.match(w.recovery.at(-1).message,/approved correction/i);
});

function recoveryRuntime(events,{replayResult=true,authUser={id:'auth-e',is_anonymous:false},authError=null}={}){
  const page=readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8');
  const source=ts.createSourceFile('page.tsx',page,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let declaration;
  function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='replayBlockedAttendance')declaration=node.getText(source);ts.forEachChild(node,visit);}
  visit(source);assert.ok(declaration);
  const data=new Map([['larsaAttendanceAuthBlockedV1:e',JSON.stringify(events)] ]);
  const phases=[];const replayed=[];const notices=[];
  const context=vm.createContext({useCallback:fn=>fn,sessionUserRef:{current:{id:'e'}},attendanceAuthRecoveryLock:{current:false},attendanceAuthRecoveryTimer:{current:null},attendanceAuthReplayEventLock:{current:null},attendanceCommittedEventIds:{current:new Set()},
    attendanceAuthBlockedKey:uid=>'larsaAttendanceAuthBlockedV1:'+uid,attendancePunchQueueKey:uid=>'larsaAttendancePunchQueueV1:'+uid,parseStore:key=>JSON.parse(data.get(key)||'null'),
    setAttendanceAuthRecovery:value=>phases.push(value),getSupabaseClient:()=>({auth:{getUser:async()=>({data:{user:authUser},error:authError})}}),
    localStorage:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k)},
    punchClockGuarded:async(_mode,_note,_intent,_quiet,uid)=>{replayed.push(data.get('larsaAttendanceAuthBlockedV1:'+uid)?JSON.parse(data.get('larsaAttendanceAuthBlockedV1:'+uid))[0]:events[0]);return replayResult;},
    notify:message=>notices.push(message),
  });
  vm.runInContext(ts.transpileModule(`const ${declaration};this.replay=replayBlockedAttendance;`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return {context,data,phases,replayed,notices};
}

test('verified Auth replay drains blocked actions in order exactly once with original id and time',async()=>{
  const held=[
    {client_event_id:'blocked-1',occurred_at:'2026-10-12T09:00:00Z',uid:'e',status:'In'},
    {client_event_id:'blocked-2',occurred_at:'2026-10-12T17:00:00Z',uid:'e',status:'Out'},
  ];
  const w=recoveryRuntime(held);
  assert.equal(await w.context.replay(),true);
  assert.deepEqual(w.replayed.map(event=>[event.client_event_id,event.occurred_at]),held.map(event=>[event.client_event_id,event.occurred_at]));
  assert.equal(w.data.has('larsaAttendanceAuthBlockedV1:e'),false);
  assert.deepEqual(w.phases.filter(Boolean).map(phase=>phase.phase),['checking','replaying','replaying']);
  assert.equal(await w.context.replay(),false,'an empty hold must not replay a second time');
  assert.equal(w.replayed.length,2);
});

test('failed Auth recovery keeps the hold and never reports false success',async()=>{
  const held=[{client_event_id:'blocked-failed',occurred_at:'2026-10-12T09:00:00Z',uid:'e',status:'In'}];
  const w=recoveryRuntime(held,{replayResult:false});
  assert.equal(await w.context.replay(),false);
  assert.equal(JSON.parse(w.data.get('larsaAttendanceAuthBlockedV1:e')).length,1);
  assert.equal(w.phases.at(-1).phase,'blocked');
  assert.equal(w.notices.some(message=>/completed/i.test(message)),false);
});

test('Auth lookup failure leaves the original hold visible and untouched',async()=>{
  const held=[{client_event_id:'blocked-auth-error',occurred_at:'2026-10-12T09:00:00Z',uid:'e',status:'In'}];
  const w=recoveryRuntime(held,{authUser:null,authError:{message:'offline'}});
  assert.equal(await w.context.replay(),false);
  assert.deepEqual(JSON.parse(w.data.get('larsaAttendanceAuthBlockedV1:e')),held);
  assert.equal(w.replayed.length,0);
  assert.equal(w.phases.at(-1).phase,'blocked');
});

test('server authorization denial goes to review and does not retry forever',async()=>{
  const w=writer();
  w.context.recordAttendancePunch=async()=>({outcome:'forbidden',reason:'server_authorization'});
  const result=await w.context.guard('Office','RLS denied','In');
  assert.equal(result,false);
  assert.equal(JSON.parse(w.data.get('larsaAttendancePunchReviewV1:e')).length,1);
  assert.equal(w.data.has('larsaAttendanceAuthBlockedV1:e'),false);
  assert.equal(JSON.parse(w.data.get('queue:e')).length,0);
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
