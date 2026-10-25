// Real browser regression with synthetic history and intercepted backend writes.
// No production account, credentials, or attendance records are changed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const user={id:'freeze-test',name:'Freeze Test',email:'freeze@example.invalid',role:'Engineer',access:'Super Admin',enabled:true,active:true};
const users=Array.from({length:26},(_,i)=>i?{...user,id:`test-${i}`,name:`Test ${i}`,email:`test-${i}@example.invalid`,access:'Engineer'}:user);
const logs=[];
for(let day=1;day<=20;day++)for(const u of users){
  const start=Date.now()-day*86400000;
  logs.push({id:`${u.id}-${day}-in`,uid:u.id,status:'In',type:'Office',time:new Date(start).toISOString(),active:false});
  logs.push({id:`${u.id}-${day}-out`,uid:u.id,status:'Out',type:'Office',time:new Date(start+4*3600000).toISOString(),active:false});
}
let staff={users,logs};let stamp=new Date().toISOString();const events=[];
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--remote-debugging-port=9335']});
const watchdog=setTimeout(()=>{console.error('FAIL: browser regression exceeded 90 seconds');process.exit(1)},90000);watchdog.unref();
const context=await browser.newContext({serviceWorkers:'block',timezoneId:'America/Chicago'});
if(process.env.FAIL_REALTIME==='1'||process.argv.includes('--fail-realtime'))await context.routeWebSocket('**/realtime/**',socket=>socket.close({code:1011,reason:'Simulated network interruption'}));
await context.route('**/*.supabase.co/**',async route=>{
  const req=route.request(),url=new URL(req.url());let body=[];
  if(url.pathname.includes('/auth/')){
    const payload=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,sub:'00000000-0000-4000-8000-000000000001',role:'authenticated'})).toString('base64url');
    body={access_token:`eyJhbGciOiJIUzI1NiJ9.${payload}.test`,refresh_token:'test',token_type:'bearer',expires_in:3600,user:{id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',is_anonymous:true}};
  }else if(url.pathname.endsWith('/rpc/server_now'))body=new Date().toISOString();
  else if(url.pathname.endsWith('/rpc/record_attendance_action')){
    const p=req.postDataJSON();let e=events.find(e=>e.client_event_id===p.p_client_event_id);
    if(!e){e={client_event_id:p.p_client_event_id,occurred_at:p.p_occurred_at,uid:p.p_uid,status:p.p_status,work_mode:p.p_work_mode,inserted_at:new Date().toISOString()};events.push(e);}
    body=[{outcome:'recorded',current_status:e.status,current_at:e.occurred_at,event_id:e.client_event_id,current_work_mode:e.work_mode}];
  }else if(url.pathname.endsWith('/rpc/app_state_put')){
    const p=req.postDataJSON();if(p.p_store_key==='larsaStaffV8'){staff=p.p_data;stamp=new Date().toISOString();}
    body=[{applied:true,current_data:p.p_data,current_updated_at:stamp}];
  }else if(url.pathname.endsWith('/app_state')){
    const key=url.searchParams.get('store_key');
    body=key?.startsWith('eq.')?{data:key==='eq.larsaStaffV8'?staff:{},updated_at:stamp}:[{store_key:'larsaStaffV8',data:staff,updated_at:stamp}];
  }else if(url.pathname.endsWith('/attendance_events'))body=events;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body),headers:{'access-control-allow-origin':'*'}}).catch(()=>{});
});
await context.addInitScript(({user,staff,debug})=>{
  if(!localStorage.getItem('larsaStaffV8'))localStorage.setItem('larsaStaffV8',JSON.stringify(staff));
  if(!sessionStorage.getItem('larsa-control-session'))sessionStorage.setItem('larsa-control-session',JSON.stringify({user,method:'pin'}));
  window.__formatterCount=0;window.__localeCount=0;window.__longTasks=[];
  for(const name of ['toLocaleString','toLocaleDateString','toLocaleTimeString']){const original=Date.prototype[name];Date.prototype[name]=function(...args){window.__localeCount++;return original.apply(this,args)}}
  const Real=Intl.DateTimeFormat;
  Intl.DateTimeFormat=new Proxy(Real,{construct(target,args){window.__formatterCount++;return Reflect.construct(target,args);},apply(target,self,args){window.__formatterCount++;return Reflect.apply(target,self,args);}});
  new PerformanceObserver(list=>window.__longTasks.push(...list.getEntries().map(e=>Math.round(e.duration)))).observe({type:'longtask',buffered:true});
  if(debug){for(const name of ['setTimeout','setInterval']){const native=window[name];window[name]=function(fn,delay,...args){if(typeof fn!=='function')return native(fn,delay,...args);const label=fn.name||String(fn).slice(0,80);return native(()=>{console.log('TASK BEGIN',name,delay,label);try{return fn(...args)}finally{console.log('TASK END',name,delay,label)}},delay)}}}
},{user,staff,debug:process.argv.includes('--debug')});
const start=Date.now();
let page;
try{
  page=await context.newPage();page.on('console',message=>{if(message.text().startsWith('TASK '))console.log(message.text())});page.on('crash',()=>console.error('BROWSER PAGE CRASHED'));let errors=0;const fatalErrors=[];page.on('pageerror',e=>{fatalErrors.push(e.message);if(errors++<3)console.log('PAGE ERROR',e.stack);});
  await page.goto(process.argv[2]||process.env.SMOKE_URL||'https://larsaeng.app/',{waitUntil:'domcontentloaded',timeout:30000});
  const button=()=>page.locator('.native.active .clock-punch');
  await button().waitFor({timeout:30000});
  const baseline=await page.evaluate(()=>({formatters:window.__formatterCount,longTasks:window.__longTasks,frames:document.querySelectorAll('iframe').length}));
  console.log('BASELINE',JSON.stringify({elapsed:Date.now()-start,...baseline}));
  const cycles=Number(process.env.FREEZE_CYCLES||12);
  for(let i=0;i<cycles;i++){
    console.log('BEGIN PUNCH',i+1);
    const before=Date.now();const expected=i%2?'Clock In':'Clock Out';
    await button().click({timeout:20000});
    const clickMs=Date.now()-before;
    await page.waitForFunction(expected=>document.querySelector('.native.active .clock-punch')?.textContent.includes(expected),expected,{timeout:20000});
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('larsaAttendancePunchQueueV1:freeze-test')||'[]').length===0,null,{timeout:20000});
    const confirmedMs=Date.now()-before;
    await page.waitForTimeout(1500);
    const metrics=await page.evaluate(()=>({formatters:window.__formatterCount,locales:window.__localeCount,longTasks:window.__longTasks.slice(-8),heap:performance.memory?.usedJSHeapSize}));
    console.log('PUNCH',JSON.stringify({i:i+1,clickMs,confirmedMs,elapsed:Date.now()-before,...metrics}));
  }
  await page.close();page=await context.newPage();
  page.on('pageerror',error=>fatalErrors.push(error.message));
  await page.goto(process.argv[2]||process.env.SMOKE_URL||'https://larsaeng.app/',{waitUntil:'domcontentloaded'});
  await button().waitFor({timeout:30000});
  await page.waitForTimeout(6000);
  assert.equal(events.length,cycles);
  const result=await page.evaluate(()=>({formatters:window.__formatterCount,longTasks:window.__longTasks,heap:performance.memory?.usedJSHeapSize}));
  console.log('REOPEN',JSON.stringify({events:events.length,...result}));
  // The shift timer must keep ticking while disconnected realtime falls back
  // to REST, and Clock Out must still accept the following deliberate action.
  await button().click();
  await page.waitForFunction(()=>document.querySelector('.clock-punch')?.textContent.includes('Clock Out'));
  await page.waitForTimeout(5500);
  const timerBefore=await page.locator('[data-attendance-readout]').innerText();
  await page.waitForTimeout(1200);
  const timerAfter=await page.locator('[data-attendance-readout]').innerText();
  assert.notEqual(timerBefore,timerAfter,'shift timer must continue after reconnect/reopen');
  await button().click();
  await page.waitForFunction(()=>document.querySelector('.clock-punch')?.textContent.includes('Clock In'));
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('larsaAttendancePunchQueueV1:freeze-test')||'[]').length===0);
  assert.equal(events.length,cycles+2);assert.equal(new Set(events.map(event=>event.client_event_id)).size,events.length);
  console.log('FINAL',JSON.stringify({events:events.length,timerBefore,timerAfter,finalStatus:events.at(-1).status}));
  assert.deepEqual(fatalErrors,[],'no runtime failures during punches or network recovery');
  if(process.env.ASSERT_FORMATTER_BUDGET==='1')assert.ok(result.formatters<200,`timezone formatter allocation budget exceeded: ${result.formatters}`);
}finally{await browser.close();clearTimeout(watchdog);}
