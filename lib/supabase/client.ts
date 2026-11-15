"use client";

/* A single Supabase browser client, created only if both env vars are set.
 * Every other file in this folder imports getSupabaseClient() instead of
 * calling createClient() directly, so "Supabase isn't configured" stays a
 * single, well-defined state (null) instead of a scattered set of checks. */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

// A stalled token request can hold the SDK session lock across every
// workspace retry. Cancel the transport so the SDK can release that lock.
const fetchWithAuthDeadline: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!new URL(url).pathname.startsWith("/auth/v1/")) return fetch(input, init);
  const controller = new AbortController();
  const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const abort = () => controller.abort();
  if (upstream?.aborted) abort();
  else upstream?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    // Auth responses are small. Keep the deadline active until their body is
    // present, because the connection can stall after sending the headers.
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = response.body ? await response.arrayBuffer() : null;
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener("abort", abort);
  }
};

export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  cached = url && anonKey ? createClient(url, anonKey, { global: { fetch: fetchWithAuthDeadline } }) : null;
  return cached;
}

export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
