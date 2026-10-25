// Execute the deployed-handler source against an in-memory database. No email
// or production mutation is allowed from these regressions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const HOUR=3_600_000;
const now=Date.parse('2026-10-25T12:00:00Z');
const base={enabled:true,engineer_hours:72,privileged_hours:48,force_relogin:true,initial_verification_required:true,pin_verification_required:true,pin_hours:168,interval_unit:'hours'};
function fixture(name,{policy={},age=1,exempt=false,failedTable='',ownerEmail='person@example.invalid'}={}){
  let handler;const writes=[];
  const proof=age===null?null:new Date(now-age*HOUR).toISOString();
  const db={from(table){
    const filters=[];let mutation=null;
    const query={select(){return this},eq(k,v){filters.push([k,v]);return this},is(){return this},lt(){return this},order(){return this},limit(){return this},maybeSingle(){return this},
      update(v){mutation=v;return this},upsert(v){mutation=v;return this},delete(){return this},
      then(resolve,reject){
        if(mutation)writes.push({table,value:mutation});
        let data=null;
        if(table==='auth_policy')data={...base,...policy};
        if(table==='user_verification'&&!mutation)data=[{last_periodic_email_verified_at:proof,verification_exempt:exempt}];
        if(table==='auth_codes'&&!mutation)data={id:'code-id',code:'123456',attempts:0,expires_at:new Date(now+HOUR).toISOString()};
        if(table==='app_state')data={data:{users:[{id:'person',email:ownerEmail}]}};
        return Promise.resolve({data,error:table===failedTable?{message:'simulated unavailable'}:null}).then(resolve,reject);
      }};
    return query;
  }};
  const source=readFileSync(new URL(`../supabase/functions/${name}/index.ts`,import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  class FixedDate extends Date {constructor(...args){super(...args.length?args:[now])}static now(){return now}}
  vm.runInNewContext(compiled,{createClient:()=>db,Deno:{env:{get:()=>''},serve:fn=>{handler=fn}},Response,Request,Date:FixedDate,console,fetch:()=>{throw Error('Unexpected network call')}});
  return {writes,async call(body){return (await handler(new Request('https://fixture.invalid',{method:'POST',body:JSON.stringify({op:'status',userId:'person',email:'person@example.invalid',role:'Engineer',...body})}))).json()}};
}
test('employee and privileged expiry use the configured intervals and genuine server proof',async()=>{
  assert.equal((await fixture('auth-policy',{age:71.99}).call({})).required,false);
  assert.equal((await fixture('auth-policy',{age:72}).call({})).required,true);
  for(const access of ['Admin','Super Admin','Accountant','Finance']){
    assert.equal((await fixture('auth-policy',{age:48}).call({access})).required,true,access);
    assert.equal((await fixture('auth-policy',{age:47}).call({access})).required,false,access);
  }
});
test('PIN follows its own hours even when email intervals are in days',async()=>{
  const f=fixture('auth-policy',{age:169,policy:{interval_unit:'days'}});
  assert.equal((await f.call({method:'pin'})).required,true);
  assert.equal((await f.call({method:'email'})).required,false);
  assert.equal((await fixture('auth-policy',{age:167.99}).call({method:'pin'})).required,false);
});
test('policy switches, first verification, per-role off, and explicit exemptions are honored',async()=>{
  for(const method of ['email','pin']){
    assert.equal((await fixture('auth-policy',{age:null,policy:{enabled:false}}).call({method})).required,false);
    assert.equal((await fixture('auth-policy',{age:9999,exempt:true}).call({method})).required,false);
  }
  assert.equal((await fixture('auth-policy',{age:null,policy:{pin_verification_required:false}}).call({method:'pin'})).required,false);
  assert.equal((await fixture('auth-policy',{age:null,policy:{engineer_hours:null}}).call({})).required,true);
  assert.equal((await fixture('auth-policy',{age:null,policy:{engineer_hours:null,initial_verification_required:false}}).call({})).required,false);
  assert.equal((await fixture('auth-policy',{age:999,policy:{engineer_hours:null}}).call({})).required,false);
});
test('business days use Baghdad Sunday–Thursday; weekend days do not expire proof',async()=>{
  // Sunday 25 Oct minus 72h = Thursday; only Sunday is a new business day.
  assert.equal((await fixture('auth-policy',{age:72,policy:{interval_unit:'business_days',engineer_hours:2}}).call({})).required,false);
  assert.equal((await fixture('auth-policy',{age:72,policy:{interval_unit:'business_days',engineer_hours:1}}).call({})).required,true);
});
test('a failed verification lookup is unavailable, not an expired or exempt verdict',async()=>{
  assert.equal((await fixture('auth-policy',{failedTable:'user_verification'}).call({})).ok,false);
});
test('accepted email code persists proof before reporting success',async()=>{
  const f=fixture('auth-code');assert.equal((await f.call({op:'verify',purpose:'verify',code:'123456'})).ok,true);
  assert.deepEqual(f.writes.map(w=>w.table),['user_verification','auth_codes']);
  assert.equal(f.writes[0].value.normalized_email,'person@example.invalid');
});
test('stamp failure keeps code retryable and cannot claim successful verification',async()=>{
  const f=fixture('auth-code',{failedTable:'user_verification'});
  const result=await f.call({op:'verify',purpose:'verify',code:'123456'});
  assert.equal(result.ok,false);assert.match(result.error,/retry/i);
  assert.equal(f.writes.some(w=>w.table==='auth_codes'&&w.value.consumed_at),false);
});
test('another account and incorrect codes never renew a verification interval',async()=>{
  for(const options of [{ownerEmail:'other@example.invalid'},{}]){
    const f=fixture('auth-code',options);
    assert.equal((await f.call({op:'verify',purpose:'verify',code:options.ownerEmail?'123456':'000000'})).ok,false);
    assert.equal(f.writes.some(w=>w.table==='user_verification'),false);
  }
});
test('password reset does not silently renew periodic email verification',async()=>{
  const f=fixture('auth-code');assert.equal((await f.call({op:'verify',purpose:'reset',code:'123456'})).ok,true);
  assert.deepEqual(f.writes.map(w=>w.table),['auth_codes']);
});
