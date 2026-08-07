# LARSA Root Cause Report — Why Accounts and Hours Disappeared

**Verdict up front:** nothing was deleted by Supabase, by RLS, or by a malicious actor. Accounts and attendance were destroyed by the app's own synchronization design racing against itself, amplified by three secondary defects. Every link in the chain is verified against production data, and every link now has a permanent fix.

## The architecture that failed

Employee accounts in LARSA Control are not Supabase Auth users (the 184 auth rows are anonymous device sessions). The entire staff directory — accounts, hashed credentials, clock logs, requests — lives in **one shared JSON document** (`larsaStaffV8`) that every browser holds in localStorage and syncs through a single database row. Whoever writes that row defines company reality.

## Root cause 1 — last-write-wins replication (the destroyer)

Until the evening of Aug 6, the sync layer resolved concurrent writes by replacement: the newer push won **outright**. A laptop that had been open since morning held a morning-old copy of the company; its next push silently reverted every account created and every punch recorded since morning, everywhere. This is exactly how "Create Account → Clock In → account doesn't exist" happened: the account was created and synced, then a stale device's push erased it minutes later. Verified: the Aug 6 12:17 platform backup shows the directory reduced to 5 accounts while verification stamps prove accounts u6–u13 existed the previous evening.

**Fix (already live before this repair, now hardened):** compare-and-swap writes with server-stamped versions and three-way merge — concurrent writers converge on the union of their work. **New in this repair:** direct table writes are *revoked* for all client roles; the CAS RPC is the only write path, so any yet-undiscovered stale bundle now fails instead of destroying data. (Proven necessary: during this very repair, an open client managed to revert the first recovery pass through a merge edge case; the second, merge-proof pass held.)

## Root cause 2 — stale cached app versions (why Ctrl+Shift+R "fixed" it)

The PWA service worker cached whole app versions. Devices that never fully reloaded kept RUNNING the deadly pre-CAS code for days — each one a loaded gun. Ctrl+Shift+R bypassed the cache, loaded the fixed code, and behavior changed; that was the tell. Verified: the live blob's metadata still carried a write label ("account reset: Super Admin only") from a code version whose strings do not exist anywhere in the current repository.

**Fix:** cache v45; network-first for navigations and engine files; automatic update checks on focus plus a one-time reload when a new version takes over; and — decisively — the database write revocation above, which disarms stale versions no matter how long they linger.

## Root cause 3 — sequential account ids (why hours attached to the wrong person)

New accounts took `max+1` ids (u9, u10, …). When a rollback deleted accounts, the next signup **reissued the same id to a different person**, inheriting the previous owner's attendance and verification stamps. Verified in the audit log: u10 is "Maryam Raad" at 15:19–15:21 on Aug 6 and "FARAH NABEEL" at 18:33.

**Fix:** ids now embed creation time plus entropy — collisions are impossible across any devices, orders, or rollbacks. Existing ids are untouched.

## Root cause 4 — verification keyed to those mutable ids (the every-login verification loop)

The "verify every N hours" stamp was stored per account id. Recreated accounts got new ids (or someone else's), so the system saw "never verified" and challenged people on every sign-in. Login itself never reset the timer — the timer's identity kept vanishing underneath it.

**Fix:** stamps now carry the **normalized email** (`trim(lower(email))`) — the permanent business identity — and are matched by it first, so recreation never restarts anyone's clock. Frequency is admin-configurable in hours, calendar days, or business days (Sunday–Thursday Iraqi week; Friday/Saturday never count). Only a genuinely accepted emailed code can ever move the stamp — that was already true and remains true.

## Root cause 5 — attendance had no life outside the blob

Clock records existed *only* inside the same overwritable document as everything else, so account destruction and attendance destruction were one event.

**Fix:** the append-only `attendance_events` ledger. Every punch, from every path (quick clock, admin clock-others, corrections, the legacy engine), dual-writes there with idempotent delivery and an offline queue. UPDATE and DELETE are rejected by a database trigger for every role. At boot the app restores anything the shared state lost. Attendance now survives account deletion, recreation, auth changes, cache clears, and state overwrites — permanently, with no retention window.

## Contributing factors, also addressed

Deleting from the offboard screen previously had no soft-delete stage → full lifecycle now: Offboarded (email reserved) → Recycling Bin (email freed, history kept, conflict-checked restore) → Super-Admin-only permanent delete that still preserves ledger and audit history, plus employment periods and the three re-onboarding history modes. Duplicate submissions → double-tap suppression existed; creation is additionally guarded at the moment of write against a freshly read list, and merge-level duplication is structurally prevented by collision-free ids. Decimal-hour displays invited misreading (".30 h" ≠ 30 min) → every normal display is now exact HR/MIN computed from millisecond timestamps, decimal hours surviving only as derived export values.

## What did NOT cause this (ruled out with evidence)

RLS hid nothing (policies verified; advisors clean of critical findings). Supabase deleted nothing (no deleted_at anywhere; backups intact). No cascade deletes existed between auth and staff data (they aren't even linked). The database never lost a committed write — every loss happened client-side before or during replication.

## Standing risk assessment

The one revert observed during this repair (a client merge overriding a server-side edit) is inherent to any device-wins merge and affects *edits to contested fields*, not additions — attendance additions are ledger-protected regardless. Server-side data operations should from now on use the merge-proof pattern established in `repair_005` (remove-and-replace with tombstones) rather than in-place edits. This is documented in the migration itself.
