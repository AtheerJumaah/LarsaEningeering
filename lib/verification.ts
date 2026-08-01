"use client";

/* Periodic security verification: the client half.
 *
 * The policy and the timestamps live in Supabase, not here, and not in the
 * larsaStaffV8 blob. Two reasons. A value that decides access must not be
 * writable by the browser it is deciding about; and the blob is replaced
 * wholesale by whichever client writes last, so anything kept in it can be
 * reverted by a stale tab -- which is exactly why verification kept being
 * demanded on every sign-in.
 *
 * This module only ever ASKS. It cannot record a verification. The only thing
 * that can move the clock is the auth-code function, once it has genuinely
 * accepted an emailed code.
 *
 * Honest limitation: this app has no server session, so the gate runs in the
 * browser. It stops an expired interval carrying on in an open tab, which is
 * the realistic case. It is not proof against somebody editing their own
 * client, and it should not be described as if it were.
 */

import { getSupabaseClient, supabaseConfigured } from "./supabase/client";

export type VerificationPolicy = {
  enabled: boolean;
  engineer_hours: number | null;
  privileged_hours: number | null;
  force_relogin: boolean; self_signup_enabled: boolean; signup_requires_approval: boolean; initial_verification_required: boolean;
};

export type VerificationStatus = {
  required: boolean;
  hours: number | null;
  expiresInHours: number;
  lastVerifiedAt: string | null;
  policy: VerificationPolicy;
};

export const DEFAULT_POLICY: VerificationPolicy = {
  enabled: true,
  engineer_hours: 72,
  privileged_hours: 24,
  force_relogin: true, self_signup_enabled: true, signup_requires_approval: false, initial_verification_required: true,
};

async function call(body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (!supabaseConfigured()) return null;
  const client = getSupabaseClient();
  if (!client) return null;
  try {
    const { data, error } = await client.functions.invoke("auth-policy", { body });
    if (error) return null;
    return (data || null) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export async function loadPolicy(): Promise<VerificationPolicy> {
  const data = await call({ op: "policy" });
  const policy = data && data.ok ? (data.policy as VerificationPolicy) : null;
  return policy || DEFAULT_POLICY;
}

export async function savePolicy(policy: VerificationPolicy, updatedBy: string): Promise<boolean> {
  const data = await call({ op: "save", policy, updatedBy });
  return Boolean(data && data.ok);
}

/* Whether this person has to prove their mailbox again before going further.
 *
 * If the service cannot be reached the answer is "no". Refusing entry because
 * a network call failed would lock the company out of its own timeclock over a
 * dropped connection, which is a worse outcome than a delayed check -- and the
 * check will run again on the next load.
 */
export async function checkVerification(user: {
  id: string;
  access?: string;
  role?: string;
}): Promise<VerificationStatus | null> {
  const data = await call({ op: "status", userId: user.id, access: user.access || "", role: user.role || "" });
  if (!data || !data.ok) return null;
  return {
    required: Boolean(data.required),
    hours: (data.hours as number | null) ?? null,
    expiresInHours: Number(data.expiresInHours || 0),
    lastVerifiedAt: (data.lastVerifiedAt as string | null) ?? null,
    policy: (data.policy as VerificationPolicy) || DEFAULT_POLICY,
  };
}

export function describeInterval(hours: number | null): string {
  if (!hours) return "off";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return days === 1 ? "every day" : "every " + days + " days";
  }
  return "every " + hours + " hours";
}
