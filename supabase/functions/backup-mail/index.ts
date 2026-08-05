// The backup mailer. Cousin of notify-mail: it drains queued platform backups
// instead of the notification outbox, but the shape is deliberately the same.
//
// It takes NO content from the caller -- only an optional batch size. The
// destination addresses and the snapshot come from platform_backups rows that
// the scheduler queued after resolving addresses from platform_backup_settings.
// A signed-in browser therefore cannot use this to mail arbitrary data to an
// arbitrary address.
//
// The claim RPC returns the snapshot ALREADY stripped of password/pin hashes
// (platform_backup_export_data), so secrets never reach this function, let
// alone an inbox. Actual delivery is delegated to send-mail, which holds the
// Microsoft Graph credentials -- the same single place notify-mail uses.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("LARSA_APP_URL") ?? "https://larsaeng.app";

// Graph delivers inline fileAttachments comfortably up to a few MB; past that a
// draft + upload session is required. A stripped snapshot is far smaller today,
// but if one ever crosses this line we mail the notice WITHOUT the file rather
// than fail the send -- the admin can still download it in Platform Settings.
const MAX_ATTACH_B64 = 3_000_000;

type ClaimRow = {
  id: string;
  created_at: string;
  kind: string;
  label: string | null;
  mail_to: string[] | null;
  data: unknown;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// base64 of a byte array, chunked so a large snapshot never blows the call
// stack the way String.fromCharCode(...allBytes) would.
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fmtBytes(n: number): string {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function appLink(): string {
  return `${APP_URL.replace(/\/+$/, "")}/`;
}

function template(row: ClaimRow, opts: { attached: boolean; fileName: string; size: number; tableCount: number }): string {
  const when = row.created_at;
  const kind = row.kind === "manual" ? "Manual" : "Scheduled";
  const note = opts.attached
    ? `The backup file <strong>${esc(opts.fileName)}</strong> (${esc(fmtBytes(opts.size))}, ${opts.tableCount} tables) is attached to this email.`
    : `This backup was too large to attach. Open Larsa Control &rarr; Platform Settings &rarr; Backups to download it.`;
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;
                    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
                    box-shadow:0 1px 3px rgba(16,24,40,.08);">
        <tr><td style="background:#17181b;padding:18px 24px;">
          <span style="color:#fff;font-size:15px;font-weight:700;letter-spacing:.2px;">Larsa Control</span>
        </td></tr>
        <tr><td style="padding:26px 24px 8px;">
          <h1 style="margin:0 0 10px;font-size:19px;line-height:1.35;color:#17181b;font-weight:700;">${kind} platform backup</h1>
          <p style="margin:0 0 12px;font-size:14.5px;line-height:1.6;color:#4a5060;">
            A ${esc(kind.toLowerCase())} backup of Larsa Control was captured on <strong>${esc(when)}</strong>.
          </p>
          <p style="margin:0;font-size:14.5px;line-height:1.6;color:#4a5060;">${note}</p>
        </td></tr>
        <tr><td style="padding:16px 24px 26px;">
          <a href="${esc(appLink())}"
             style="display:inline-block;background:#1f9d76;color:#fff;text-decoration:none;
                    font-size:14px;font-weight:700;padding:11px 20px;border-radius:9px;">Open Larsa Control</a>
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e8eaee;">
          <p style="margin:0;font-size:12px;line-height:1.55;color:#8a90a0;">
            You are receiving this because your address is on the backup list in
            Larsa Control under Platform Settings &rarr; Backups. Employee
            passwords are never included in these files.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let limit = 10;
  try {
    const body = await req.json();
    if (body && typeof body.limit === "number") limit = body.limit;
  } catch { /* empty body means "use the default batch". */ }

  const { data, error } = await supabase.rpc("platform_backup_mail_claim", {
    p_limit: Math.min(Math.max(limit, 1), 50),
  });
  if (error) return json({ ok: false, error: error.message }, 500);

  const rows: ClaimRow[] = (data ?? []) as ClaimRow[];
  let sent = 0, failed = 0, skipped = 0;

  await Promise.all(rows.map(async (row) => {
    const recipients = (row.mail_to ?? []).filter((a) => typeof a === "string" && a.includes("@"));
    if (recipients.length === 0) {
      skipped += 1;
      await supabase.rpc("platform_backup_mail_finish", { p_id: row.id, p_status: "skipped", p_detail: "no address" });
      return;
    }

    try {
      const jsonText = JSON.stringify(row.data ?? {});
      const bytes = new TextEncoder().encode(jsonText);
      const contentBase64 = bytesToBase64(bytes);
      const day = (row.created_at || "").slice(0, 10) || "snapshot";
      const fileName = `larsa-backup-${day}.json`;
      const tableCount = row.data && typeof row.data === "object" && (row.data as { tables?: Record<string, unknown> }).tables
        ? Object.keys((row.data as { tables: Record<string, unknown> }).tables).length
        : 0;
      const attach = contentBase64.length <= MAX_ATTACH_B64;

      const html = template(row, { attached: attach, fileName, size: bytes.length, tableCount });
      const payload: Record<string, unknown> = {
        to: recipients,
        subject: `Larsa Control backup — ${day}`,
        html,
      };
      if (attach) {
        payload.attachments = [{ name: fileName, contentType: "application/json", contentBase64 }];
      }

      const { error: mailError } = await supabase.functions.invoke("send-mail", { body: payload });
      if (mailError) throw new Error(mailError.message);
      sent += 1;
      await supabase.rpc("platform_backup_mail_finish", {
        p_id: row.id, p_status: "sent",
        p_detail: attach ? `attached ${fmtBytes(bytes.length)}` : "notice only (too large to attach)",
      });
    } catch (err) {
      failed += 1;
      await supabase.rpc("platform_backup_mail_finish", { p_id: row.id, p_status: "failed", p_detail: String(err).slice(0, 200) });
    }
  }));

  return json({ ok: true, claimed: rows.length, sent, failed, skipped });
});
