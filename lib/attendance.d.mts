export type PunchLogLike = {
  id?: string;
  uid?: string;
  type?: string;
  status?: string;
  time?: string;
  note?: string;
  clockedBy?: string;
  lastSeen?: string;
  active?: boolean;
  recovery?: string;
  origUid?: string;
  origId?: string;
};

export type PunchSession = {
  inLog: PunchLogLike;
  outLog: PunchLogLike | null;
  kind: "closed" | "open" | "unclosed";
  prevTime: number | null;
  nextTime: number | null;
};

export type TrimPlan =
  | { ok: true; mode: "move" | "close"; session: PunchSession }
  | {
      ok: false;
      reason: "not-found" | "invalid-time" | "not-after-in" | "future" | "later-than-out" | "overlaps-next";
    };

export function orderedPunches(logs: PunchLogLike[] | unknown, uid: string): PunchLogLike[];
export function pairPunchSessions(logs: PunchLogLike[] | unknown, uid: string): PunchSession[];
export function findPunchSession(logs: PunchLogLike[] | unknown, uid: string, clockIn: string): PunchSession | null;
export function planTrim(
  logs: PunchLogLike[] | unknown,
  uid: string,
  clockIn: string,
  newClockOut: string,
  nowMs: number,
): TrimPlan;
