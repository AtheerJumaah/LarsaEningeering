"use client";

/* How sign-in secrets are stored for the staff records in the larsaStaffV8
 * blob.
 *
 * That blob syncs to Supabase and down into every colleague's browser, so a
 * password kept in it as ordinary text is readable by anyone who can reach the
 * table or who ends up with a copy of the data. The app was built comparing
 * the typed password against exactly that stored text, which is what this
 * module replaces.
 *
 * What gets stored instead is the output of PBKDF2-SHA256 over the secret and
 * a random per-account salt:
 *
 *     pbkdf2$<iterations>$<salt base64>$<derived key base64>
 *
 * The secret itself is never written down. Signing in re-derives the key from
 * what was typed and compares the results, so the stored value proves a
 * password without revealing it. The salt is per account, so two people who
 * pick the same password still store different values and cracking one tells
 * an attacker nothing about the next.
 *
 * PBKDF2 rather than bcrypt or argon2 because it is built into the browser and
 * into Deno (which is what the migration function runs on), so the same
 * derivation exists on both sides with nothing to install and no WASM to ship
 * to a phone on an Iraqi mobile connection. 210,000 iterations is OWASP's
 * current floor for PBKDF2-SHA256.
 *
 * A caveat worth stating plainly, because hashing can look like more
 * protection than it is: a 4-digit PIN has only ten thousand possible values,
 * so anyone holding this data can derive all of them and match every PIN
 * regardless of the hashing. Hashing a PIN stops somebody reading it over your
 * shoulder in the Supabase table; it does not make a short PIN secret. Only
 * length does that.
 */

const PREFIX = "pbkdf2";
const KEY_BITS = 256;
const SALT_BYTES = 16;

export const PASSWORD_ITERATIONS = 210000;

/* Signing in with a PIN has to test the entered PIN against every account,
 * because a salted hash cannot be looked up -- there is no way to know whose
 * PIN it is without trying each one. At 210,000 iterations that is twenty-odd
 * derivations on a phone and a visible wait on the shop floor, which is the
 * one place this app has to be instant. The lower count keeps that under a
 * second. It buys less against offline cracking, but as noted above the PIN's
 * length is what decides that anyway.
 */
export const PIN_ITERATIONS = 60000;

function subtle(): SubtleCrypto | null {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  return crypto.subtle;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derive(secret: string, salt: BufferSource, iterations: number): Promise<string> {
  const api = subtle();
  if (!api) throw new Error("Web Crypto is unavailable");
  const material = await api.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await api.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, material, KEY_BITS);
  return toBase64(new Uint8Array(bits));
}

/* True for a value already in the stored format above. Anything else is a
   secret left over from before this module existed. */
export function isHashed(stored: string | undefined | null): boolean {
  return typeof stored === "string" && stored.slice(0, PREFIX.length + 1) === PREFIX + "$";
}

/* Whether a stored value should be rewritten after a successful sign-in. */
export function needsUpgrade(stored: string | undefined | null): boolean {
  return Boolean(stored) && !isHashed(stored);
}

async function hashSecret(secret: string, iterations: number): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await derive(secret, salt, iterations);
  return [PREFIX, String(iterations), toBase64(salt), key].join("$");
}

export function hashPassword(password: string): Promise<string> {
  return hashSecret(password, PASSWORD_ITERATIONS);
}

export function hashPin(pin: string): Promise<string> {
  return hashSecret(String(pin).trim(), PIN_ITERATIONS);
}

/* Length-independent comparison. The threat here is modest -- this runs in the
   user's own browser against a value they already hold -- but there is no
   reason to leak how much of a guess was right. */
function sameSecret(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/* Accepts either format on purpose. Accounts still holding a pre-hash secret
   have to keep working until they next sign in, at which point the caller
   re-saves them hashed; refusing them here would lock out the whole company
   the moment this shipped. */
export async function verifySecret(entered: string, stored: string | undefined | null): Promise<boolean> {
  const candidate = String(entered || "");
  const saved = String(stored || "");
  if (!candidate || !saved) return false;

  if (!isHashed(saved)) return sameSecret(candidate.trim(), saved.trim());

  const parts = saved.split("$");
  if (parts.length !== 4) return false;
  const iterations = Number(parts[1]);
  if (!iterations || Number.isNaN(iterations)) return false;

  try {
    const key = await derive(candidate, fromBase64(parts[2]), iterations);
    return sameSecret(key, parts[3]);
  } catch {
    // A browser with no Web Crypto (only possible over plain http, which this
    // app is never served on) cannot check a hash. Fail closed.
    return false;
  }
}

export const verifyPassword = verifySecret;

export function verifyPin(entered: string, stored: string | undefined | null): Promise<boolean> {
  return verifySecret(String(entered).trim(), stored);
}

type PinRow = { pin?: string; enabled?: boolean };

/* Finds whose PIN was typed. Salted hashes cannot be searched, so this walks
   the list and stops at the first match. Disabled accounts are skipped before
   any derivation, both because they must not sign in and because skipping them
   keeps the walk short. */
export async function findByPin<Row extends PinRow>(rows: Row[], enteredPin: string): Promise<Row | null> {
  const candidate = String(enteredPin || "").trim();
  if (!candidate) return null;
  for (const row of rows) {
    if (row.enabled === false) continue;
    if (!row.pin) continue;
    // Sequential on purpose: the common case matches early, and firing twenty
    // key derivations at once would jam the main thread on a cheap phone.
    if (await verifySecret(candidate, row.pin)) return row;
  }
  return null;
}

/* True if this PIN already belongs to somebody else. Used when an
   administrator sets a PIN: with salted hashes two identical PINs no longer
   look identical in storage, so the old equality check silently stopped
   catching duplicates -- and a duplicate PIN means one person signs in as
   another, since PIN sign-in takes the first match. */
export async function pinTakenByOther<Row extends PinRow & { id?: string }>(
  rows: Row[],
  enteredPin: string,
  exceptId: string | undefined,
): Promise<boolean> {
  const candidate = String(enteredPin || "").trim();
  if (!candidate) return false;
  for (const row of rows) {
    if (row.id && row.id === exceptId) continue;
    if (!row.pin) continue;
    if (await verifySecret(candidate, row.pin)) return true;
  }
  return false;
}
