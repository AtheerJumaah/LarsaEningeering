// Isolated browser/API fault tests: no production secrets, accounts, or writes.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
assert.ok(existsSync(executablePath));
const user = {id:'attendance-browser-test',name:'Attendance Browser Test',email:'attendance@example.invalid',role:'Engineer',access:'Engineer',enabled:true,active:true};
let staff={users:[user],logs:[]}; let stamp=new Date().toISOString();
const events=[]; let delay=0; let fail=false; let authSignOutCalls=0; const ids=[]; const passed=[];
const browser=await chromium.launch({executablePath,headless:true});
const context=await browser.newContext({serviceWorkers:'block'});
await context.route('**/*.supabase.co/**',async route=>{
  const req=route.request(); const url=new URL(req.url());
  let body=[];
  if(url.pathname.includes('/auth/')) {
    if(url.pathname.endsWith('/logout')) authSignOutCalls++;
    const payload=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,sub:'00000000-0000-4000-8000-000000000001',role:'authenticated'})).toString('base64url');
    body={access_token:`eyJhbGciOiJIUzI1NiJ9.${payload}.test`,refresh_token:'test',token_type:'bearer',expires_in:3600,user:{id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',is_anonymous:false}};
  } else if(url.pathname.endsWith('/rpc/server_now')) body=new Date().toISOString();
  else if(url.pathname.endsWith('/rpc/record_attendance_action')) {
    const p=req.postDataJSON(); ids.push(p.p_client_event_id);
    if(fail){await route.abort('failed');return;}
    let event=events.find(e=>e.client_event_id===p.p_client_event_id);
    let outcome='recorded';
    if(!event){
      const latest=events.filter(e=>e.uid===p.p_uid && (p.p_status.startsWith('Break') || ['In','Out'].includes(e.status))).at(-1);
      if(latest?.status===p.p_status){event=latest;outcome='already';}
      else {event={client_event_id:p.p_client_event_id,occurred_at:p.p_occurred_at,uid:p.p_uid,status:p.p_status,work_mode:p.p_work_mode,note:p.p_note};events.push(event);}
    }
    body=[{outcome,current_status:event.status,current_at:event.occurred_at,event_id:event.client_event_id,current_work_mode:event.work_mode,current_note:event.note}];
    if(delay)await new Promise(r=>setTimeout(r,delay));
  } else if(url.pathname.endsWith('/rpc/app_state_put')) {
    const p=req.postDataJSON();if(p.p_store_key==='larsaStaffV8'){staff=p.p_data;stamp=new Date().toISOString();}
    body=[{applied:true,current_data:p.p_store_key==='larsaStaffV8'?staff:p.p_data,current_updated_at:stamp}];
  } else if(url.pathname.endsWith('/app_state')) {
    const key=url.searchParams.get('store_key');
    if(key?.startsWith('eq.'))body={data:key==='eq.larsaStaffV8'?staff:{},updated_at:stamp};
    else body=[{store_key:'larsaStaffV8',data:staff,updated_at:stamp}];
  } else if(url.pathname.endsWith('/attendance_events'))body=events;
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body),headers:{'access-control-allow-origin':'*'}}).catch(()=>{});
});
await context.addInitScript(user=>{
  const original=Storage.prototype.setItem;
  Storage.prototype.setItem=function(k,v){if(window.__attendanceQuotaFail && k.startsWith('larsaAttendancePunchQueueV1:'))throw new DOMException('quota','QuotaExceededError');return original.call(this,k,v);};
  if(!localStorage.getItem('larsaStaffV8'))localStorage.setItem('larsaStaffV8',JSON.stringify({users:[user],logs:[]}));
  sessionStorage.setItem('larsa-control-session',JSON.stringify({user,method:'pin'}));
},user);
async function clockPage(){
  const page=await context.newPage();
  page.on('pageerror', error=>console.log('BROWSER ERROR',error.message));
  await page.goto(process.env.SMOKE_URL||'http://localhost:5199/',{waitUntil:'load'});
  try { await page.locator('.native.active button.clock-punch').waitFor({timeout:20000}); }
  catch(error) { console.log((await page.locator('body').innerText()).slice(0,5000)); console.log(await page.evaluate(()=>({session:sessionStorage.getItem('larsa-control-session'),users:JSON.parse(localStorage.getItem('larsaStaffV8')||'{}').users})));throw error; }
  await page.locator('.native.active button.clock-punch').waitFor();return page;
}
const label=page=>page.locator('.native.active button.clock-punch');
const waitLabel=(page,text)=>page.waitForFunction(text=>document.querySelector('.native.active button.clock-punch')?.textContent.includes(text),text,{timeout:20000});
const waitForEventCount=async count=>{const deadline=Date.now()+12000;while(events.length<count&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));assert.equal(events.length,count);};
try {
  const page=await clockPage();
  await waitLabel(page,'Clock In');
  delay=1200;
  await label(page).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.native.active button.clock-punch')?.disabled), null, {timeout:2000});
  assert.equal(await label(page).isDisabled(),true,'saving disables duplicate presses');
  await waitLabel(page,'Clock Out');assert.equal(events.length,1);passed.push('one slow deliberate In, immediate Saving, no duplicate');delay=0;
  await page.getByRole('button',{name:'Start Break',exact:true}).click();
  await page.getByRole('button',{name:'End Break',exact:true}).waitFor();
  await page.getByRole('button',{name:'End Break',exact:true}).click();
  await page.getByRole('button',{name:'Start Break',exact:true}).waitFor();
  assert.deepEqual(events.map(e=>e.status),['In','Break Start','Break End']);passed.push('server-confirmed break start/end');
  const second=await clockPage();await waitLabel(second,'Clock Out');
  await label(page).click();await waitLabel(page,'Clock In');
  await second.bringToFront();await waitLabel(second,'Clock In');assert.equal(events.at(-1).status,'Out');passed.push('second tab automatically reflects Out without reload');
  fail=true;await label(second).click();
  await second.getByText(/Pending synchronization: 1 action/).waitFor();await waitLabel(second,'Clock Out');
  assert.equal(events.length,4);const pendingId=ids.at(-1);
  fail=false;await second.evaluate(()=>window.dispatchEvent(new Event('online')));await waitLabel(second,'Clock Out');
  await second.waitForFunction(()=>JSON.parse(localStorage.getItem('larsaAttendancePunchQueueV1:attendance-browser-test')||'[]').length===0,{timeout:20000});
  assert.equal(events.length,5);assert.equal(events.at(-1).client_event_id,pendingId);passed.push('offline action pending, reconnect uses same ID and original time');
  delay=9500;const before=events.length;await label(second).click();
  await second.getByText(/Pending synchronization: 1 action/).waitFor({timeout:15000});
  await waitForEventCount(before+1);const committedId=events.at(-1).client_event_id;
  delay=0;await second.evaluate(()=>window.dispatchEvent(new Event('online')));
  await waitLabel(second,'Clock In');assert.equal(events.length,before+1);
  await second.waitForFunction(()=>JSON.parse(localStorage.getItem('larsaAttendancePunchQueueV1:attendance-browser-test')||'[]').length===0);
  assert.equal(ids.at(-1),committedId);passed.push('timeout after server commit: retry returns same event, no duplicate');
  await second.reload();await waitLabel(second,'Clock In');
  assert.equal(events.length,6);passed.push('refresh does not punch and preserves final status');
  // Storage quota failure must not claim success or send an unqueued request.
  await second.waitForFunction(()=>Boolean(localStorage.getItem('larsaSupabaseBridgeV1')));
  await second.evaluate(()=>{window.__attendanceQuotaFail=true;});
  await label(second).click();
  try { await waitLabel(second,'Clock In'); }
  catch(error) {console.log('STORAGE TEST STATE',events.length,await second.evaluate(()=>({label:document.querySelector('.clock-punch')?.textContent,queue:localStorage.getItem('larsaAttendancePunchQueueV1:attendance-browser-test'),patch:Storage.prototype.setItem.toString(),message:document.body.innerText.slice(-1400)})));throw error;}
  assert.equal(events.length,6);passed.push('pending storage failure prevents an unsafe punch');
  await second.evaluate(()=>{window.__attendanceQuotaFail=false;});
  await label(second).click();await waitLabel(second,'Clock Out');
  delay=1200;
  await second.getByRole('button',{name:'Start Break',exact:true}).click();
  await label(second).click();
  await second.waitForFunction(()=>{
    const queue=JSON.parse(localStorage.getItem('larsaAttendancePunchQueueV1:attendance-browser-test')||'[]');
    return queue.some(event=>event.status==='Out');
  },null,{timeout:5000});
  delay=0;
  await second.waitForFunction(()=>JSON.parse(localStorage.getItem('larsaAttendancePunchQueueV1:attendance-browser-test')||'[]').length===0,{timeout:20000});
  await waitLabel(second,'Clock In');
  assert.deepEqual(events.slice(-3).map(e=>e.status),['In','Break Start','Out']);
  passed.push('deliberate Out during slow break save is queued once and confirmed in order');
  const logoutRequest=second.waitForRequest(request=>new URL(request.url()).pathname.endsWith('/logout'));
  await second.getByRole('button',{name:'Sign out'}).last().click();
  await second.waitForFunction(()=>!sessionStorage.getItem('larsa-control-session'));
  await logoutRequest;
  assert.equal(authSignOutCalls,1);passed.push('sign-out clears the local shell and calls Supabase Auth logout');
  console.log(JSON.stringify({passed,events:events.length,finalStatus:events.at(-1).status},null,2));
} finally {await browser.close();}
