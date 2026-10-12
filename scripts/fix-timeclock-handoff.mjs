// Mechanical rewrite of the packed template; the exact replacements are
// checked before touching the artifact. The browser must see escaped slashes.
import { readFileSync, writeFileSync } from 'node:fs';
const path = 'public/engines/timeclock.html';
let raw = readFileSync(path, 'utf8');
const tag = '<script type="__bundler/template">';
const from = raw.indexOf(tag) + tag.length;
const to = raw.indexOf('</script', from);
let inner = JSON.parse(raw.slice(from, to));
const start = inner.indexOf('function clockToggle(');
const body = inner.indexOf('freshState();', start);
if (start < 0 || body < start || body > start + 250) throw new Error('Unexpected clockToggle template');
inner = inner.slice(0, body) + `
  // Deliberate intent and identity go to the parent BEFORE stale cache checks.
  var hand = larsaAppPunch();
  if(hand && (intent==='In'||intent==='Out')){
    var pending=window.__larsaPendingNote||'';
    hand(type,intent,pending,currentUser.id);
    window.__larsaPendingNote='';
    return;
  }
  if(window.parent!==window){toast('Attendance is still connecting. Reopen the panel; nothing was recorded.');return;}
  // The standalone panel is not a production punch writer.
  toast('Open the main Larsa app to record attendance.');return;
  ` + inner.slice(body);
raw = raw.slice(0, from) + '\n' + JSON.stringify(inner).replaceAll('/', '\\/') + '\n' + raw.slice(to);
raw = raw.replace('parent.__larsaPunch(type, intent, pending);', 'parent.__larsaPunch(type, intent, pending, window.currentUser && window.currentUser.id);');
writeFileSync(path, raw);
