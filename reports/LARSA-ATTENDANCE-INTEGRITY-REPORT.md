# LARSA Attendance Integrity Report — Incident Window

**Window:** Aug 6, 2026 00:00 Baghdad → repair execution (Aug 7, ~14:21 Baghdad)
**Method:** every duration below is computed from the exact stored timestamps (millisecond subtraction → whole minutes → HR/MIN format). Decimal hours appear nowhere except as derived export values. All times below are Baghdad local (UTC+3).

## Recovered and verified sessions

**Ahmed Asaad** — aasaad@larsaeng.com (records recovered from vanished account u9 → current account u14)

| Clock in | Clock out | Exact minutes | Display | Status |
|----------|-----------|---------------|---------|--------|
| Aug 6 21:26:29 | Aug 6 21:35:29 | 9 | 9 min | Recovered / Verified |
| Aug 6 21:35:50 | Aug 6 21:36:26 | 1 | 1 min | Recovered / Verified |
| Aug 6 21:36:28 | Aug 6 23:16:53 | 100 | 1 hr 40 min | Recovered / Verified |
| Aug 6 23:40:20 | Aug 6 23:40:28 | 0 | 0 min | Recovered / Verified (double-tap) |
| Aug 6 23:40:30 | Aug 7 02:05:55 | 145 | 2 hr 25 min | Recovered / Verified — crosses midnight, computed correctly |
| *(morning)* | Aug 6 12:59:26 | — | — | Clock-out recovered; matching clock-in unrecoverable (predates all backups) → correction request |

**Recovered evening total: 255 minutes = 4 hr 15 min** (the short 9/1/0-minute stubs are his real double-taps, preserved verbatim; the trim tool can tidy them).

**Yasser Mohammed** — ymohammed@larsaeng.com (u2; one record recovered from pre-reset account u27)

| Clock in | Clock out | Status |
|----------|-----------|--------|
| Aug 6 12:47:31 | still open | Preserved — needs correction to close (no clock-out was ever recorded) |
| Aug 6 16:12:56 | still open | Recovered from u27 / Preserved — needs correction to close |

No clock-out exists in any source for either session, so none was invented (the rule: recovered sessions keep actual timestamps only).

**Maryam Raad** — coordination@larsaeng.com (records recovered from her earlier tenure of id u10 → current account u18)

| Clock in | Clock out | Status |
|----------|-----------|--------|
| Aug 6 16:51:07 | still open | Recovered / Preserved — needs correction |
| Aug 6 16:51:15 | still open | Recovered double-tap / Preserved |

**Hany Medhat** — hmedhat@larsaeng.com (u6)

| Clock in | Clock out | Status |
|----------|-----------|--------|
| Aug 5 13:58:16 | still open | Restored from the Aug 5 platform backup (was fully overwritten) — needs correction |

His Aug 6–7 sessions (Aug 6 16:00→17:27, 17:27 → Aug 7 00:10, Aug 7 11:31→13:08) were never lost and were verified intact.

## Awaiting identification (preserved, flagged in-app)

| Original account | Session | Exact minutes | Display |
|------------------|---------|---------------|---------|
| u11 | clock-out Aug 6 23:36:10, clock-in lost | unknown | — |
| u12 | Aug 6 22:25:32 → Aug 7 00:49:16 | 144 | 2 hr 24 min |

## Spot-check of untouched records (sample verification that repair changed nothing else)

| Employee | Session (Baghdad) | Exact minutes | Display |
|----------|-------------------|---------------|---------|
| Mahmood Al-Nuri (u4) | Aug 6 19:57 → 23:59 (approved correction pair) | 242 | 4 hr 2 min |
| Noor Tohah (u19) | Aug 7 12:58:47 → 13:15:33 | 17 | 17 min |
| Mohammad Qasim (u8) | Aug 6 16:24:11 → Aug 7 00:35:11 | 491 | 8 hr 11 min |

All 121 untouched records carry their original ids and timestamps byte-for-byte (verified against the pre-repair backup).

## Durability statement

150 events now sit in the append-only `attendance_events` ledger (121 backfilled, 15 incident-recovery replacements, 14 original-evidence rows). The ledger rejects UPDATE and DELETE at the database level, every new punch dual-writes to it, and the app restores from it on every boot. Totals in the app are summed from exact milliseconds and formatted as HR/MIN at the last step, so multi-session days add exactly (e.g. 1 hr 20 min + 45 min = 2 hr 5 min).
