import {readFileSync,writeFileSync} from 'node:fs';
const path='public/engines/timeclock.html';let raw=readFileSync(path,'utf8');
const tag='<script type="__bundler/template">';const from=raw.indexOf(tag)+tag.length;const to=raw.indexOf('</script',from);let inner=JSON.parse(raw.slice(from,to));
if(inner.includes('LARSA_CORRECTION_INSTANTS'))throw new Error('Already repaired');
const helper=`// LARSA_CORRECTION_INSTANTS
function larsaStampCorrectionRequest(r){
  if(!['Missed Clock','Missed Break','Extra Hours'].includes(r.type))return r;
  var start=new Date(r.date+'T'+r.from+':00'), end=new Date(r.date+'T'+r.to+':00');
  if(r.to<r.from)end.setDate(end.getDate()+1);
  if(Number.isFinite(start.getTime())&&Number.isFinite(end.getTime())){
    r.fromAt=start.toISOString();r.toAt=end.toISOString();r.timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  return r;
}
function larsaCorrectionReady(r){
  var a=Date.parse(r.fromAt),b=Date.parse(r.toAt);
  var now=Date.now()+(parseInt(localStorage.getItem('larsaClockOffsetMsV1'),10)||0);
  var reason='';
  if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a||b>now)reason='The original timezone/instants are missing, invalid, or in the future.';
  var rows=(state.logs||[]).filter(function(l){return l.uid===r.uid&&l.correctionId!==r.id&&['In','Out'].includes(l.status)&&Number.isFinite(Date.parse(l.time));}).sort(function(x,y){return Date.parse(x.time)-Date.parse(y.time);});
  var spans=[],open=null;
  rows.forEach(function(l){var t=Date.parse(l.time);if(l.status==='In'){if(open!==null&&t-open<12*3600000)return;if(open!==null)spans.push([open,t]);open=t;}else if(open!==null){spans.push([open,t]);open=null;}});
  if(open!==null)spans.push([open,now]);
  if(!reason&&r.type==='Missed Break'&&!spans.some(function(s){return a>=s[0]&&b<=s[1];}))reason='The break is not inside a recorded shift.';
  if(!reason&&r.type!=='Missed Break'&&spans.some(function(s){return a<s[1]&&b>s[0];}))reason='This request overlaps an existing shift. Correct the selected session instead.';
  if(reason){r.materializationReview=reason;toast('Approved request needs review: '+reason+' No punches were created.');return false;}
  return true;
}
`;
const requestAt=inner.indexOf('function request(');if(requestAt<0)throw new Error('Request function missing');
inner=inner.slice(0,requestAt)+helper+inner.slice(requestAt);
const requestEnd=inner.indexOf('\n',requestAt+helper.length+1);
let requestCode=inner.slice(requestAt+helper.length,requestEnd).trimEnd();
if(!requestCode.includes('return {id,type')||!requestCode.endsWith('}}'))throw new Error('Unexpected request shape');
requestCode=requestCode.replace('return {id,type','return larsaStampCorrectionRequest({id,type').slice(0,-2)+'})}';
inner=inner.slice(0,requestAt+helper.length)+requestCode+inner.slice(requestEnd);
const oldV30="if(r && r.type==='Missed Clock' && r.status==='Approved' && !r.materialized){";
if(!inner.includes(oldV30))throw new Error('Missing v30 approval');
inner=inner.replace(oldV30,oldV30+'\n    if(!larsaCorrectionReady(r)){save();return;}');
inner=inner.replace("const inIso=new Date(r.date+'T'+(r.from||'09:00')+':00').toISOString();","const inIso=r.fromAt;");
inner=inner.replace("const outIso=new Date(r.date+'T'+(r.to||'17:00')+':00').toISOString();","const outIso=r.toAt;");
inner=inner.replace("  if(!TYPES[r.type]) return;","  if(!TYPES[r.type]) return;\n  if(!larsaCorrectionReady(r)){save();return;}");
inner=inner.replace("const iso = (t)=> new Date(r.date+'T'+(t||'00:00')+':00').toISOString();","const iso = (t)=> t===r.from?r.fromAt:r.toAt;");
// Stable IDs make materialization safe even if two approvers race on a stale copy.
const a=inner.indexOf('const v30RealApproveReq');const b=inner.indexOf('// 3) Authorized people',a);
let v30=inner.slice(a,b).replace("id:'l'+Date.now(),","id:'correction:'+r.id+':in',correctionId:r.id,clockedBy:currentUser.id,").replace("id:'l'+Date.now()+'b',","id:'correction:'+r.id+':out',correctionId:r.id,clockedBy:currentUser.id,");inner=inner.slice(0,a)+v30+inner.slice(b);
const c=inner.indexOf('const iso = (t)=> t===r.from');const d=inner.indexOf('// Relabel the v30 button',c);
let v31=inner.slice(c,d).replace('correctionId:r.id','correctionId:r.id, clockedBy:currentUser.id')
  .replaceAll("id:'l'+Date.now(),","id:'correction:'+r.id+':in',").replaceAll("id:'l'+Date.now()+'b',","id:'correction:'+r.id+':out',");inner=inner.slice(0,c)+v31+inner.slice(d);
inner=inner.replace("if(to <= from){ toast('The end time has to be after the start time.'); return; }","if(to === from){ toast('Start and end times must differ. An earlier end means the following day.'); return; }");
raw=raw.slice(0,from)+'\n'+JSON.stringify(inner).replaceAll('/','\\/')+'\n'+raw.slice(to);writeFileSync(path,raw);
