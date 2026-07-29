"use client";

/* Real background Web Push — covers both "web" (desktop browser tab closed)
 * and "phone" (installed PWA) notifications, unlike the foreground-only
 * `new Notification()` calls already used elsewhere in the app. Needs three
 * things to actually deliver, all documented in .env.local.example:
 *   1. NEXT_PUBLIC_VAPID_PUBLIC_KEY (safe to expose; identifies this app to
 *      the browser's push service).
 *   2. VAPID_PRIVATE_KEY + VAPID_PUBLIC_KEY set as secrets on the Supabase
 *      project's Edge Functions (used only server-side, by send-push).
 *   3. Supabase configured (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY) — without it
 *      this whole module is a no-op, exactly like lib/supabase/sync.ts. */
import { getSupabaseClient, supabaseConfigured } from "./client";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export function pushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && typeof Notification !== "undefined";
}

/* Requests permission (if needed), subscribes this browser to the push
 * service, and upserts the subscription under the signed-in staff member's
 * id so send-push knows who to reach. Returns a human-readable outcome. */
export async function subscribeToPush(staffUid: string): Promise<string> {
  if (!pushSupported()) return "This browser does not support push notifications.";
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!supabaseConfigured() || !vapidKey) {
    return "Push notifications aren't configured for this deployment yet.";
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "Push notifications were not allowed.";

  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
    });
  }
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return "Could not read this browser's push subscription.";
  }
  const client = getSupabaseClient();
  if (!client) return "Push notifications aren't configured for this deployment yet.";
  const { error } = await client.from("push_subscriptions").upsert(
    { staff_uid: staffUid, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth },
    { onConflict: "endpoint" },
  );
  if (error) return `Could not save this subscription: ${error.message}`;
  return "Push notifications are enabled on this device.";
}

export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  const client = getSupabaseClient();
  if (client) await client.from("push_subscriptions").delete().eq("endpoint", endpoint);
}

/* Fire-and-forget: asks the send-push Edge Function to deliver a real push
 * to every device the given staff member has subscribed on. Never throws —
 * a failed push should never block the in-app notification it rides with. */
export function sendPush(staffUid: string, title: string, body: string, url?: string): void {
  if (!supabaseConfigured()) return;
  const client = getSupabaseClient();
  if (!client) return;
  client.functions.invoke("send-push", { body: { staffUid, title, body, url } }).catch(() => {
    // Best-effort only; the in-app notification already covers this event.
  });
}
