// Mechanical migration of packed script function bodies. The parent provides
// the actual native session calculation; no second calculation is introduced.
import {readFileSync,writeFileSync} from 'node:fs';
import ts from 'typescript';
const path='public/engines/timeclock.html';let raw=readFileSync(path,'utf8');
const tag='<script type="__bundler/template">',from=raw.indexOf(tag)+tag.length,to=raw.indexOf('</script',from);
let inner=JSON.parse(raw.slice(from,to));
if(inner.includes('function larsaSharedAttendanceSessions'))throw new Error('Already migrated');
const edits=[];
for(const block of inner.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)){
  const source=ts.createSourceFile('engine.js',block[1],ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const offset=block.index+block[0].indexOf(block[1]);
  function visit(node){
    if(ts.isFunctionDeclaration(node)){
      const name=node.name?.text;let body;
      if(['sessions','sessions23','sessions26'].includes(name))body='return larsaSharedAttendanceSessions();';
      if(name==='completedSessions')body=node.parameters.length
        ? "return larsaSharedAttendanceSessions().filter(s=>s.uid===uid&&!s.Open).map(s=>({type:s.Type,inTime:s.In,outTime:s.Out,hours:s.Hours}));"
        : 'return larsaSharedAttendanceSessions().filter(s=>!s.Open);';
      if(name==='totalHours')body='return larsaSharedAttendanceSessions().filter(s=>!type||s.Type===type).reduce((sum,s)=>sum+s.Hours,0);';
      if(name==='actualHours')body='return larsaSharedAttendanceSessions().filter(s=>s.uid===uid).reduce((sum,s)=>sum+s.Hours,0);';
      if(name==='openSession')body="const s=larsaSharedAttendanceSessions().find(s=>s.uid===uid&&s.Open&&!s.Review);return s?{type:s.Type,time:s.In}:null;";
      if(name==='v10SessionPairs')body="return larsaSharedAttendanceSessions().filter(s=>(!uid||s.uid===uid)&&(!type||s.Type===type)&&v10BetweenDate(s.In,from,to)).map(s=>({uid:s.uid,type:s.Type,start:s.In,end:s.Out,hours:s.Hours,open:s.Open}));";
      if(body)edits.push({a:offset+node.body.getStart(source),b:offset+node.body.end,text:`{${body}}`});
    }ts.forEachChild(node,visit);
  }visit(source);
}
if(edits.length<8)throw new Error(`Unexpected session function inventory: ${edits.length}`);
for(const e of edits.sort((a,b)=>b.a-a.a))inner=inner.slice(0,e.a)+e.text+inner.slice(e.b);
const helper=`function larsaSharedAttendanceSessions(){
  try{var p=window.parent;if(p&&p!==window&&typeof p.__larsaAttendanceSessions==='function')return p.__larsaAttendanceSessions();}
  catch(e){console.warn('Attendance summary is temporarily unavailable');}
  return [];
}
`;
inner=inner.replace('function totalHours(type)',helper+'function totalHours(type)');
// Reviewed/stale shifts are visible but cannot masquerade as counted hours.
inner=inner.replaceAll("${s.Open?'<span class=\"badge warn\">Open</span>'", "${s.Review?'<span class=\"badge warn\">Needs correction · not counted</span>':s.Open?'<span class=\"badge warn\">Open</span>'");
raw=raw.slice(0,from)+'\n'+JSON.stringify(inner).replaceAll('</','<\\/')+'\n'+raw.slice(to);writeFileSync(path,raw);
console.log(`Unified ${edits.length} packed attendance calculators`);
