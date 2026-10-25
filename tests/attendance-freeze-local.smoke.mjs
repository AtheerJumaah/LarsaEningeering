// Build and test with public dummy configuration. The browser intercepts every
// Supabase request, including websocket connections; no live writes occur.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
const environment={...process.env,TZ:'UTC',NEXT_PUBLIC_SUPABASE_URL:'https://attendance-test.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'test-key'};
const next='node_modules/next/dist/bin/next';
if(!process.argv.includes('--skip-build')){const build=spawn(process.execPath,[next,'build'],{env:environment,stdio:'inherit'});
const [built]=await once(build,'exit');if(built!==0)process.exit(built||1);}
const server=spawn(process.execPath,[next,'start','-p','5199'],{env:environment,stdio:'inherit'});
try{
  let ready=false;
  for(let i=0;i<40;i++){
    try{if((await fetch('http://localhost:5199/')).ok){ready=true;break}}catch{}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready)throw new Error('local test server failed to start');
  const test=spawn(process.execPath,['tests/attendance-freeze.smoke.mjs',...process.argv.includes('--debug')?['http://localhost:5199/','--debug']:[]],{env:{...environment,SMOKE_URL:'http://localhost:5199/',FAIL_REALTIME:'1',ASSERT_FORMATTER_BUDGET:'1',FREEZE_CYCLES:process.env.FREEZE_CYCLES||'12'},stdio:'inherit'});
  const [code]=await once(test,'exit');process.exitCode=code||0;
}finally{server.kill();}
