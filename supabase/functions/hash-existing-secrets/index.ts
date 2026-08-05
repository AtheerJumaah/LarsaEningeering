// Converts readable passwords and PINs in the larsaStaffV8 staff blob into
// PBKDF2 hashes, in exactly the format lib/password.ts derives and checks.
//
// Idempotent: anything already in pbkdf2$ form is skipped, and it returns only
// counts, never a secret. Sign-in accepts both formats, so running this cannot
// lock anybody out.
//
// This ran once on 2026-07-31 and had to run again on 2026-08-01 because a
// browser holding a pre-migration copy of the blob overwrote the shared record
// wholesale. lib/supabase/sync.ts now refuses a write built on a stale copy,
// which is what makes a second re-run unnecessary rather than inevitable.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const STORE_KEY = "larsaStaffV8";
const PREFIX = "pbkdf2";
const KEY_BITS = 256;
const SALT_BYTES = 16;

// Must stay identical to lib/password.ts or nothing will verify.
const PASSWORD_ITERATIONS = 210000;
const PIN_ITERATIONS = 60000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function isHashed(value: unknown): boolean {
  return typeof value === "string" && value.slice(0, PREFIX.length + 1) === PREFIX + "$";
}

async function hashSecret(secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, KEY_BITS);
  return [PREFIX, String(iterations), toBase64(salt), toBase64(new Uint8Array(bits))].join("$");
}

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" });

  let dryRun = false;
  let secret = "";
  try {
    const body = await req.json();
    dryRun = Boolean(body && body.dryRun);
    secret = String(body && body.secret || "");
  } catch {
    // No body means a real run.
  }

  /* One-off migration endpoint that rewrites the staff store. Its job is
     done; it stays deployed only as a maintenance tool, and a maintenance
     tool must not be callable by everyone holding the browser bundle's anon
     key. Same gate the auth-policy stamp op uses. */
  if (secret !== (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "")) {
    return json({ ok: false, error: "Not authorized." }, 403);
  }

  const { data: row, error: readError } = await db
    .from("app_state")
    .select("data")
    .eq("store_key", STORE_KEY)
    .maybeSingle();

  if (readError || !row) return json({ ok: false, error: "Could not read the staff store." }, 500);

  const store = row.data as { users?: Record<string, unknown>[] };
  const users = Array.isArray(store.users) ? store.users : [];

  let passwordsHashed = 0;
  let pinsHashed = 0;

  for (const user of users) {
    const password = user.password;
    if (typeof password === "string" && password.trim() && !isHashed(password)) {
      // Sign-in trims what was typed, so hash the trimmed value or a stored
      // password with stray whitespace stops matching.
      user.password = await hashSecret(password.trim(), PASSWORD_ITERATIONS);
      passwordsHashed += 1;
    }
    const pin = user.pin;
    if (typeof pin === "number") {
      user.pin = await hashSecret(String(pin).trim(), PIN_ITERATIONS);
      pinsHashed += 1;
    } else if (typeof pin === "string" && pin.trim() && !isHashed(pin)) {
      user.pin = await hashSecret(pin.trim(), PIN_ITERATIONS);
      pinsHashed += 1;
    }
  }

  if (dryRun) return json({ ok: true, dryRun: true, users: users.length, passwordsHashed, pinsHashed });

  const { error: writeError } = await db
    .from("app_state")
    .update({ data: { ...store, users }, updated_at: new Date().toISOString() })
    .eq("store_key", STORE_KEY);

  if (writeError) return json({ ok: false, error: "Could not write the staff store back." }, 500);

  return json({ ok: true, users: users.length, passwordsHashed, pinsHashed });
});
