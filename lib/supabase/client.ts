"use client";

/* A single Supabase browser client, created only if both env vars are set.
 * Every other file in this folder imports getSupabaseClient() instead of
 * calling createClient() directly, so "Supabase isn't configured" stays a
 * single, well-defined state (null) instead of a scattered set of checks. */
import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (cached !== undefined) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  cached = url && anonKey ? createClient(url, anonKey) : null;
  return cached;
}

export function supabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
