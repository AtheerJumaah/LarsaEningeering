export type PresenceTone = 'office' | 'online' | 'site' | 'other' | 'off';
export type PresenceUser = { id: string; name: string; enabled?: boolean };
export type PresenceEntry<T extends PresenceUser = PresenceUser> = {
  user: T; isIn: boolean; tone: PresenceTone; stale: boolean;
};
type PresenceSession = { uid: string; open: boolean; stale?: boolean; unclosed?: boolean; mode?: string };
export function scheduledPresenceUsers(schedule: unknown, instant: number | string | Date): Set<string>;
export function buildPresenceRoster<T extends PresenceUser>(users: T[], sessions: PresenceSession[], classifyMode: (mode: unknown) => Exclude<PresenceTone, 'off'>): PresenceEntry<T>[];
export function layoutPresenceLights<T extends PresenceUser>(people: PresenceEntry<T>[]): (PresenceEntry<T> & { row: number; ray: number; dotRadius: number; x: number; y: number })[];
