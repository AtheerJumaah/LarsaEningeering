# LARSA Incident Data Recovery Report

**Incident window:** August 6, 2026 00:00 Asia/Baghdad (Aug 5, 21:00 UTC) → repair execution
**Repair executed:** August 7, 2026, ~14:21 Asia/Baghdad (11:21 UTC)
**Performed by:** Automated incident repair (migrations `repair_001` – `repair_006`), on production project `larsa-control`
**Full pre-repair backup:** database schema `larsa_backup_20260807` — every table, byte-exact, including apparently duplicate and orphaned records, plus the `auth.users` projection. Nothing was deleted before or during investigation.

---

## What was scanned

All 16 current staff accounts and every historical account reference reachable from: the live shared state (`larsaStaffV8`, 135 clock records pre-repair), the Aug 4 pre-reset archive (27 accounts, 18 records), all 3 platform backups (Aug 5 11:14, Aug 5 11:17, Aug 6 12:17), the account lifecycle audit (14 rows), the verification table (16 rows — including stamps for accounts that no longer exist, which served as evidence), and 184 Supabase Auth rows (all but one are anonymous device sessions; employee identity does not live in Supabase Auth in this app).

## What was found

During Aug 6, whole-state overwrites from stale devices deleted employee accounts repeatedly. Deleted people re-registered, and the sequential id generator **reissued their old ids to different people**. The result: clock records pointing at account ids that either no longer existed or now belonged to somebody else.

Orphaned/misattributed records found in the live state: **15** (uids u9 ×11, u27 ×1, u10 ×2 misattributed, u11 ×1, u12 ×2 — u10's two records were under an id that had changed hands). One further record was found only in the Aug 5 backups, overwritten out of the live state entirely.

## What was recovered

| # | Employee | Evidence | Action | Records |
|---|----------|----------|--------|---------|
| 1 | **Ahmed Asaad** (now u14, aasaad@larsaeng.com) | Lifecycle audit of Aug 6 17:00 names u9 = "Ahmed Asaad"; his recreated u14 account had zero records | All 11 u9 clock events reconnected to u14 | 11 |
| 2 | **Yasser Mohammed** (u2, ymohammed@larsaeng.com) | Pre-reset account u27 carried the same normalized email — the permanent business identity | u27's Aug 6 13:12 clock-in reconnected to u2 | 1 |
| 3 | **Maryam Raad** (now u18, coordination@larsaeng.com) | Audits of Aug 6 15:19 and 15:21 name u10 = "Maryam Raad"; FARAH NABEEL holds u10 only from 18:33 onward | The two 13:51 clock-ins (pre-18:30) reconnected to u18 | 2 |
| 4 | **Hany Medhat** (u6, hmedhat@larsaeng.com) | His Aug 5 10:58:16 clock-in exists in both Aug 5 platform backups but not in the live state | Restored verbatim from backup, under its original id and timestamp | 1 |

Every reconnected record keeps its **original timestamp**, its **original account id** (`origId`/`origUid` fields), and a note explaining the recovery. The replaced originals were not destroyed: they remain in the backup schema and in the immutable attendance ledger under their original ids.

## Flagged for manual review (not guessed)

| Account | Records | Detail | Candidates |
|---------|---------|--------|-----------|
| u11 | 1 | Clock-**out** Aug 6 20:36:10 with no surviving clock-in | Ayman Al-Jumaili, Anas Sayala, or Dillon Takhuma |
| u12 | 2 | Clock-in 19:25 → clock-out 21:49 Aug 6 (2 HR 24 MIN) | Ghufran Taha (plausible but unproven) |

No backup captured u11/u12's account records (their user entries were lost before the Aug 6 12:17 backup ran), so their identities cannot be proven from data. The records are preserved and annotated in the app; once the person confirms, an admin can reconnect them the same way.

## Known unrecoverable data (stated honestly, per the no-false-claims rule)

1. **Ahmed Asaad's morning clock-in of Aug 6.** His 09:59:26 clock-out survives (recovered), but the matching morning clock-in was overwritten before the earliest backup that could have held it. Duration of that morning session is unknowable from data; he can submit an "Add or fix past hours" correction, which goes through approval.
2. **The In-time behind u11's 20:36 clock-out** — same situation.
3. **Any account created and destroyed entirely between backups** with no surviving reference. No positive evidence of such a case was found, but the pre-12:17 window on Aug 6 cannot be fully reconstructed, so zero loss in that window is **not** claimed.

## Open sessions preserved as-is (no invented clock-outs)

Yasser (u2) has two open clock-ins (Aug 6 09:47 and the recovered 13:12); Maryam Raad (u18) has two open 13:51 clock-ins (a double-tap from the old UI); Hany (u6) has the restored Aug 5 10:58 clock-in open. The app already displays these as "needs correction, not counted" — they inflate nothing, and each person can close them through the approval flow. Original timestamps were never altered.

## Also noted

FARAH NABEEL (u10, fnabeel@larsaeng.com) was offboarded by admin action on Aug 6 18:33 and remains offboarded — visible in Users & Access → Offboarded, restorable with one click. This was an admin action, not incident damage.

## The permanent guarantee going forward

All 136 current-era clock events (plus the 14 replaced originals as raw evidence — 150 rows total) are now in `attendance_events`: an **append-only** ledger that no role can update or delete (database-trigger-enforced). Every future punch is written there at punch time, and the app restores from it at boot. Deleting an account, recreating an account, clearing a cache, changing auth state, or overwriting the shared state **cannot lose attendance any more**. There is no retention window: history is permanent unless LARSA one day adopts an explicit retention policy.
