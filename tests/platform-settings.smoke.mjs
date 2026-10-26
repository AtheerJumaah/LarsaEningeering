// Exercise actual UI and Save/Confirm requests using isolated fake accounts.
// All Supabase traffic is intercepted, so no real policy or email is changed.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/LENOVO/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1440,height:1000}});
const user={id:'settings-fixture',name:'Settings Fixture',email:'settings@example.invalid',enabled:true,access:'Super Admin',role:'Engineer',platformAdmin:true};
const staff={users:[user],logs:[]};
let policy={enabled:true,engineer_hours:72,privileged_hours:48,force_relogin:true,initial_verification_required:true,pin_verification_required:true,pin_hours:168,interval_unit:'hours',self_signup_enabled:true,signup_requires_approval:false};
let backup={enabled:true,interval_hours:24,retain_days:30,emails:[]};
const writes=[],mail=[],errors=[];
await context.routeWebSocket('**/realtime/**',socket=>socket.close());
await context.route('**/*.supabase.co/**',async route=>{
  const req=route.request(),url=new URL(req.url());let data=[];
  if(url.pathname.includes('/auth/')){
    const token=Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,sub:'00000000-0000-4000-8000-000000000001',role:'authenticated'})).toString('base64url');
    data={access_token:`eyJhbGciOiJIUzI1NiJ9.${token}.test`,refresh_token:'test',token_type:'bearer',expires_in:3600,user:{id:'00000000-0000-4000-8000-000000000001',role:'authenticated',is_anonymous:true}};
  }else if(url.pathname.endsWith('/functions/v1/auth-policy')){
    const p=req.postDataJSON();
    if(p.op==='save'){
      writes.push(p);if(p.code==='123456'){policy={...p.policy};data={ok:true,policy}}else data={ok:false,error:'Incorrect confirmation code.'};
    }else if(p.op==='status')data={ok:true,required:false,policy,lastVerifiedAt:new Date().toISOString(),expiresInHours:48};
    else if(p.op==='amPlatformAdmin')data={ok:true,admin:true};
    else if(p.op==='policy')data={ok:true,policy};
    else data={ok:true,rows:[]};
  }else if(url.pathname.endsWith('/functions/v1/auth-code')){mail.push(req.postDataJSON());data={ok:true}}
  else if(url.pathname.endsWith('/rpc/platform_backup_settings_get'))data=backup;
  else if(url.pathname.endsWith('/rpc/platform_backup_settings_set')){const p=req.postDataJSON();backup={enabled:p.p_enabled,interval_hours:p.p_interval_hours,retain_days:p.p_retain_days,emails:p.p_emails};data=backup}
  else if(url.pathname.endsWith('/rpc/server_now'))data=new Date().toISOString();
  else if(url.pathname.endsWith('/app_state')){
    const key=url.searchParams.get('store_key');data=key?.startsWith('eq.')?{data:key==='eq.larsaStaffV8'?staff:{},updated_at:new Date().toISOString()}:[{store_key:'larsaStaffV8',data:staff,updated_at:new Date().toISOString()}];
  }else if(url.pathname.endsWith('/rpc/app_state_put')){const p=req.postDataJSON();data=[{applied:true,current_data:p.p_data,current_updated_at:new Date().toISOString()}]}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data),headers:{'access-control-allow-origin':'*'}}).catch(()=>{});
});
await context.addInitScript(({staff,user})=>{
  if(localStorage.getItem('settings-seeded'))return;
  localStorage.setItem('settings-seeded','1');localStorage.setItem('larsaStaffV8',JSON.stringify(staff));sessionStorage.setItem('larsa-control-session',JSON.stringify({user,method:'email'}));
},{staff,user});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
async function openSettings(){
  await page.locator('.top-signout').waitFor({timeout:30000});
  await page.getByText('Administration',{exact:true}).last().click();
  await page.getByText('Platform Settings',{exact:true}).first().click();
  await page.locator('.native.active .ps-savebar').waitFor();
}
try{
  await page.goto(process.env.SMOKE_URL||'http://localhost:5199/',{waitUntil:'domcontentloaded'});await openSettings();
  const panel=page.locator('.native.active .platform-settings'),save=panel.getByRole('button',{name:'Save changes',exact:true});
  assert.equal(await save.isVisible(),true);assert.equal(await save.isDisabled(),true);
  const engineer=panel.getByRole('switch',{name:'Engineers on or off'}),privileged=panel.getByRole('switch',{name:'Accountants & admins on or off'}),pin=panel.getByRole('switch',{name:'PIN re-verification on or off'});
  for(const control of [engineer,privileged,pin])assert.equal(await control.isChecked(),true);
  await panel.locator('#engineer-interval').fill('96');await engineer.uncheck();assert.equal(await panel.locator('#engineer-interval').isDisabled(),true);await engineer.check();assert.equal(await panel.locator('#engineer-interval').inputValue(),'96');
  await privileged.uncheck();await panel.locator('#pin-interval').fill('336');await pin.uncheck();
  assert.equal(writes.length,0,'edits must not save automatically');assert.equal(mail.length,0,'edits must not send codes');assert.equal(await save.isEnabled(),true);
  await panel.getByText('Unsaved changes',{exact:true}).waitFor();
  await save.click();await panel.getByRole('textbox',{name:'Confirmation code'}).waitFor();assert.equal(writes.length,0,'Save must retain existing email confirmation');assert.equal(mail.length,1);
  assert.equal(await panel.locator('#engineer-interval').isDisabled(),true,'lock policy while awaiting confirmation');
  await panel.getByRole('textbox',{name:'Confirmation code'}).fill('000000');await panel.getByRole('button',{name:'Confirm',exact:true}).click();await panel.getByText('Incorrect confirmation code.').waitFor();assert.equal(policy.engineer_hours,72,'rejected code cannot persist settings');
  await panel.getByRole('textbox',{name:'Confirmation code'}).fill('123456');await panel.getByRole('button',{name:'Confirm',exact:true}).click();await panel.getByText('All changes saved',{exact:true}).waitFor();
  assert.equal(policy.engineer_hours,96);assert.equal(policy.privileged_hours,null);assert.equal(policy.pin_hours,336);assert.equal(policy.pin_verification_required,false);assert.equal(writes.at(-1).actorEmail,user.email);assert.equal(await save.isDisabled(),true);
  await page.reload({waitUntil:'domcontentloaded'});await openSettings();assert.equal(await panel.locator('#engineer-interval').inputValue(),'96');assert.equal(await privileged.isChecked(),false);assert.equal(await pin.isChecked(),false);
  await pin.check();await panel.locator('#pin-interval').fill('168');await engineer.uncheck();await panel.getByRole('button',{name:'Discard',exact:true}).click();assert.equal(await engineer.isChecked(),true);assert.equal(await pin.isChecked(),false);assert.equal(await panel.locator('#pin-interval').inputValue(),'336');
  const backupSave=panel.getByRole('button',{name:'Save backup settings',exact:true});assert.equal(await backupSave.count(),1);assert.equal(await backupSave.isDisabled(),true);
  await page.locator('.native.active').evaluate(el=>{el.scrollTop=700});
  assert.equal(await panel.locator('.ps-savebar').isVisible(),true,'Save toolbar must stay visible while settings scroll');
  await page.locator('.native.active').evaluate(el=>{el.scrollTop=0});
  await page.screenshot({path:'.platform-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  const closeNavigation=page.getByRole('button',{name:'Close navigation',exact:true});if(await closeNavigation.isVisible().catch(()=>false)){await closeNavigation.evaluate(button=>button.click());await page.waitForTimeout(350)}
  await page.screenshot({path:'.platform-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no mobile page overflow');
  assert.deepEqual(errors,[]);console.log('PASS Platform Settings: consistent switches, explicit Save/Confirm, rejected code, reload persistence, discard, desktop/mobile');
}catch(error){console.error('UI DIAGNOSTIC',(await page.locator('body').innerText()).slice(-2200));throw error}finally{await browser.close()}
