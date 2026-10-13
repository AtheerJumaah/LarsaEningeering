/* Resolve the clock status shown by the employee-facing panel.
 *
 * The staff blob is authoritative once it contains a punch. A queued punch
 * is only a short-lived local overlay when it is newer than the latest punch
 * in that blob. This distinction matters after a second device has already
 * committed an Out: an old local queue must not turn the other device back
 * into "Clocked in" or make the next deliberate press use the wrong intent.
 */
/** @param {{open?: {mode?: string}|null, latest?: {status?: string, time?: string, type?: string}|null, pending?: {status?: string, occurred_at?: string, work_mode?: string|null}|null}} input */
export function resolveClockDisplay({ open = null, latest = null, pending = null } = {}) {
  const latestAt = Date.parse(String(latest?.time || ""));
  const pendingAt = Date.parse(String(pending?.occurred_at || ""));
  const pendingIsNewer = Boolean(pending && (
    !latest
    || !Number.isFinite(latestAt)
    || !Number.isFinite(pendingAt)
    || pendingAt >= latestAt
  ));
  const confirmedStatus = latest?.status === "In" || latest?.status === "Out"
    ? latest.status
    : open ? "In" : null;
  const status = pendingIsNewer
    ? (pending.status === "In" || pending.status === "Out" ? pending.status : confirmedStatus)
    : confirmedStatus;
  const mode = pendingIsNewer
    ? (pending?.work_mode || open?.mode || latest?.type || "")
    : (open?.mode || latest?.type || "");
  return { status, mode, pendingIsNewer };
}
