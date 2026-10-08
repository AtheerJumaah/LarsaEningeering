import { getSupabaseClient, supabaseConfigured } from "./supabase/client";

export type AttendancePunchInput = {
  client_event_id: string;
  occurred_at: string;
  uid: string;
  normalized_email?: string | null;
  person_name?: string | null;
  status: "In" | "Out";
  work_mode?: string | null;
  note?: string | null;
  clocked_by?: string | null;
  source?: string;
  removed_ids?: string[];
};

export type AttendancePunchResult = {
  outcome: "recorded" | "already" | "unavailable";
  status?: "In" | "Out" | null;
  at?: string | null;
  eventId?: string | null;
};

/* The server owns the state transition. A timeout is reported as uncertain,
   never as success; a caller can safely retry with the same event id. */
export async function recordAttendancePunch(input: AttendancePunchInput): Promise<AttendancePunchResult> {
  if (!supabaseConfigured()) return { outcome: "unavailable" };
  const client = getSupabaseClient();
  if (!client) return { outcome: "unavailable" };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      client.rpc("record_attendance_punch", {
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
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Attendance save timed out")), 8000);
      }),
    ]);
    if (response.error) return { outcome: "unavailable" };
    const row = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!row || (row.outcome !== "recorded" && row.outcome !== "already")) {
      return { outcome: "unavailable" };
    }
    return {
      outcome: row.outcome,
      status: row.current_status === "In" || row.current_status === "Out" ? row.current_status : null,
      at: typeof row.current_at === "string" ? row.current_at : null,
      eventId: typeof row.event_id === "string" ? row.event_id : null,
    };
  } catch {
    return { outcome: "unavailable" };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
