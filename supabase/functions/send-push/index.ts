// The push sender. It drains public.notify_outbox and delivers each queued
// notification to that person's subscribed devices with standards-based Web
// Push (VAPID) — no paid provider, no Firebase SDK, nothing beyond what every
// modern browser already implements.
//
// It takes NO title or body from the caller. The old version did, which meant
// any signed-in browser could invoke it with someone else's staff id and put
// arbitrary text on that person's lock screen. Now the caller can only say
// "there is work queued"; what gets sent is whatever notify_raise already
// wrote to the outbox, with the amount already stripped from sensitive
// categories by notify_push_body(). The private VAPID key stays here, as a
// Supabase secret, and never reaches the client bundle.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY") ?? "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:ajumaah@larsaeng.com";

const configured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (configured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

type Device = { endpoint: string; p256dh: string; auth: string };
type OutboxItem = {
  id: string;
  notificationId: string | null;
  userUid: string;
  category: string;
  title: string;
  body: string;
  url: string;
  attempts: number;
  suppressed: string | null;
  devices: Device[];
};

// A delivery record should not be a second copy of the endpoint: the full URL
// is a capability that can push to that device. The host alone is enough to
// tell an Apple failure from a Google one when reading the log later.
function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return "unknown"; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!configured) {
    // Not an error: a deployment without VAPID keys is a deployment where the
    // bell still works perfectly and only the external layer is absent.
    return Response.json({ ok: true, skipped: "VAPID keys are not configured", sent: 0 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  let batch = 50;
  try {
    const parsed = await req.json();
    if (parsed && Number.isFinite(parsed.limit)) batch = Math.min(Math.max(parsed.limit, 1), 200);
  } catch { /* an empty body is the normal case — "drain whatever is queued" */ }

  const { data: claim, error: claimError } = await supabase.rpc("notify_outbox_claim", { p_limit: batch });
  if (claimError) return Response.json({ ok: false, error: claimError.message }, { status: 500 });

  const items: OutboxItem[] = claim?.items ?? [];
  let sent = 0, failed = 0, skipped = 0;

  await Promise.all(items.map(async (item) => {
    const deliveries: { channel: string; target: string; status: string; detail: string }[] = [];

    // Preferences and quiet hours were already resolved by notify_outbox_claim,
    // so "should this go out" is decided in one place rather than two.
    if (item.suppressed) {
      deliveries.push({ channel: "push", target: "-", status: "skipped", detail: item.suppressed });
      skipped += 1;
      await supabase.rpc("notify_outbox_finish", {
        p_id: item.id, p_status: "skipped", p_error: item.suppressed, p_deliveries: deliveries,
      });
      return;
    }
    if (!item.devices.length) {
      deliveries.push({ channel: "push", target: "-", status: "skipped", detail: "no subscribed devices" });
      skipped += 1;
      await supabase.rpc("notify_outbox_finish", {
        p_id: item.id, p_status: "skipped", p_error: "no devices", p_deliveries: deliveries,
      });
      return;
    }

    const payload = JSON.stringify({
      title: item.title,
      body: item.body,
      url: item.url,
      tag: item.notificationId ?? item.id,
      category: item.category,
      notificationId: item.notificationId,
    });

    let anySent = false;
    let lastError = "";
    await Promise.all(item.devices.map(async (device) => {
      const host = endpointHost(device.endpoint);
      try {
        await webpush.sendNotification(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          payload,
          { TTL: 60 * 60 * 24 },
        );
        anySent = true;
        deliveries.push({ channel: "push", target: host, status: "sent", detail: "" });
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        lastError = `${host}: ${status ?? ""} ${String(err).slice(0, 160)}`;
        if (status === 404 || status === 410) {
          // The browser dropped this subscription — a reinstalled app, a wiped
          // profile, a replaced phone. Pruning it is what stops every future
          // send from carrying a permanent failure for hardware nobody owns.
          await supabase.rpc("notify_prune_device", { p_endpoint: device.endpoint });
          deliveries.push({ channel: "push", target: host, status: "expired", detail: "subscription gone" });
        } else {
          deliveries.push({ channel: "push", target: host, status: "failed", detail: String(status ?? err).slice(0, 160) });
        }
      }
    }));

    if (anySent) sent += 1; else failed += 1;
    await supabase.rpc("notify_outbox_finish", {
      p_id: item.id,
      // One device out of three failing is not a failed notification: the
      // person got it. Only nothing-got-through counts as a failure.
      p_status: anySent ? "sent" : "failed",
      p_error: anySent ? null : lastError.slice(0, 400),
      p_deliveries: deliveries,
    });
  }));

  return Response.json({ ok: true, claimed: items.length, sent, failed, skipped });
});
