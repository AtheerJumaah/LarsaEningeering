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
  outcome: "recorded" | "already" | "needs_review" | "configuration_error" | "unavailable";
  status?: AttendancePunchInput["status"] | null;
  at?: string | null;
  eventId?: string | null;
  workMode?: string | null;
  note?: string | null;
  clockedBy?: string | null;
};

/* The server owns the state transition. A timeout is reported as uncertain,
   never as success; a caller can safely retry with the same event id. */
export async function recordAttendancePunch(input: AttendancePunchInput): Promise<AttendancePunchResult> {
  if (!supabaseConfigured()) return { outcome: "unavailable" };
  const client = getSupabaseClient();
  if (!client) return { outcome: "unavailable" };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = (async () => {
      /* The app's shared sync bootstrap signs into Supabase anonymously. A
         first clock action can happen before that async bootstrap completes,
         so establish the same session here before calling the invoker RPC. */
      const { data: auth } = await client.auth.getSession();
      if (!auth.session) {
        const { error: signInError } = await client.auth.signInAnonymously();
        if (signInError) return { outcome: "unavailable" as const };
      }
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
      });
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
        timeout = setTimeout(() => resolve({ outcome: "unavailable" }), 8000);
      }),
    ]);
  } catch {
    return { outcome: "unavailable" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
