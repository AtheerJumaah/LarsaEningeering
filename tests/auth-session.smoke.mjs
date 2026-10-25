// Published UI/production build, synthetic identities, fully intercepted backend.
// These tests send no real mail and do not change any employee account.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const url=process.env.SMOKE_URL||'https://larsaeng.app/';
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const errors=[];let passed=0;
const timeout=setTimeout(()=>{console.error('Auth browser test exceeded 150 seconds');process.exit(1)},150000);timeout.unref();
async function fixture({restored,required=false,force=true,sendFails=false,lookupFails=false}={}){
  const proof=new Date(Date.now()-3_600_000).toISOString();
  const user={id:'auth-fixture',name:'Auth Fixture',email:'auth@example.invalid',password:'FixturePass42!',pin:'246810',enabled:true,active:true,access:'Super Admin',role:'Engineer',emailVerified:true,devices:[{id:'fixture-device',label:'Fixture',firstSeen:proof,lastSeen:proof,lastVerified:proof}]};
  const state={required,force,sendFails,lookupFails,sends:0,checks:[],verifyHold:null,statusHold:null};let staff={users:[user],logs:[]};
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.routeWebSocket('**/realtime/**',socket=>socket.close());
  await context.route('**/*.supabase.co/**',async route=>{
    const req=route.request(),u=new URL(req.url());let data=[];
    if(u.pathname.includes('/auth/')){
      const token=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,sub:'00000000-0000-4000-8000-000000000001',role:'authenticated'})).toString('base64url');
      data={access_token:`eyJhbGciOiJIUzI1NiJ9.${token}.test`,refresh_token:'test',token_type:'bearer',expires_in:3600,user:{id:'00000000-0000-4000-8000-000000000001',is_anonymous:true,role:'authenticated'}};
    }else if(u.pathname.endsWith('/functions/v1/auth-policy')){
      const p=req.postDataJSON(),policy={enabled:true,force_relogin:state.force,engineer_hours:72,privileged_hours:48,pin_hours:168,pin_verification_required:true,initial_verification_required:true,self_signup_enabled:true};
      if(p.op==='status'){
        state.checks.push(p.method);if(state.statusHold)await state.statusHold;
        data=state.lookupFails?{ok:false,error:'Simulated unavailable'}:{ok:true,required:state.required,exempt:false,hours:p.method==='pin'?168:48,expiresInHours:47,lastVerifiedAt:proof,policy};
      }else data={ok:true,policy};
    }else if(u.pathname.endsWith('/functions/v1/auth-code')){
      const p=req.postDataJSON();
      if(p.op==='send'){state.sends++;data=state.sendFails?{ok:false,error:'Simulated mail unavailable'}:{ok:true}}
      else {if(state.verifyHold)await state.verifyHold;data={ok:p.code==='123456'};if(data.ok)state.required=false;}
    }else if(u.pathname.endsWith('/rpc/server_now'))data=new Date().toISOString();
    else if(u.pathname.endsWith('/rpc/app_state_put')){
      const p=req.postDataJSON();if(p.p_store_key==='larsaStaffV8')staff=p.p_data;
      data=[{applied:true,current_data:p.p_data,current_updated_at:new Date().toISOString()}];
    }else if(u.pathname.endsWith('/app_state')){
      const key=u.searchParams.get('store_key');
      data=key?.startsWith('eq.')?{data:key==='eq.larsaStaffV8'?staff:{},updated_at:new Date().toISOString()}:[{store_key:'larsaStaffV8',data:staff,updated_at:new Date().toISOString()}];
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data),headers:{'access-control-allow-origin':'*'}}).catch(()=>{});
  });
  await context.addInitScript(({user,restored})=>{
    if(localStorage.getItem('auth-fixture-seeded'))return;
    localStorage.setItem('auth-fixture-seeded','1');
    localStorage.setItem('larsaStaffV8',JSON.stringify({users:[user],logs:[]}));localStorage.setItem('larsaDeviceId','fixture-device');
    if(restored){const saved=JSON.stringify({user,method:restored});sessionStorage.setItem('larsa-control-session',saved);localStorage.setItem('larsa-control-session-keep',saved);}
  },{user,restored});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'domcontentloaded'});
  const login=async(method='email')=>{
    await page.locator('#auth-tab-'+method).click();
    if(method==='email'){await page.locator('input[name=email]').fill(user.email);await page.locator('input[name=password]').fill('FixturePass42!')}
    else await page.getByPlaceholder('Enter your PIN').fill('246810');
    await page.locator('#auth-panel button[type=submit]').click();
  };
  const active=()=>page.locator('.top-signout').waitFor({timeout:15000});
  const logout=async()=>{await page.locator('.top-signout').click();await page.locator('#auth-panel button[type=submit]').waitFor();assert.deepEqual(await page.evaluate(()=>[sessionStorage.getItem('larsa-control-session'),localStorage.getItem('larsa-control-session-keep')]),[null,null])};
  const gate=()=>page.getByRole('heading',{name:'Verify your email'}).waitFor({timeout:15000});
  const verify=async()=>{await page.getByLabel('Verification Code').fill('123456');await page.getByRole('button',{name:'Verify & Sign In',exact:true}).click();await active()};
  return {page,state,proof,user,context,login,active,logout,gate,verify};
}
async function run(name,fn,options){const f=await fixture(options);try{await fn(f);passed++;console.log('PASS',name)}finally{await f.context.close()}}
try{
  await run('repeated email/PIN sign-in, immediate logout, no renewed email timestamp',async f=>{
    for(const method of ['email','email','email','pin','pin','email']){await f.login(method);await f.active();await f.logout()}
    assert.equal(f.state.sends,0);assert.ok(f.state.checks.includes('pin'));
    const stamp=await f.page.evaluate(()=>JSON.parse(localStorage.getItem('larsaStaffV8')).users[0].devices[0].lastVerified);
    assert.equal(stamp,f.proof,'password logins must not extend verified time');
    await f.page.reload();await f.page.locator('#auth-panel button[type=submit]').waitFor();await f.page.waitForTimeout(500);assert.equal(await f.page.locator('.top-signout').count(),0);
  });
  await run('expired email ignores local fresh flag; send failure stays gated and can retry',async f=>{
    await f.login();await f.gate();await f.page.getByText(/Could not send a verification code:/).waitFor();
    assert.equal(await f.page.locator('.top-signout').count(),0);
    f.state.sendFails=false;await f.page.getByRole('button',{name:'Resend Code'}).click();await f.verify();await f.logout();await f.login();await f.active();assert.equal(f.state.sends,2);
  },{required:true,sendFails:true});
  for(const method of ['email','pin'])await run(`remembered ${method} session checks expiry and cancel prevents resurrection`,async f=>{
    await f.gate();assert.ok(f.state.checks.includes(method));await f.page.getByRole('button',{name:'Cancel',exact:true}).click();await f.page.reload();await f.page.locator('#auth-panel button[type=submit]').waitFor();await f.page.waitForTimeout(500);assert.equal(await f.page.locator('.top-signout').count(),0);
  },{restored:method,required:true});
  await run('active session respects force-relogin switch and notices policy edits on focus',async f=>{
    await f.login();await f.active();f.state.required=true;f.state.force=false;
    await f.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await f.page.waitForTimeout(300);assert.equal(await f.page.locator('.top-signout').count(),1);
    f.state.force=true;await f.page.evaluate(()=>window.dispatchEvent(new Event('focus')));await f.gate();await f.verify();
  });
  await run('verification outage offers retry without silently bypassing policy',async f=>{
    await f.login();await f.page.getByText('Could not check account verification. Please try signing in again.').waitFor();
    assert.equal(await f.page.locator('.top-signout').count(),0);f.state.lookupFails=false;await f.login();await f.active();
  },{lookupFails:true});
  await run('logout in another tab cancels an in-flight login response',async f=>{
    let release;f.state.statusHold=new Promise(resolve=>{release=resolve});await f.login();
    await f.page.waitForFunction(()=>document.querySelector('#auth-panel button[type=submit]')?.disabled);
    await f.page.evaluate(()=>{const channel=new BroadcastChannel('larsa-control-auth-v1');channel.postMessage({type:'signed-out'});setTimeout(()=>channel.close(),100)});
    await f.page.waitForTimeout(150);release();f.state.statusHold=null;
    await f.page.waitForTimeout(600);assert.equal(await f.page.locator('.top-signout').count(),0);await f.login();await f.active();
  });
  await run('cancelled code confirmation cannot sign the user back in',async f=>{
    await f.login();await f.gate();await f.page.getByRole('button',{name:'Verify & Sign In',exact:true}).waitFor();
    let release;f.state.verifyHold=new Promise(resolve=>{release=resolve});
    await f.page.getByLabel('Verification Code').fill('123456');await f.page.getByRole('button',{name:'Verify & Sign In',exact:true}).click();
    await f.page.getByRole('button',{name:'Cancel',exact:true}).click();release();await f.page.waitForTimeout(600);assert.equal(await f.page.locator('.top-signout').count(),0);
  },{required:true});
  assert.deepEqual(errors,[]);console.log('AUTH BROWSER COMPLETE',JSON.stringify({passed,runtimeErrors:errors.length}));
}finally{clearTimeout(timeout);await browser.close()}
