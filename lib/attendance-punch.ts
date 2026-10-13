import { getSupabaseClient, supabaseConfigured } from "./supabase/client";

export type AttendancePunchInput = {
  client_event_id: string;
  occurred_at: string;
  uid: string;
  normalized_email?: string | null;
  person_name?: string | null;
  status: "In" | "Out" | "Break Start" | "Break End";
  work_mode?: string | null;
  note?: string | null;
  clocked_by?: string | null;
  actor_id?: string;
  source?: string;
  removed_ids?: string[];
  needs_review?: boolean;
  review_reason?: string;
};

export type AttendancePunchResult = {
  outcome: "recorded" | "already" | "needs_review" | "forbidden" | "configuration_error" | "unavailable";
  reason?: "anonymous_session" | "missing_session" | "auth_unavailable" | "identity_required";
  status?: AttendancePunchInput["status"] | null;
  at?: string | null;
  eventId?: string | null;
  workMode?: string | null;
  note?: string | null;
  clockedBy?: string | null;
};

/* Compatibility switch for the identity-binding cutover. It is intentionally
   build-time configuration, not localStorage or a URL parameter: a device
   must not be able to turn server authorization off for itself. Unset/unknown
   values are legacy-compatible (OFF); an explicit true value enables the
   fail-closed Auth path below. */
export function attendanceAuthBindingEnabled(): boolean {
  const raw = typeof process !== "undefined"
    ? String(process.env?.NEXT_PUBLIC_LARSA_ATTENDANCE_AUTH_BINDING || "").trim().toLowerCase()
    : "";
  return raw === "1" || raw === "true" || raw === "on" || raw === "enabled";
}

/* The server owns the state transition. A timeout is reported as uncertain,
   never as success; a caller can safely retry with the same event id. */
export async function recordAttendancePunch(input: AttendancePunchInput): Promise<AttendancePunchResult> {
  if (!supabaseConfigured()) return { outcome: "unavailable" };
  const client = getSupabaseClient();
  if (!client) return { outcome: "unavailable" };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const request = (async () => {
      if (attendanceAuthBindingEnabled()) {
        /* Enabled identity-binding mode is deliberately fail-closed.
           Anonymous sessions remain useful for pre-sign-in read/bootstrap
           work, but they are never an employee identity and cannot write a
           punch. Auth-service failures remain retryable; missing or anonymous
           identity is a hard, non-queued denial. */
        const { data: auth, error: authError } = await client.auth.getUser();
        if (authError) {
          const authCode = String(authError.code || "").toLowerCase();
          const authName = String(authError.name || "").toLowerCase();
          if (authCode.includes("session") || authName.includes("sessionmissing")) {
            return { outcome: "forbidden" as const, reason: "missing_session" as const };
          }
          return { outcome: "unavailable" as const, reason: "auth_unavailable" as const };
        }
        if (!auth.user) return { outcome: "forbidden" as const, reason: "missing_session" as const };
        if (auth.user.is_anonymous === true) {
          return { outcome: "forbidden" as const, reason: "anonymous_session" as const };
        }
      } else {
        /* Production-default-OFF compatibility mode. Keep the existing
           anonymous bootstrap so the reliability fixes can ship without
           breaking the current local-PIN/anonymous attendance deployment.
           This branch is temporary and is not an identity authorization
           claim; enabling the flag selects the strict path above. */
        const { data: auth } = await client.auth.getSession();
        if (!auth.session) {
          const { error: signInError } = await client.auth.signInAnonymously();
          if (signInError) return { outcome: "unavailable" as const };
        }
      }
      // A timed-out auth lookup must not start a late, abandoned RPC.
      if (controller.signal.aborted) return { outcome: "unavailable" as const };
      let deviceId: string | null = null;
      try {
        deviceId = localStorage.getItem("larsaAttendanceDeviceV1") || globalThis.crypto.randomUUID();
        localStorage.setItem("larsaAttendanceDeviceV1", deviceId);
      } catch { /* audit session ID is still captured by the server */ }
      const response = await client.rpc("record_attendance_action", {
        p_client_event_id: input.client_event_id,
        p_occurred_at: input.occurred_at,
        p_uid: input.uid,
        p_normalized_email: input.normalized_email ?? null,
        p_person_name: input.person_name ?? null,
        p_status: input.status,
        p_work_mode: input.work_mode ?? null,
        p_note: input.note ?? null,
        p_clocked_by: input.clocked_by ?? null,
        p_source: input.source ?? "live",
        p_removed_ids: input.removed_ids ?? [],
        p_actor_employee_id: input.actor_id || input.uid,
        p_device_info: { id: deviceId, userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null },
      }).abortSignal(controller.signal);
      if (response.error) {
        const code = String(response.error.code || "");
        if (code === "PGRST202" || code === "42883") return { outcome: "configuration_error" as const };
        if (code === "22023") return { outcome: "needs_review" as const };
        return { outcome: "unavailable" as const };
      }
      const row = Array.isArray(response.data) ? response.data[0] : response.data;
      if (!row || (row.outcome !== "recorded" && row.outcome !== "already")) {
        return { outcome: "unavailable" as const };
      }
      return {
        outcome: row.outcome as "recorded" | "already",
        status: ["In", "Out", "Break Start", "Break End"].includes(row.current_status) ? row.current_status : null,
        at: typeof row.current_at === "string" ? row.current_at : null,
        eventId: typeof row.event_id === "string" ? row.event_id : null,
        workMode: typeof row.current_work_mode === "string" ? row.current_work_mode : null,
        note: typeof row.current_note === "string" ? row.current_note : null,
        clockedBy: typeof row.current_clocked_by === "string" ? row.current_clocked_by : null,
      };
    })();
    return await Promise.race([
      request,
      new Promise<AttendancePunchResult>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve({ outcome: "unavailable" });
        }, 8000);
      }),
    ]);
  } catch {
    return { outcome: "unavailable" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
