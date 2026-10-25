import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {isSuspiciousClosedSession, OPEN_SESSION_STALE_HOURS} from '../lib/attendance.mjs';
import {planAttendanceCorrection} from '../lib/attendance-corrections.mjs';
import {ATTENDANCE_TIME_ZONE, splitAttendanceInterval} from '../lib/attendance-timezone.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function runtime(path, client, seed = {}) {
  const data = new Map(Object.entries(seed));
  const timers = [];
  const listeners = new Map();
  const localStorage = { getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,String(v)), removeItem: k => data.delete(k) };
  const events = { addEventListener: (k,f) => listeners.set(k,f), removeEventListener: k => listeners.delete(k) };
  const exports = {};
  const context = vm.createContext({ exports, module: { exports }, console: { log(){},warn(){},error(){} },
    require: name => name.includes('client') ? { getSupabaseClient: () => client, supabaseConfigured: () => true }
      : name.includes('merge') ? { mergeStoreText: (_base,local,remote) => ({...remote,...JSON.parse(local)}), protectOutgoing: x => x }
      : name.includes('push-queue') ? { createPushQueue: (pushOnce, isDirty) => {
        const active = new Map();
        const push = async key => {
          const existing = active.get(key);
          if (existing) await existing;
          else {
            const task = pushOnce(key); active.set(key, task);
            try { await task; } finally { if (active.get(key) === task) active.delete(key); }
          }
          if (isDirty(key)) return push(key);
        };
        return push;
      } }
      : (() => {throw new Error(name)})(),
    localStorage, window: { localStorage, ...events }, document: { hidden: false, ...events },
    navigator: { onLine: true }, Date, Map, Set, Promise, AbortController,
    setTimeout: (fn,ms) => { timers.push({fn,ms,interval:false}); return timers.length; }, clearTimeout(){},
    setInterval: (fn,ms) => { timers.push({fn,ms,interval:true}); return timers.length; }, clearInterval(){},
  });
  context.window.setInterval = context.setInterval;
  context.window.clearInterval = context.clearInterval;
  context.window.setTimeout = context.setTimeout;
  context.window.clearTimeout = context.clearTimeout;
  vm.runInContext(ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { api: exports, data, listeners, timers, context };
}
const settle = async () => { for (let i=0;i<20;i++) await new Promise(r=>setImmediate(r)); };

test('attendance channel removal tolerates synchronous CLOSED callbacks and backs off retries', async()=>{
  const channels=[];const removed=[];
  const client={
    auth:{getSession:async()=>({data:{session:{}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
    from(){throw new Error('no pending queue')},
    channel(){const channel={on(){return channel},subscribe(callback){channel.status=callback;return channel}};channels.push(channel);return channel},
    removeChannel(channel){removed.push(channel);assert.ok(removed.length<10,'recursive channel removal');channel.status('CLOSED');return Promise.resolve('ok')},
  };
  const r=runtime('lib/ledger.ts',client);const cleanup=r.api.initAttendanceLedger();await settle();
  assert.equal(channels.length,1);
  channels[0].status('CHANNEL_ERROR');channels[0].status('CLOSED');
  assert.equal(removed.length,1);
  const first=r.timers.find(timer=>timer.ms===1000&&!timer.interval);assert.ok(first);first.fn();await settle();
  assert.equal(channels.length,2);
  channels[0].status('CLOSED');assert.equal(removed.length,1,'old callbacks cannot remove the replacement');
  channels[1].status('TIMED_OUT');assert.equal(removed.length,2);
  const second=r.timers.find(timer=>timer.ms===2000&&!timer.interval);assert.ok(second);second.fn();await settle();
  channels[2].status('SUBSCRIBED');channels[2].status('CLOSED');
  assert.equal(r.timers.filter(timer=>timer.ms===1000&&!timer.interval).length,2,'a healthy subscription resets retry backoff');
  cleanup();
});
function server() {
  let failing = true;
  const rows = { larsaStaffV8: { users:[{id:'employee'}], logs:[] } };
  let subscriptions=0;
  const client = {
    auth: { getSession: async()=>({data:{session:{user:{id:'anonymous'}}}}), signInAnonymously: async()=>({error:null}) },
    rpc: async()=>({data:new Date().toISOString(),error:null}),
    from() {
      let key;
      const q = { select(){return q},eq(_field,value){key=value;return q},in(){return q},
        maybeSingle: async()=>failing ? {error:new Error('offline')} : {data:{data:rows[key]||{},updated_at:'2026-10-12T00:00:00Z'},error:null},
        then(resolve){return Promise.resolve(failing ? {error:new Error('offline')} : {data:Object.keys(rows).map(store_key=>({store_key,updated_at:'2026-10-12T00:00:00Z',data:rows[store_key]})),error:null}).then(resolve)},
      };return q;
    },
    channel(){const q={on(){return q},subscribe(){subscriptions++;return q}};return q}, removeChannel(){},
  };
  return {client,online:()=>{failing=false},subscriptions:()=>subscriptions};
}

test('failed startup sync recovers and subscribes when the app regains focus', async()=>{
  const s=server(); const r=runtime('lib/supabase/sync.ts',s.client);
  const statuses=[]; const cleanup=r.api.initLarsaSync({onStatusChange:s=>statuses.push(s)});
  await settle();assert.ok(statuses.includes('offline'));
  s.online();
  r.listeners.get('focus')?.();
  await settle();
  assert.equal(s.subscriptions(),1,'successful recovery must establish realtime');
  assert.equal(JSON.parse(r.data.get('larsaStaffV8')).users[0].id,'employee');
  assert.equal(statuses.at(-1),'synced');cleanup();
});

test('shared-state saves serialize per key and preserve edits made during a slow save',async()=>{
  const s=server();s.online();const calls=[];let release;
  const oldRpc=s.client.rpc;
  s.client.rpc=(name,p)=>{
    if(name!=='app_state_put')return oldRpc(name,p);
    calls.push(p);
    if(calls.length===1)return new Promise(resolve=>{release=()=>resolve({data:[{applied:true,current_data:p.p_data,current_updated_at:'2026-10-12T00:01:00Z'}]});});
    return Promise.resolve({data:[{applied:true,current_data:p.p_data,current_updated_at:'2026-10-12T00:02:00Z'}]});
  };
  const r=runtime('lib/supabase/sync.ts',s.client);const cleanup=r.api.initLarsaSync();await settle();
  r.context.localStorage.setItem('larsaStaffV8',JSON.stringify({users:[{id:'employee'}],logs:[{id:'first'}]}));
  const firstPush = r.api.pushSyncedKeyNow('larsaStaffV8');await settle();
  r.context.localStorage.setItem('larsaStaffV8',JSON.stringify({users:[{id:'employee'}],logs:[{id:'first'},{id:'second'}]}));
  const secondPush = r.api.pushSyncedKeyNow('larsaStaffV8');await settle();
  assert.equal(calls.length,1,'a slow shared row must not accumulate overlapping writes');
  release();await Promise.all([firstPush, secondPush]);await settle();
  assert.equal(calls.length,2);assert.equal(calls[1].p_data.logs.length,2);
  assert.equal(JSON.parse(r.data.get('larsaStaffV8')).logs.length,2);cleanup();
});

test('opening the app does not upload cached historical punches as new live events', async()=>{
  const inserted=[];
  const client={from(){return {upsert:async rows=>{inserted.push(...rows);return {error:null}}}}};
  const r=runtime('lib/ledger.ts',client,{larsaStaffV8:JSON.stringify({users:[],logs:[{id:'old',uid:'employee',status:'In',time:'2026-08-05T09:00:00Z'}]})});
  const cleanup=r.api.initAttendanceLedger();await settle();
  assert.equal(inserted.length,0,'startup is a read/recovery operation, not a punch');cleanup();
});

test('the packed clock passes employee identity before consulting stale state',()=>{
  const raw=read('public/engines/timeclock.html');
  const engine=JSON.parse(raw.split('\n').find(l=>l.startsWith('"<!DOCTYPE html>')));
  const start=engine.indexOf('function clockToggle(');
  const end=engine.indexOf('\nfunction ',start+1);
  const source=engine.slice(start,end);
  const calls=[];
  const context=vm.createContext({currentUser:{id:'employee'},window:{__larsaPendingNote:'test'},
    freshState:()=>{},lastPunchOf:()=>({status:'Out'}),toast(){},render(){},
    larsaAppPunch:()=> (...args)=>calls.push(args),setTimeout(){},console});
  vm.runInContext(source,context);
  context.clockToggle('Office','Out');
  assert.equal(calls.length,1,'stale iframe must not refuse before server writer');
  assert.deepEqual(Array.from(calls[0]),['Office','Out','test','employee']);
});

test('confirmed punch client distinguishes a missing RPC from an offline connection',async()=>{
  const client={auth:{getSession:async()=>({data:{session:{}}})},rpc:()=>({abortSignal:async()=>({error:{code:'PGRST202',message:'function unavailable'}})})};
  const r=runtime('lib/attendance-punch.ts',client);
  const result=await r.api.recordAttendancePunch({client_event_id:'e',uid:'employee',status:'In',occurred_at:'2026-10-12T09:00:00Z'});
  assert.equal(result.outcome,'configuration_error');
});

test('consecutive punches reuse the confirmed auth session instead of adding a second lookup',async()=>{
  let sessionLookups=0, rpcCalls=0;
  const client={
    auth:{getSession:async()=>{sessionLookups++;return {data:{session:{user:{id:'anonymous'}}}};}},
    rpc:()=>{rpcCalls++;return {abortSignal:async()=>({data:{outcome:'recorded',current_status:'In',current_at:'2026-10-12T09:00:00Z'},error:null})};},
  };
  const r=runtime('lib/attendance-punch.ts',client);
  await r.api.recordAttendancePunch({client_event_id:'first',uid:'employee',status:'In',occurred_at:'2026-10-12T09:00:00Z'});
  await r.api.recordAttendancePunch({client_event_id:'second',uid:'employee',status:'Out',occurred_at:'2026-10-12T10:00:00Z'});
  assert.equal(rpcCalls,2);
  assert.equal(sessionLookups,1);
});

test('an actual auth rejection waits for the warmup and retries the same event id once',async()=>{
  let attempts=0, sessionLookups=0, payloads=[];
  const client={
    auth:{getSession:async()=>{sessionLookups++;return {data:{session:{user:{id:'anonymous'}}}};}},
    rpc:(_name,p)=>{payloads.push(p);attempts++;return {abortSignal:async()=>attempts===1
      ? {data:null,error:{code:'401',message:'JWT is missing'}}
      : {data:{outcome:'recorded',current_status:'In',current_at:'2026-10-12T09:00:00Z'},error:null}};},
  };
  const r=runtime('lib/attendance-punch.ts',client);
  const result=await r.api.recordAttendancePunch({client_event_id:'stable',uid:'employee',status:'In',occurred_at:'2026-10-12T09:00:00Z'});
  assert.equal(result.outcome,'recorded');
  assert.equal(attempts,2);
  assert.equal(sessionLookups,1);
  assert.equal(payloads[0].p_client_event_id,payloads[1].p_client_event_id);
});

test('uncertain punch timeout aborts the request, preserving original intent and event id',async()=>{
  let signal, payload;
  const client={auth:{getSession:async()=>({data:{session:{}}})},rpc:(_name,p)=>{
    payload=p;return {abortSignal:s=>{signal=s;return new Promise(()=>{});}};
  }};
  const r=runtime('lib/attendance-punch.ts',client);
  const input={client_event_id:'stable',uid:'employee',status:'Out',occurred_at:'2026-10-12T09:00:00Z'};
  const pending=r.api.recordAttendancePunch(input);await settle();
  r.timers.find(t=>t.ms===8000).fn();
  assert.equal((await pending).outcome,'unavailable');
  assert.equal(signal.aborted,true);
  assert.equal(payload.p_client_event_id,input.client_event_id);
  assert.equal(payload.p_status,'Out');assert.equal(payload.p_occurred_at,input.occurred_at);
});

test('auth warmup finishing after timeout cannot send a second abandoned punch',async()=>{
  let release,calls=0;
  const client={auth:{getSession:()=>new Promise(resolve=>{release=resolve;})},rpc:()=>{calls++;}};
  const r=runtime('lib/attendance-punch.ts',client);
  const pending=r.api.recordAttendancePunch({client_event_id:'e',uid:'employee',status:'In',occurred_at:'2026-10-12T09:00:00Z'});
  r.timers.find(t=>t.ms===8000).fn();assert.equal((await pending).outcome,'unavailable');
  release({data:{session:{}}});await settle();assert.equal(calls,1);
});

test('native correction planner refuses overlap and legacy ambiguous timezone, preserving current shift',()=>{
  const now=Date.parse('2026-10-12T18:00:00Z');
  const logs=[{uid:'e',status:'In',time:'2026-10-12T16:00:00Z'}];
  const request={id:'c',uid:'e',type:'Missed Hours',fromAt:'2026-10-11T22:00:00Z',toAt:'2026-10-12T06:00:00Z'};
  assert.equal(planAttendanceCorrection(request,logs,now).ok,true);
  assert.equal(planAttendanceCorrection({...request,fromAt:'2026-10-12T15:00:00Z',toAt:'2026-10-12T17:00:00Z'},logs,now).ok,false);
  assert.equal(planAttendanceCorrection({...request,fromAt:undefined},logs,now).ok,false);
  assert.equal(logs.length,1);assert.equal(logs[0].status,'In');
});

test('native missed-break correction must belong to a recorded shift',()=>{
  const now=Date.parse('2026-10-12T18:00:00Z');
  const logs=[{uid:'e',status:'In',time:'2026-10-12T16:00:00Z'},{uid:'e',status:'Out',time:'2026-10-12T17:00:00Z'}];
  const request={id:'c',uid:'e',type:'Missed Break',fromAt:'2026-10-12T16:20:00Z',toAt:'2026-10-12T16:40:00Z'};
  assert.equal(planAttendanceCorrection(request,logs,now).ok,true);
  assert.equal(planAttendanceCorrection({...request,toAt:'2026-10-12T17:10:00Z'},logs,now).ok,false);
});

function calculate(logs, now='2026-10-12T18:00:00Z') {
  const source=ts.createSourceFile('page.tsx',read('app/page.tsx'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='buildClockSessions');
  assert.ok(fn);
  const context=vm.createContext({Date,Map,Set,Number,isSuspiciousClosedSession,OPEN_SESSION_STALE_HOURS,ATTENDANCE_TIME_ZONE,splitAttendanceInterval,
    historyStartFor:()=>0,serverNowMs:()=>Date.parse(now),serverNowIso:()=>now,
    dateInputValue:d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`});
  vm.runInContext(ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  return Array.from(context.buildClockSessions({logs:logs.map(([status,time])=>({uid:'employee',status,time}))},[{id:'employee',name:'Test'}]));
}
const sum=rows=>rows.reduce((n,row)=>n+row.hours,0);
test('normal and multiple daily shifts preserve exact elapsed hours',()=>{
  assert.equal(sum(calculate([['In','2026-10-12T08:00Z'],['Out','2026-10-12T12:00Z'],['In','2026-10-12T13:00Z'],['Out','2026-10-12T17:00Z']])),8);
});
test('an unfinished break ends at clock-out and never deducts the next shift',()=>{
  assert.equal(sum(calculate([['In','2026-10-12T08:00Z'],['Break Start','2026-10-12T10:00Z'],['Out','2026-10-12T12:00Z'],['In','2026-10-12T13:00Z'],['Out','2026-10-12T17:00Z']])),6);
});
test('overnight shifts split into days without changing their total',()=>{
  assert.equal(sum(calculate([['In','2026-10-11T23:00Z'],['Out','2026-10-12T07:00Z']])),8);
});
test('DST transitions calculate instants rather than subtracting wall clocks',()=>{
  assert.equal(sum(calculate([['In','2026-03-08T00:00:00-06:00'],['Out','2026-03-08T04:00:00-05:00']])),3);
  assert.equal(sum(calculate([['In','2026-11-01T00:00:00-05:00'],['Out','2026-11-01T04:00:00-06:00']])),5);
});
test('forgotten and unusually long sessions are flagged, never auto-punched',()=>{
  const logs=[['In','2026-10-10T08:00Z'],['In','2026-10-11T08:00Z'],['Out','2026-10-11T17:00Z']];
  const rows=calculate(logs);assert.ok(rows.some(row=>row.unclosed));assert.equal(sum(rows),9);assert.equal(logs.length,3);
  assert.equal(sum(calculate([['In','2026-10-11T00:00Z'],['Out','2026-10-11T18:00Z']])),0);
  assert.equal(sum(calculate([['In','2026-10-09T08:00Z']])),0);
});
test('open duration follows the server-corrected clock; invalid stamps are ignored',()=>{
  assert.equal(sum(calculate([['In','2026-10-12T16:00Z']])),2);
  assert.equal(sum(calculate([['In','invalid'],['In','2026-10-12T16:00Z'],['Out','2026-10-12T17:00Z']])),1);
});

function correctionRuntime(logs=[]) {
  const raw=read('public/engines/timeclock.html');const inner=JSON.parse(raw.split('\n').find(l=>l.startsWith('"<!DOCTYPE html>')));
  const begin=inner.indexOf('function larsaStampCorrectionRequest('),end=inner.indexOf('function request(',begin);
  const context=vm.createContext({Date,Number,Intl,parseInt,localStorage:{getItem:()=>null},state:{logs},toast(){}});
  vm.runInContext(inner.slice(begin,end),context);return context;
}
test('corrections freeze instants at submission and explicitly support overnight work',()=>{
  const c=correctionRuntime();const r=c.larsaStampCorrectionRequest({id:'request',type:'Missed Clock',date:'2026-10-10',from:'22:00',to:'06:00'});
  assert.equal(Date.parse(r.toAt)-Date.parse(r.fromAt),8*3600000);assert.ok(r.timeZone);
  assert.equal(c.larsaCorrectionReady(r),true);
});
test('historical corrections cannot overlap or close an unrelated current shift',()=>{
  const now=Date.now();const logs=[{uid:'employee',status:'In',time:new Date(now-3600000).toISOString()}];
  const c=correctionRuntime(logs);
  const historical={id:'past',uid:'employee',type:'Missed Clock',fromAt:new Date(now-3*86400000).toISOString(),toAt:new Date(now-3*86400000+3600000).toISOString()};
  assert.equal(c.larsaCorrectionReady(historical),true);assert.equal(logs.length,1);assert.equal(logs[0].status,'In');
  const overlap={...historical,fromAt:new Date(now-1800000).toISOString(),toAt:new Date(now-600000).toISOString()};
  assert.equal(c.larsaCorrectionReady(overlap),false);assert.ok(overlap.materializationReview);
});
test('legacy timezone-ambiguous corrections require review instead of guessing',()=>{
  const c=correctionRuntime();const r={type:'Missed Clock',date:'2026-10-10',from:'09:00',to:'17:00'};
  assert.equal(c.larsaCorrectionReady(r),false);assert.ok(r.materializationReview);
});
