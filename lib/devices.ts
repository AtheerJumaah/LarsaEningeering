"use client";

/* Which devices an account has been signed in from, and when each last proved
 * itself by email.
 *
 * The rule this exists to enforce: a device nobody has seen before has to pass
 * an email code before it gets in, and even a familiar one has to do it again
 * periodically. A stolen password on its own is then not enough -- whoever has
 * it also needs the mailbox.
 *
 * A device is identified by a random id this module puts in localStorage the
 * first time it runs. That is deliberately modest: clearing site data or using
 * a private window produces a new id and therefore another email check, which
 * is the safe direction to fail in. It is a convenience marker, not proof of
 * identity -- the email code is what actually proves anything.
 *
 * The list lives on the staff record inside the larsaStaffV8 blob, so it syncs
 * through Supabase and a device approved on one machine is visible from every
 * other, which is what makes the "where am I signed in" list worth showing.
 */

const DEVICE_KEY = "larsaDeviceId";

export type TrustedDevice = {
  id: string;
  label: string;
  firstSeen: string;
  lastSeen: string;
  /* When this device last passed an email code. */
  lastVerified: string;
  /* Kept for records created by older releases. */
  lastAccountingVerified?: string;
};

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    // Falls through to the manual path below.
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  let out = "";
  bytes.forEach((byte) => { out += byte.toString(16).padStart(2, "0"); });
  return out;
}

/* Stable for as long as the browser keeps its storage. */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const fresh = randomId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked: every sign-in then looks like a new device, which means
    // an email check every time rather than a silent bypass.
    return randomId();
  }
}

/* A name a person will recognise in a list of their own devices. Deliberately
   coarse -- the point is "is this the laptop or the phone", not fingerprinting
   the exact build. */
export function describeDevice(): string {
  const agent = typeof navigator === "undefined" ? "" : String(navigator.userAgent || "");
  const has = (needle: string) => agent.toLowerCase().indexOf(needle.toLowerCase()) >= 0;

  let browser = "Browser";
  if (has("Edg/")) browser = "Edge";
  else if (has("OPR/") || has("Opera")) browser = "Opera";
  else if (has("Firefox")) browser = "Firefox";
  else if (has("Chrome")) browser = "Chrome";
  else if (has("Safari")) browser = "Safari";

  let platform = "device";
  if (has("iPhone")) platform = "iPhone";
  else if (has("iPad")) platform = "iPad";
  else if (has("Android")) platform = "Android";
  else if (has("Windows")) platform = "Windows";
  else if (has("Mac OS") || has("Macintosh")) platform = "Mac";
  else if (has("Linux")) platform = "Linux";

  return browser + " on " + platform;
}

function daysSince(iso: string | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  return (Date.now() - then) / 86400000;
}

type DeviceHolder = {
  devices?: TrustedDevice[];
  access?: string;
  role?: string;
};

/* Verification follows the person's access level instead of a single global
   timeout. Finance and administrative accounts re-prove every 48 hours; the
   remaining staff accounts (including engineers) re-prove every 72 hours. */
export const SENSITIVE_ACCESS_HOURS = 48;
export const STANDARD_ACCESS_HOURS = 72;

export function verificationWindowHours(user: DeviceHolder | null | undefined): number {
  const access = `${user?.access || ""} ${user?.role || ""}`.toLowerCase();
  return access.includes("admin") || access.includes("account") || access.includes("finance")
    ? SENSITIVE_ACCESS_HOURS
    : STANDARD_ACCESS_HOURS;
}

function hoursSince(iso: string | undefined): number {
  return daysSince(iso) * 24;
}

export function findDevice(user: DeviceHolder | null | undefined, deviceId: string): TrustedDevice | null {
  const list = user && Array.isArray(user.devices) ? user.devices : [];
  return list.find((row) => row.id === deviceId) || null;
}

/* True when sign-in should stop and ask for an email code: either this device
   has never been approved, or its approval has aged out. */
export function deviceNeedsVerification(user: DeviceHolder | null | undefined, deviceId: string): boolean {
  const device = findDevice(user, deviceId);
  if (!device) return true;
  return hoursSince(device.lastVerified) >= verificationWindowHours(user);
}

/* Same question for the accounting screens, on their shorter interval. A
   device that has never opened accounting has no timestamp and so is asked. */
export function accountingNeedsVerification(user: DeviceHolder | null | undefined, deviceId: string): boolean {
  const device = findDevice(user, deviceId);
  if (!device) return true;
  /* A code entered during sign-in also proves the current browser for the
     accounting portal. This prevents the frustrating second-code prompt that
     used to appear immediately after a successful sign-in. */
  const lastProof = [device.lastVerified, device.lastAccountingVerified]
    .filter(Boolean)
    .sort()
    .at(-1);
  return hoursSince(lastProof) >= verificationWindowHours(user);
}

export function verificationRemainingMs(user: DeviceHolder | null | undefined, deviceId: string): number {
  const device = findDevice(user, deviceId);
  if (!device?.lastVerified) return 0;
  const verifiedAt = new Date(device.lastVerified).getTime();
  if (!Number.isFinite(verifiedAt)) return 0;
  return Math.max(0, verifiedAt + verificationWindowHours(user) * 3600000 - Date.now());
}

/* Returns the updated list rather than writing it, so the caller can fold it
   into whatever save it is already doing instead of racing with one. */
export function withDeviceRecorded(
  existing: TrustedDevice[] | undefined,
  deviceId: string,
  label: string,
  mark: { verified?: boolean; accounting?: boolean },
): TrustedDevice[] {
  const now = new Date().toISOString();
  const list = Array.isArray(existing) ? existing.slice() : [];
  const index = list.findIndex((row) => row.id === deviceId);

  if (index < 0) {
    list.push({
      id: deviceId,
      label,
      firstSeen: now,
      lastSeen: now,
      lastVerified: mark.verified ? now : "",
      ...(mark.accounting ? { lastAccountingVerified: now } : {}),
    });
    return list;
  }

  list[index] = {
    ...list[index],
    label,
    lastSeen: now,
    ...(mark.verified ? { lastVerified: now } : {}),
    ...(mark.accounting ? { lastAccountingVerified: now } : {}),
  };
  return list;
}

export function withDeviceRemoved(existing: TrustedDevice[] | undefined, deviceId: string): TrustedDevice[] {
  const list = Array.isArray(existing) ? existing : [];
  return list.filter((row) => row.id !== deviceId);
}

/* "3 days ago", for the device list. */
export function describeWhen(iso: string | undefined): string {
  if (!iso) return "never";
  const days = daysSince(iso);
  if (!Number.isFinite(days)) return "never";
  if (days < 1) return "today";
  if (days < 2) return "yesterday";
  if (days < 30) return Math.floor(days) + " days ago";
  if (days < 60) return "last month";
  return Math.floor(days / 30) + " months ago";
}
