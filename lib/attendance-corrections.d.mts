export function planAttendanceCorrection(request: {id:string;uid:string;type:string;fromAt?:string;toAt?:string},logs:unknown,nowMs:number):
  {ok:false;reason:string}|{ok:true;start:string;end:string};
