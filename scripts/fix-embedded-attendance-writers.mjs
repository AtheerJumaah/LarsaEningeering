import {readFileSync,writeFileSync} from 'node:fs';
const path='public/engines/timeclock.html';let raw=readFileSync(path,'utf8');
const tag='<script type="__bundler/template">';const from=raw.indexOf(tag)+tag.length;const to=raw.indexOf('</script',from);
let inner=JSON.parse(raw.slice(from,to));
if(inner.includes('LARSA_ATOMIC_EMBEDDED_WRITERS'))throw new Error('Already repaired');
const begin=inner.indexOf('function v30ToggleBreak(){');const end=inner.indexOf('window.V30.toggleBreak',begin);
if(begin<0||end<begin)throw new Error('Break function not found');
inner=inner.slice(0,begin)+`// LARSA_ATOMIC_EMBEDDED_WRITERS
function v30ToggleBreak(){
  if(!currentUser)return;
  var active=v30OnBreak(currentUser.id);
  var offering=active?'Break End':'Break Start';
  v30NoteModal(active?'Ending your break':'Starting a break',active?'End Break':'Start Break',function(note){
    var p=window.parent;
    if(p&&p!==window&&typeof p.__larsaBreak==='function'){p.__larsaBreak(offering,note||'',currentUser.id);return;}
    toast('Open the main Larsa app to record a break. Nothing was recorded.');
  });
}
`+inner.slice(end);
const managerStart=inner.indexOf('function v30ClockOther(){');
const managerBody=inner.indexOf('    /* This writes to somebody',managerStart);
if(managerStart<0||managerBody<managerStart)throw new Error('Manager writer not found');
inner=inner.slice(0,managerBody)+`    var p=window.parent;
    if(p&&p!==window&&typeof p.__larsaManagerPunch==='function'){p.__larsaManagerPunch(type,offering,note||'',uid,currentUser.id);return;}
    toast('Open the main Larsa app to record manager attendance. Nothing was recorded.');return;
`+inner.slice(managerBody);
inner=inner.replace("l.uid===uid && (l.status==='Break Start'||l.status==='Break End')","l.uid===uid && ['In','Out','Break Start','Break End'].includes(l.status)");
raw=raw.slice(0,from)+'\n'+JSON.stringify(inner).replaceAll('/','\\/')+'\n'+raw.slice(to);writeFileSync(path,raw);
