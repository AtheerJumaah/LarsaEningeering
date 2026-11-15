export type PresenceTone = 'office' | 'online' | 'site' | 'other' | 'off';
export type PresenceUser = { id: string; name: string; enabled?: boolean };
export type PresenceEntry<T extends PresenceUser = PresenceUser> = {
  user: T; isIn: boolean; tone: PresenceTone; mode: string; since: string; hours: number; stale: boolean;
};
type PresenceLog = { uid?: string; time?: string; status?: string; type?: string };
type PresenceSession = { uid: string; open: boolean; stale?: boolean; unclosed?: boolean; mode?: string; clockIn?: string; presenceHours?: number };
export function buildPresenceRoster<T extends PresenceUser>(users: T[], logs: PresenceLog[], sessions: PresenceSession[], classifyMode: (mode: unknown) => Exclude<PresenceTone, 'off'>): PresenceEntry<T>[];
export function layoutPresenceLights<T extends PresenceUser>(people: PresenceEntry<T>[]): (PresenceEntry<T> & { row: number; ray: number; dotRadius: number; x: number; y: number })[];
