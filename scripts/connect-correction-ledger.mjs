import {readFileSync,writeFileSync} from 'node:fs';
const path='public/engines/timeclock.html';let raw=readFileSync(path,'utf8');
const tag='<script type="__bundler/template">',a=raw.indexOf(tag)+tag.length,b=raw.indexOf('</script',a);let inner=JSON.parse(raw.slice(a,b));
const notify="try{if(window.parent!==window&&typeof window.parent.__larsaCorrectionRecorded==='function')window.parent.__larsaCorrectionRecorded(r.id,currentUser.id);}catch(e){console.error('Approved correction ledger handoff failed',e);}";
const replacements=[['    r.materialized=true;\n    save();','    r.materialized=true;\n    save();\n    '+notify],['  r.materialized = true;\n  save();','  r.materialized = true;\n  save();\n  '+notify]];
for(const [before,after]of replacements){if(!inner.includes(before))throw new Error('Approval save point missing');inner=inner.replace(before,after);}
raw=raw.slice(0,a)+'\n'+JSON.stringify(inner).replaceAll('/','\\/')+'\n'+raw.slice(b);writeFileSync(path,raw);
