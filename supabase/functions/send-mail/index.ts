// Sends an email through Microsoft Graph as the notifications@larsaeng.com
// shared mailbox. Called from the browser via supabase.functions.invoke,
// authenticated with the same anon session the rest of the app already uses
// (see lib/supabase/mail.ts). The Graph client secret never leaves this
// function -- it lives only as a Supabase secret (MS_GRAPH_CLIENT_SECRET),
// never in the client bundle.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const TENANT_ID = Deno.env.get("MS_GRAPH_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("MS_GRAPH_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("MS_GRAPH_CLIENT_SECRET")!;
const SENDER = Deno.env.get("MS_GRAPH_SENDER") || "notifications@larsaeng.com";

// Browsers send a preflight before any cross-origin POST carrying an
// Authorization header, and discard a reply that lacks these headers. Without
// them every in-app send (notifications, verification codes) fails silently
// in the browser while working fine from curl.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Graph token request failed (${res.status})`); // body deliberately not echoed to callers
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return cachedToken.value;
}

function toRecipients(addresses: string | string[]) {
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.map((address) => ({ emailAddress: { address } }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS });
  }
  try {
    const { to, subject, html, cc } = await req.json();
    if (!to || !subject || !html) {
      return new Response(JSON.stringify({ error: "to, subject, and html are required" }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const token = await getAccessToken();
    const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: "HTML", content: html },
          toRecipients: toRecipients(to),
          ...(cc ? { ccRecipients: toRecipients(cc) } : {}),
        },
        saveToSentItems: true,
      }),
    });
    if (!res.ok) throw new Error(`Graph sendMail failed (${res.status})`); // body deliberately not echoed to callers
    return new Response(JSON.stringify({ sent: true }), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
