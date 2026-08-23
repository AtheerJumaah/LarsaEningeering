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
 * ---- The August lesson: absence is not deletion --------------------------
 *
 * For the two collections everything depends on — `users` (accounts,
 * passwords, lifecycle flags) and `logs` (clock punches) — the base-absence
 * inference above proved catastrophically unsafe. The legacy engine iframes
 * keep the whole document in memory and save it back wholesale; a copy
 * loaded an hour ago is missing every row added since, and the merge read
 * each of those gaps as a deliberate delete. Two thirds of the production
 * clock log ended up carrying a "ledger-restore" recovery mark from the
 * resulting lose-and-restore churn.
 *
 * So for `users` and `logs` the rules are now:
 *
 *   - a row the server has NEVER leaves the merged result because a local
 *     copy lacks it — the server's document is protected by its own healing
 *     trigger (repair_008) and is authoritative on existence;
 *   - a local-only row is kept (it is this device's own addition) UNLESS its
 *     id appears in a tombstone list — then it is a stale resurrection and
 *     is dropped before it can be pushed;
 *   - deletion happens ONLY through the tombstone lists (`removedUserIds`,
 *     `removedLogIds`), which every deliberate removal path writes, and
 *     which merge as an add-only UNION so a stale device can never shorten
 *     them back (that is precisely how repair_005's tombstones were wiped).
 *
 * Every other collection keeps the original base-aware behaviour.
 *
 * Pure and dependency-free on purpose: it is unit-tested directly, which is
 * the only honest way to trust a merge.
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

/* The collections that may only shrink with evidence, and the tombstone
   list each one honours. */
export const GUARDED_COLLECTIONS: Record<string, string> = {
  users: "removedUserIds",
  logs: "removedLogIds",
};
const TOMBSTONE_KEYS = new Set(Object.values(GUARDED_COLLECTIONS));

type MergeContext = {
  /* collection key ("users" / "logs") -> union of tombstoned ids across
     base, local and remote. */
  tombstones: Map<string, Set<string>>;
};

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

function stringList(value: Json): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item !== "")
        : [];
}

/* Add-only union of two tombstone lists, keeping the first list's order and
   appending anything only the second one has. */
export function unionIds(first: Json, second: Json): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    [...stringList(first), ...stringList(second)].forEach((id) => {
          if (!seen.has(id)) { seen.add(id); out.push(id); }
    });
    return out;
}

function buildContext(...documents: Json[]): MergeContext {
    const tombstones = new Map<string, Set<string>>();
    Object.entries(GUARDED_COLLECTIONS).forEach(([collection, listKey]) => {
          const ids = new Set<string>();
          documents.forEach((doc) => {
                  if (!isPlainObject(doc)) return;
                  stringList(doc[listKey]).forEach((id) => ids.add(id));
          });
          tombstones.set(collection, ids);
    });
    return { tombstones };
}

/* ---- Recency of EDIT beats recency of WRITE --------------------------------
   A record that carries a touchedAt stamp (ISO server time, written by every
   deliberate edit — staff accounts get one from the Access Center and the
   lifecycle handlers) resolves a conflict by WHEN IT WAS LAST EDITED, not by
   which copy happened to be saved last. This is what stops the observed
   role/name reverts: a browser (usually a legacy engine iframe) holding the
   whole document in memory writes it back wholesale hours later, and that
   stale copy used to look exactly like a fresh deliberate edit. Its records
   still carry their OLD stamps, so now they lose to the server's newer ones —
   while a genuinely new edit carries a fresh stamp and still wins. Records
   without stamps (logs, requests, everything else) behave exactly as before. */
function touchMs(value: Json): number | null {
    if (!isPlainObject(value)) return null;
    const raw = value.touchedAt;
    if (typeof raw !== "string" || !raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
}

function newerByTouch(local: Json, remote: Json): Json | null {
    const localMs = touchMs(local);
    const remoteMs = touchMs(remote);
    if (localMs === null || remoteMs === null || localMs === remoteMs) return null;
    return localMs > remoteMs ? local : remote;
}

/* The push-side twin of the merge rule, for the path where NO merge runs:
   a stale wholesale save whose sync stamp happens to be current is accepted
   by the server verbatim. Called before every push with the freshest server
   copy this device has seen: any stamped record about to be sent OLDER than
   the server's own version is replaced by the server's version, so a stale
   writer can never drag an account backwards. Unstamped records pass
   through untouched. */
export function keepNewestStamped(outgoing: Json, server: Json): Json {
    if (!isPlainObject(outgoing) || !isPlainObject(server)) return outgoing;
    const out: JsonObject = { ...outgoing };
    Object.keys(out).forEach((key) => {
          const ours = out[key];
          const theirs = server[key];
          if (!isKeyedArray(ours) || !isKeyedArray(theirs)) return;
          const theirsById = indexById(theirs);
          out[key] = ours.map((row) => {
                  const other = theirsById.get(idOf(row) ?? "");
                  if (other === undefined) return row;
                  return newerByTouch(row, other) === other ? other : row;
          });
    });
    return out;
}

/* Everything a push must guarantee, in one place — the client half of the
 * repair_008 healing trigger, applied BEFORE the document leaves this
 * device, so even a compare-and-swap that is accepted verbatim cannot
 * destroy anything:
 *
 *   - stamped records are re-anchored to the freshest server copy when the
 *     outgoing one is older (keepNewestStamped, unchanged);
 *   - a users/logs row the server holds that the outgoing copy lacks is put
 *     back, unless a tombstone names it — absence is not deletion;
 *   - an outgoing users/logs row whose id is tombstoned is dropped — a
 *     stale device cannot resurrect a deliberately removed record;
 *   - the tombstone lists themselves go out as the UNION of both sides.
 */
export function protectOutgoing(outgoing: Json, server: Json): Json {
    const anchored = keepNewestStamped(outgoing, server);
    if (!isPlainObject(anchored)) return anchored;
    const serverDoc = isPlainObject(server) ? server : {};
    const out: JsonObject = { ...anchored };

    Object.entries(GUARDED_COLLECTIONS).forEach(([collection, listKey]) => {
          const removed = new Set(unionIds(out[listKey], serverDoc[listKey]));
          const ours = Array.isArray(out[collection]) ? (out[collection] as Json[]) : [];
          const theirs = Array.isArray(serverDoc[collection]) ? (serverDoc[collection] as Json[]) : [];
          if (!ours.length && !theirs.length) return;

          const kept: Json[] = [];
          const seen = new Set<string>();
          ours.forEach((row) => {
                  const id = idOf(row);
                  if (id === null) { kept.push(row); return; }
                  if (seen.has(id)) return;
                  seen.add(id);
                  /* A row the server already knows is never dropped for being
                     tombstoned here — restores are settled server-side, where the
                     account ledger is visible. Only NEW rows (this device's own
                     resurrection candidates) are filtered. */
                  const serverHasIt = theirs.some((other) => idOf(other) === id);
                  if (!serverHasIt && removed.has(id)) return;
                  kept.push(row);
          });
          theirs.forEach((row) => {
                  const id = idOf(row);
                  if (id === null || seen.has(id ?? "")) return;
                  if (id !== null) seen.add(id);
                  if (id !== null && removed.has(id)) return;
                  kept.push(row);
          });
          out[collection] = kept;
          out[listKey] = unionIds(out[listKey], serverDoc[listKey]);
    });
    return out;
}

/* Merge two versions of a list of records against the version they both came
   from. Remote's ordering is kept (it is the copy everyone else already sees)
   and anything this device added is appended.

   `tombstones` is set only for the guarded collections (users/logs): there,
   absence never deletes — a row leaves the result only when a tombstone
   names it. For every other collection it is null and the original
   base-aware inference applies. */
function mergeKeyedArrays(
    base: Json,
    local: JsonObject[],
    remote: JsonObject[],
    context: MergeContext | null,
    tombstones: Set<string> | null,
): Json {
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
                if (tombstones) {
                        /* Guarded collection: the server's row stays UNLESS a tombstone
                           names it — that is the deleting device's own merge honouring
                           its removal. A stale local copy that simply never saw the row
                           carries no tombstone for it and cannot delete it. */
                        if (!tombstones.has(id)) merged.push(remoteRow);
                        return;
                }
                /* Missing here. If it existed in the copy we started from, this device
                   deliberately removed it — honour that. If it did not, somebody else
                   has just added it, so keep theirs. */
          if (!baseRows.has(id)) merged.push(remoteRow);
                return;
        }
        merged.push(mergeValues(baseRows.get(id), localRow, remoteRow, context));
  });

  local.forEach((localRow) => {
        const id = idOf(localRow);
        if (id === null || taken.has(id)) return;
        taken.add(id);
        if (tombstones) {
                /* Local-only row in a guarded collection: this device's own addition
                   is kept — unless a tombstone names it, in which case it is a stale
                   resurrection and dies here, before it can be pushed. */
                if (!tombstones.has(id)) merged.push(localRow);
                return;
        }
        /* Not on the server. Either this device just created it — a brand-new
           account is exactly this case — or somebody else deleted it. */
                    if (!baseRows.has(id)) merged.push(localRow);
  });

  return merged;
}

/* The merge itself. `base` may be undefined when this device has never seen
   the value before, which simply means "no shared history": then any
   difference is treated as this device's own addition. */
export function mergeValues(base: Json, local: Json, remote: Json, context: MergeContext | null = null, key?: string): Json {
    if (deepEqual(local, remote)) return local;

    /* The tombstone lists merge as an add-only union — a stale device saving
       an older, shorter list must never un-remember a removal. */
    if (key !== undefined && TOMBSTONE_KEYS.has(key)
            && (Array.isArray(local) || Array.isArray(remote))) {
          return unionIds(remote, local);
    }

    /* Stamped records are settled by recency of EDIT before anything else —
       including the base shortcuts below. The dangerous case those shortcuts
       cannot tell apart: remote equals base because the server still holds the
       freshly-edited copy, while "local" is a STALE write-back that predates
       it. The stale side's older stamp settles it correctly; a real local edit
       carries a fresher stamp and still wins. */
  const stamped = newerByTouch(local, remote);
    if (stamped !== null) return stamped;

    const guardedTombstones = key !== undefined && context && GUARDED_COLLECTIONS[key]
        ? context.tombstones.get(key) ?? new Set<string>()
        : null;

    // This device left it exactly as it was — the other side's change stands
  // (and the server side can only carry newer stamps, never older ones).
  if (deepEqual(local, base)) return remote;
    /* The mirror shortcut — "remote equals base, so local's change stands" —
       deliberately does NOT fire for containers. At the document level a stale
       wholesale write-back is indistinguishable from a deliberate edit, and
       that shortcut used to hand it the whole store, reverting roles and names
       that were correct on the server. Containers descend instead, so each
       stamped record arbitrates for itself; the shortcut survives further down
       for primitives and unstamped values, where behaviour is unchanged. */
  if (isPlainObject(local) && isPlainObject(remote)) {
        const baseObject = isPlainObject(base) ? base : {};
        const out: JsonObject = {};
        // Remote's keys first so the shared shape keeps a stable order.
      const keys = [...Object.keys(remote), ...Object.keys(local).filter((key) => !(key in remote))];
        keys.forEach((childKey) => {
                const inLocal = Object.prototype.hasOwnProperty.call(local, childKey);
                const inRemote = Object.prototype.hasOwnProperty.call(remote, childKey);
                const inBase = Object.prototype.hasOwnProperty.call(baseObject, childKey);
                if (!inLocal) {
                          /* Dropped here on purpose if we had it; otherwise it is new from
                             them. A guarded collection or tombstone list is never dropped
                             wholesale by local absence. */
                  if (!inBase || GUARDED_COLLECTIONS[childKey] || TOMBSTONE_KEYS.has(childKey)) out[childKey] = remote[childKey];
                          return;
                }
                if (!inRemote) {
                          if (!inBase) out[childKey] = local[childKey];
                          return;
                }
                out[childKey] = mergeValues(baseObject[childKey], local[childKey], remote[childKey], context, childKey);
        });
        return out;
  }

  if (isKeyedArray(local) && isKeyedArray(remote)) {
        return mergeKeyedArrays(base, local, remote, context, guardedTombstones);
  }
    /* An emptied list still has to merge against a populated one — that is a
       "cleared everything here" edit, and the branches above already proved
       only one side changed it, so honouring the empty side is correct (for
       the guarded collections the tombstone rules inside decide instead). */
  if (Array.isArray(local) && Array.isArray(remote) && (isKeyedArray(local) || isKeyedArray(remote))) {
        return mergeKeyedArrays(base, local as JsonObject[], remote as JsonObject[], context, guardedTombstones);
  }

  // The other side left this value exactly as it was — our change stands.
  if (deepEqual(remote, base)) return local;

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
    const context = buildContext(base, local, remoteValue);
    return mergeValues(base, local, remoteValue, context);
}
