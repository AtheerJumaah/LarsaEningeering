import {pairPunchSessions} from './attendance.mjs';
export function planAttendanceCorrection(request, logs, nowMs) {
  const start=Date.parse(request.fromAt),end=Date.parse(request.toAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end>nowMs)
    return {ok:false,reason:'Original timezone and punch instants are missing or invalid. Submit a new correction with the correct times.'};
  const existing=(Array.isArray(logs)?logs:[]).filter(log=>log.correctionId!==request.id);
  const spans=pairPunchSessions(existing,request.uid).map(session=>[Date.parse(session.inLog.time),session.outLog?Date.parse(session.outLog.time):(session.nextTime||nowMs)]);
  if(request.type==='Missed Break') {
    if(!spans.some(([a,b])=>start>=a&&end<=b))return {ok:false,reason:'The requested break must be inside a recorded shift.'};
  } else if(spans.some(([a,b])=>start<b&&end>a))return {ok:false,reason:'This correction overlaps an existing shift. Correct the selected session instead; no unrelated punch was changed.'};
  return {ok:true,start:request.fromAt,end:request.toAt};
}
