// The mail sender. Twin of send-push: it drains the SAME outbox, filtered to
// channel 'mail', and records what happened in the same notify_deliveries
// table. Everything that makes the push sender safe applies here for the same
// reasons, so the shape is deliberately near-identical.
//
// Like send-push, it takes NO content from the caller — only an optional batch
// size. The subject, the body and above all the destination address come from
// the outbox row, which notify_raise wrote after resolving the address from
// the staff record itself. A signed-in browser therefore cannot use this to
// mail arbitrary text to an arbitrary address.
//
// Actual delivery is delegated to the existing send-mail function rather than
// reimplemented. That function already holds the Microsoft Graph credentials
// and already works; duplicating the credential handling here would mean two
// places to rotate secrets and two places to get it wrong.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("LARSA_APP_URL") ?? "https://larsaeng.app";

type OutboxItem = {
  id: string;
  notificationId: string | null;
  userUid: string;
  category: string;
  title: string;
  body: string;
  url: string;
  attempts: number;
  channel: string;
  mailTo: string | null;
  suppressed: string | null;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Everything interpolated into the template goes through this first. The body
// of a notification is written by staff and can contain a project name with an
// ampersand in it as easily as it can contain a stray angle bracket; either
// way it is text, and it must arrive as text rather than as markup.
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// The link has to survive an email client, so it is absolute. `url` from the
// outbox is always an app-relative path written by notify_raise ("/?n=<uuid>"),
// never anything a caller supplied — but it is still forced back onto the app
// origin here, so a malformed row can never turn into an off-site link.
function appLink(rawUrl: string): string {
  const path = rawUrl && rawUrl.startsWith("/") ? rawUrl : "/";
  return `${APP_URL.replace(/\/+$/, "")}${path}`;
}

function template(item: OutboxItem): string {
  const link = appLink(item.url);
  const bodyHtml = esc(item.body).replace(/\n/g, "<br />");
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
          <h1 style="margin:0 0 10px;font-size:19px;line-height:1.35;color:#17181b;font-weight:700;">${esc(item.title)}</h1>
          <p style="margin:0;font-size:14.5px;line-height:1.6;color:#4a5060;">${bodyHtml}</p>
        </td></tr>
        <tr><td style="padding:20px 24px 26px;">
          <a href="${esc(link)}"
             style="display:inline-block;background:#1f9d76;color:#fff;text-decoration:none;
                    font-size:14px;font-weight:700;padding:11px 20px;border-radius:9px;">Open in Larsa Control</a>
        </td></tr>
        <tr><td style="padding:16px 24px;border-top:1px solid #e8eaee;">
          <p style="margin:0;font-size:12px;line-height:1.55;color:#8a90a0;">
            You are receiving this because email alerts are switched on for your
            ${esc(item.category)} notifications. You can turn them off in
            Larsa Control under Settings &rarr; Notifications.
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
  let limit = 50;
  try {
    const body = await req.json();
    if (body && typeof body.limit === "number") limit = body.limit;
  } catch { /* an empty body is fine — it means "use the default batch". */ }

  const { data, error } = await supabase.rpc("notify_outbox_claim", {
    p_limit: Math.min(Math.max(limit, 1), 200),
    p_channel: "mail",
  });
  if (error) return json({ ok: false, error: error.message }, 500);

  const items: OutboxItem[] = (data?.items ?? []) as OutboxItem[];
  let sent = 0, failed = 0, skipped = 0;

  await Promise.all(items.map(async (item) => {
    // Suppression is resolved in SQL — a personal opt-out, or no address on
    // file. It is a normal outcome, recorded rather than retried.
    if (item.suppressed) {
      skipped += 1;
      await supabase.rpc("notify_outbox_finish", {
        p_id: item.id, p_status: "skipped", p_error: null,
        p_deliveries: [{ channel: "mail", target: "-", status: "skipped", detail: item.suppressed }],
      });
      return;
    }
    if (!item.mailTo) {
      skipped += 1;
      await supabase.rpc("notify_outbox_finish", {
        p_id: item.id, p_status: "skipped", p_error: null,
        p_deliveries: [{ channel: "mail", target: "-", status: "skipped", detail: "no address" }],
      });
      return;
    }

    // Only the domain is kept in the delivery log. Knowing a send failed at
    // outlook.com is what makes the log useful; storing the full address a
    // second time is not.
    const domain = item.mailTo.split("@")[1] ?? "unknown";
    try {
      const { error: mailError } = await supabase.functions.invoke("send-mail", {
        body: { to: item.mailTo, subject: item.title, html: template(item) },
      });
      if (mailError) throw new Error(mailError.message);
      sent += 1;
      await supabase.rpc("notify_outbox_finish", {
        p_id: item.id, p_status: "sent", p_error: null,
        p_deliveries: [{ channel: "mail", target: domain, status: "sent", detail: "" }],
      });
    } catch (err) {
      failed += 1;
      const detail = String(err).slice(0, 160);
      await supabase.rpc("notify_outbox_finish", {
        p_id: item.id, p_status: "failed", p_error: detail,
        p_deliveries: [{ channel: "mail", target: domain, status: "failed", detail }],
      });
    }
  }));

  return json({ ok: true, claimed: items.length, sent, failed, skipped });
});
