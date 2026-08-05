/* Three-way merge for the shared localStorage blobs.
 *
 * Why this exists. Every browser in the company reads and writes the SAME
 * JSON document per key — larsaStaffV8 holds the staff directory, the clock
 * logs, the points rows, the requests and each person's trusted devices. Two
 * people doing unrelated things at the same moment (one clocks in, another
 * signs up) both rewrite that whole document.
 *
 * The sync layer used to resolve that collision by replacing one document
 * with the other: whichever copy was newer won outright and the other
 * device's edit was discarded. That is why a brand-new account could vanish
 * seconds after it was created ("no account found for that email"), and why
 * the "this device is verified" stamp kept disappearing so a PIN sign-in
 * asked for an emailed code every single time. Nothing was wrong with either
 * write — they were simply thrown away by the other one.
 *
 * The fix is to merge instead of replace. We have all three sides:
 *
 *   base   the copy this device and the server last agreed on
 *   local  what this device has now
 *   remote what the server has now
 *
 * so a change can be attributed to the side that actually made it, and both
 * sides' work survives. The rules are deliberately boring:
 *
 *   - a side that did not change something never overrides the side that did;
 *   - records are matched by id, so an add on either side is kept and a
 *     deliberate delete on either side is honoured;
 *   - only when BOTH sides changed the very same field does one have to win,
 *     and there this device wins, because it is the edit the person in front
 *     of us just made.
 *
 * Pure and dependency-free on purpose: it is unit-tested directly, which is
 * the only honest way to trust a merge.
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

function isPlainObject(value: Json): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* Structural equality. JSON.stringify would be shorter but compares key
   ORDER too, so two identical objects built by different spreads would read
   as different and every merge would look like a conflict. */
export function deepEqual(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}

/* Records are matched by id. Everything this app stores in an array — users,
   logs, approvals, performance rows, devices, notifications — carries one. An
   array without ids cannot be matched item by item, so it is treated as a
   single value instead of being merged element-wise (which would interleave
   two unrelated orderings into nonsense). */
function idOf(value: Json): string | null {
  if (!isPlainObject(value)) return null;
  const id = value.id;
  if (typeof id === "string" && id) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

function isKeyedArray(value: Json): value is JsonObject[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => idOf(item) !== null);
}

function indexById(rows: JsonObject[]): Map<string, JsonObject> {
  const map = new Map<string, JsonObject>();
  rows.forEach((row) => {
    const id = idOf(row);
    if (id !== null) map.set(id, row);
  });
  return map;
}

/* Merge two versions of a list of records against the version they both came
   from. Remote's ordering is kept (it is the copy everyone else already sees)
   and anything this device added is appended. */
function mergeKeyedArrays(base: Json, local: JsonObject[], remote: JsonObject[]): Json {
  const baseRows = isKeyedArray(base) ? indexById(base) : new Map<string, JsonObject>();
  const localRows = indexById(local);

  const merged: Json[] = [];
  const taken = new Set<string>();

  remote.forEach((remoteRow) => {
    const id = idOf(remoteRow);
    if (id === null || taken.has(id)) return;
    taken.add(id);
    const localRow = localRows.get(id);
    if (localRow === undefined) {
      /* Missing here. If it existed in the copy we started from, this device
         deliberately removed it — honour that. If it did not, somebody else
         has just added it, so keep theirs. */
      if (!baseRows.has(id)) merged.push(remoteRow);
      return;
    }
    merged.push(mergeValues(baseRows.get(id), localRow, remoteRow));
  });

  local.forEach((localRow) => {
    const id = idOf(localRow);
    if (id === null || taken.has(id)) return;
    taken.add(id);
    /* Not on the server. Either this device just created it — a brand-new
       account is exactly this case — or somebody else deleted it. */
    if (!baseRows.has(id)) merged.push(localRow);
  });

  return merged;
}

/* The merge itself. `base` may be undefined when this device has never seen
   the value before, which simply means "no shared history": then any
   difference is treated as this device's own addition. */
export function mergeValues(base: Json, local: Json, remote: Json): Json {
  if (deepEqual(local, remote)) return local;
  // One side left it exactly as it was — the other side's change stands.
  if (deepEqual(local, base)) return remote;
  if (deepEqual(remote, base)) return local;

  if (isPlainObject(local) && isPlainObject(remote)) {
    const baseObject = isPlainObject(base) ? base : {};
    const out: JsonObject = {};
    // Remote's keys first so the shared shape keeps a stable order.
    const keys = [...Object.keys(remote), ...Object.keys(local).filter((key) => !(key in remote))];
    keys.forEach((key) => {
      const inLocal = Object.prototype.hasOwnProperty.call(local, key);
      const inRemote = Object.prototype.hasOwnProperty.call(remote, key);
      const inBase = Object.prototype.hasOwnProperty.call(baseObject, key);
      if (!inLocal) {
        // Dropped here on purpose if we had it; otherwise it is new from them.
        if (!inBase) out[key] = remote[key];
        return;
      }
      if (!inRemote) {
        if (!inBase) out[key] = local[key];
        return;
      }
      out[key] = mergeValues(baseObject[key], local[key], remote[key]);
    });
    return out;
  }

  if (isKeyedArray(local) && isKeyedArray(remote)) {
    return mergeKeyedArrays(base, local, remote);
  }
  /* An emptied list still has to merge against a populated one — that is a
     "cleared everything here" edit, and the branches above already proved
     only one side changed it, so honouring the empty side is correct. */
  if (Array.isArray(local) && Array.isArray(remote) && (isKeyedArray(local) || isKeyedArray(remote))) {
    return mergeKeyedArrays(base, local as JsonObject[], remote as JsonObject[]);
  }

  /* Both sides changed the same plain value. Somebody has to win, and it is
     the person in front of this browser: their edit is the one being saved
     right now, and the other copy is still on the device that made it. */
  return local;
}

/* What the sync layer calls: merge two stored documents and hand back the
   text to save. Anything unparseable falls back to the remote copy, which is
   the one every other device already agrees on. */
export function mergeStoreText(baseText: string | null | undefined, localText: string | null | undefined, remoteValue: Json): Json {
  let base: Json;
  let local: Json;
  try { base = baseText ? JSON.parse(baseText) : undefined; } catch { base = undefined; }
  try { local = localText ? JSON.parse(localText) : undefined; } catch { return remoteValue; }
  if (local === undefined) return remoteValue;
  return mergeValues(base, local, remoteValue);
}
