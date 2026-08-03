"use client";

/* Real background Web Push — arrives even when every tab is closed, which is
 * what makes an installed PWA behave like an app rather than a bookmark.
 *
 * Three things are needed for delivery to actually happen:
 *   1. NEXT_PUBLIC_VAPID_PUBLIC_KEY — safe to expose; it identifies this app
 *      to the browser's push service and nothing more.
 *   2. VAPID_PRIVATE_KEY + VAPID_PUBLIC_KEY as secrets on the Supabase
 *      project's Edge Functions, used only by send-push, never shipped.
 *   3. Supabase configured at all — without it this module is a no-op and the
 *      bell falls back to local-only, exactly like lib/supabase/sync.ts.
 *
 * The subscription is stored through notify_register_device, not by writing to
 * push_subscriptions directly: that table has no client grants any more,
 * because a policy of USING (true) meant every browser holding the anon key
 * could read every push endpoint in the company. */
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

/* iOS only grants push to a PWA that has actually been added to the Home
 * Screen — in Safari's normal browsing tab the API exists and silently never
 * delivers. Telling someone "allow notifications" on a screen where allowing
 * them cannot work is worse than telling them nothing, so the settings screen
 * asks this first and shows the Add to Home Screen instructions instead. */
export function pushNeedsHomeScreen(): boolean {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === "MacIntel" && (navigator as unknown as { maxTouchPoints: number }).maxTouchPoints > 1);
  if (!iOS) return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return !standalone;
}

/* A name a person will recognise in a device list six months from now. The
 * user agent is the only signal available, so this stays coarse on purpose:
 * "iPhone · Safari" is useful, a version string is not. */
export function describeThisDevice(): { label: string; platform: string } {
  if (typeof navigator === "undefined") return { label: "This device", platform: "unknown" };
  const ua = navigator.userAgent || "";
  const platform =
    /iPad/.test(ua) ? "iPad"
    : /iPhone|iPod/.test(ua) ? "iPhone"
    : /Android/.test(ua) ? "Android"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux"
    : "Device";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Chrome\//.test(ua) && !/Edg\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  const installed = typeof window !== "undefined"
    && (window.matchMedia?.("(display-mode: standalone)").matches
      || (window.navigator as unknown as { standalone?: boolean }).standalone === true);
  return { label: `${platform} · ${installed ? "Installed app" : browser}`, platform };
}

export type PushOutcome = {
  ok: boolean;
  message: string;
  /* Distinguishes "the person said no" from "this browser cannot" from "this
   * deployment has no keys" — three different problems with three different
   * things to tell someone, which a single boolean would flatten. */
  state: "granted" | "denied" | "unsupported" | "unconfigured" | "needs-home-screen" | "error";
};

/* Requests permission if needed, subscribes this browser to the push service,
 * and registers the subscription against the signed-in staff id. */
export async function subscribeToPush(staffUid: string, staffName?: string): Promise<PushOutcome> {
  if (!pushSupported()) {
    return { ok: false, state: "unsupported", message: "This browser does not support push notifications." };
  }
  if (pushNeedsHomeScreen()) {
    return {
      ok: false, state: "needs-home-screen",
      message: "On iPhone and iPad, add Larsa Control to your Home Screen first — Safari only delivers notifications to the installed app.",
    };
  }
  const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!supabaseConfigured() || !vapidKey) {
    return { ok: false, state: "unconfigured", message: "Alerts outside the app aren't configured for this deployment yet." };
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return {
      ok: false, state: "denied",
      message: permission === "denied"
        ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
        : "Push notifications were not allowed.",
    };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const desiredKey = urlBase64ToUint8Array(vapidKey);
    let subscription = await registration.pushManager.getSubscription();
    // A subscription can already exist under an OLD VAPID key (e.g. after a
    // key rotation) -- getSubscription() happily returns it, but the push
    // service silently rejects anything signed with the new private key.
    // Drop it here so the block below creates a fresh one under this key.
    if (subscription) {
      const existingKey = subscription.options?.applicationServerKey
        ? new Uint8Array(subscription.options.applicationServerKey)
        : null;
      const sameKey = !!existingKey && existingKey.length === desiredKey.length
        && existingKey.every((byte, idx) => byte === desiredKey[idx]);
      if (!sameKey) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: desiredKey as BufferSource,
      });
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return { ok: false, state: "error", message: "Could not read this browser's push subscription." };
    }
    const client = getSupabaseClient();
    if (!client) {
      return { ok: false, state: "unconfigured", message: "Alerts outside the app aren't configured for this deployment yet." };
    }
    const device = describeThisDevice();
    const { error } = await client.rpc("notify_register_device", {
      actor: { id: staffUid, name: staffName || "" },
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_label: device.label,
      p_ua: navigator.userAgent || "",
      p_platform: device.platform,
    });
    if (error) return { ok: false, state: "error", message: `Could not save this device: ${error.message}` };
    return { ok: true, state: "granted", message: `Alerts are on for ${device.label}.` };
  } catch (err) {
    return { ok: false, state: "error", message: `Could not enable alerts: ${String(err).slice(0, 140)}` };
  }
}

/* Used both by "turn alerts off on this device" and by signing out. Both halves
 * matter: unsubscribing without deleting the row leaves the sender pushing at a
 * dead endpoint forever, and deleting without unsubscribing leaves the browser
 * holding a subscription nothing will ever use. */
export async function unsubscribeFromPush(staffUid?: string): Promise<void> {
  if (!pushSupported()) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    const client = getSupabaseClient();
    if (client && staffUid) {
      await client.rpc("notify_forget_device", { actor: { id: staffUid }, p_endpoint: endpoint });
    }
  } catch { /* the device is going away anyway; never block sign-out on this */ }
}

/* Whether THIS browser currently holds a live subscription, which is a
 * different question from Notification.permission: permission can be granted
 * while the subscription was dropped by the browser or removed from another
 * device's session. */
export async function thisDeviceSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(await registration.pushManager.getSubscription());
  } catch {
    return false;
  }
}

/* Whether this device can ACTUALLY display a notification, as opposed to
 * merely having granted permission to try.
 *
 * These are different questions and only the first one matters. When Windows,
 * macOS or Android suppresses a browser's notifications at the operating
 * system level — Do Not Disturb, Focus Assist, or the browser switched off in
 * the OS notification list — showNotification() still resolves successfully.
 * Nothing throws. The permission still reads "granted". The notification is
 * simply discarded, and the app has no idea.
 *
 * That is how somebody ends up pressing "Send a test", being told it was sent,
 * seeing nothing, and reasonably concluding the software is broken. So the
 * test posts a real notification and then asks whether it exists: if the
 * platform swallowed it, getNotifications() comes back empty and we can say
 * so instead of claiming success. */
export async function canDisplayNotifications(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  try {
    const registration = await navigator.serviceWorker.ready;
    const tag = "larsa-display-check";
    await registration.showNotification("Larsa Control", {
      body: "Checking notifications on this device…",
      tag,
      // Silent and instantly withdrawn: this is a probe, not a message. If the
      // platform DOES show it, it is gone again before anyone reads it.
      silent: true,
      icon: "/icons/notify-192.png",
      badge: "/icons/badge-96.png",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const found = await registration.getNotifications({ tag });
    found.forEach((notification) => notification.close());
    return found.length > 0;
  } catch {
    return false;
  }
}

/* Sets the app-icon badge through the service worker so it stays right even
 * with several tabs open, and after the last one is closed. */
export function setAppBadge(count: number): void {
  if (typeof navigator === "undefined") return;
  try {
    navigator.serviceWorker?.ready?.then((registration) => {
      registration.active?.postMessage({ type: "larsa:badge", count });
    }).catch(() => {});
    const nav = navigator as unknown as { setAppBadge?: (n?: number) => void; clearAppBadge?: () => void };
    if (count > 0) nav.setAppBadge?.(count);
    else nav.clearAppBadge?.();
  } catch { /* badging unsupported on this platform */ }
}
