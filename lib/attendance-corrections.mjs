import {pairPunchSessions, preservesPunchPairing} from './attendance.mjs';
export function planAttendanceCorrection(request, logs, nowMs) {
  const start=Date.parse(request.fromAt),end=Date.parse(request.toAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end>nowMs)
    return {ok:false,reason:'Original timezone and punch instants are missing or invalid. Submit a new correction with the correct times.'};
  const existing=(Array.isArray(logs)?logs:[]).filter(log=>log&&(!request.id||log.correctionId!==request.id));
  const sessions=pairPunchSessions(existing,request.uid);
  const spans=sessions.map(session=>[Date.parse(session.inLog.time),session.outLog?Date.parse(session.outLog.time):(session.nextTime??nowMs)]);
  if(request.type==='Missed Break') {
    if(!spans.some(([a,b])=>start>=a&&end<=b))return {ok:false,reason:'The requested break must be inside a recorded shift.'};
  } else {
    if(spans.some(([a,b])=>start<b&&end>a))return {ok:false,reason:'This correction overlaps an existing shift. Correct the selected session instead.'};
    const proposed={inLog:{uid:request.uid,status:'In',time:request.fromAt},outLog:{uid:request.uid,status:'Out',time:request.toAt}};
    if(!preservesPunchPairing(existing,request.uid,null,proposed,sessions))
      return {ok:false,reason:'The correction would pair with another recorded punch. Review the punches in that time range.'};
  }
  return {ok:true,start:request.fromAt,end:request.toAt};
}
