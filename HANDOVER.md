# Larsa Control — where things stand

Written for whoever picks this up next, including future me. It covers what
the app looks like now, what changed and why, and — the part that matters
most — what is still open and what I know is wrong.

---

## 1. The six work areas

Every area opens on its own dashboard rather than on an index or on whichever
page happened to be first. The one exception is deliberate and explained below.

| Area | Opens on | Sidebar, in order |
|---|---|---|
| **Time & Attendance** | Clock In / Out | Clock In / Out · Weekly Schedule · Timesheet · Leave & Requests · Live Presence |
| **Performance** | Performance Dashboard | Performance Dashboard · Add My Points · Points & Weekly Targets · Performance Workboard · Performance History · Performance Reports |
| **Engineering Management** | Engineering Dashboard | Engineering Dashboard · Structure · Team Timesheets\* · Team Performance\* |
| **HR & Skills** | HR Dashboard | HR Dashboard · People & Skills · Skills Matrix · Development Portal · HR Reports |
| **Accounting** | Accounting Dashboard | All areas · the full accounting group, unchanged |
| **Administration** | Admin Center | Users & Access · Admin Center · Employee Details · Rules & Constraints · Data Center · Staff CSV & Import Tools · Platform Settings |

\* Shown only to somebody responsible for other people.

**Why Time is the exception.** Clock In / Out already carries today's status,
the week against the schedule, recent sessions and the way into a correction.
A separate Time Dashboard would be those same figures with a click in front of
them, so it was not built. It is a small piece of work if you disagree.

**Why Accounting now prompts for a code sometimes.** The Accounting Dashboard
is an engine page, and every engine-accounting page runs the device identity
check. It used to open the index first, which is a native page, so the check
only fired once you picked an area. Same check, one click earlier. A device
that signed in with an email code passes straight through; an unrecognised one
gets the code screen, which is the point of having it.

---

## 2. What moved, and what did not

**Time and Performance were one group** called "Timeclock & Performance", so
somebody looking for last week's hours scrolled past performance reviews to
find them. They are separate areas now. Performance holds no attendance pages;
Time holds all of them.

**Development Portal** moved from Performance to HR & Skills. Learning and
growth is the same subject as the skills matrix, and it was the one page in
Performance with nothing to do with points.

**Nothing was renamed, deleted, or repermissioned.** Every page in the registry
is still there, every granular permission still exists, and Users & Access
still lists all of them — the Development Portal appears there exactly once,
under HR. Permissions are keyed by item id, and group membership has never been
part of that check.

**`org-structure` keeps its id** even though its label is now "Engineering
Dashboard". The Home card, the recent list and its permission all name that id.

---

## 3. Storage keys that must not be renamed

These carry live production data. The label on screen has changed in several
cases; the key underneath has not, on purpose.

| On screen | Stored as | Why it matters |
|---|---|---|
| Completion Date | `workDate` on the draft, `Date` on the record | Every week lock and report reads it |
| Total Points | `"Submitted Points"` | Every target, summary, report and export reads it |
| Assigned Points | `"Assigned Points"` | — |

Renaming any of these orphans every entry already on record.

---

## 4. Access

Three layers, and they are not interchangeable:

1. **`canOpen` / `hasItemPermission`** — may this account open this page at all.
2. **`canOpenInSession`** — the above, plus the PIN restriction. A PIN session
   reaches only `PIN_ALLOWED_ITEMS`. Every sidebar and every Home card filters
   through this, so a card can never become a way into a page you may not open.
3. **Supabase RLS** — the backend answer, for anything that leaves the browser.
   Viewer accounts are scoped here as well as in the UI, with RESTRICTIVE
   policies ANDed onto the permissive ones and sections default-deny.

**Admins never see or set a non-Viewer password or PIN.** People choose their
own from My Settings or reset by email. Viewer accounts are the exception —
admin-created, username and password, no email, read-only, project-scoped.

**The accounting device check** re-proves every 48 hours for admin, accounting
and finance accounts and every 72 for everyone else. A code entered at sign-in
counts, which is why signing in and opening Accounting does not ask twice.

---

## 5. Approval chains

Requests carry `flow` (ordered approver ids) and `step` (where it has got to).
Until this week both were recorded and then ignored: `decideRequest` checked
the approve permission and resolved the request outright, so any one approver
could close anything and a configured two-stage chain was decoration.

Now: only the person a request is with may decide it; approving at a non-final
step advances it and notifies the next approver; a rejection at any step ends
it; and nothing is written into the attendance or points records until the
chain finishes. Two exceptions, both deliberate:

- **A request with no chain** keeps the old behaviour. Everything created
  before flows existed has no flow, and enforcing an absent chain would strand
  all of them.
- **A Super Admin may act out of turn**, because a chain containing somebody
  who has left the company would otherwise block for ever. It is written into
  the history as an override rather than passed off as a normal decision.

---

## 6. Night mode

One wrong instinct caused all of the complaints: to make a colour work on a
dark screen, darken it. A dark green disc on a near-black card is a smudge, not
a green card. Every night fill is now its own ink at low alpha — the six
work-area tones, the corner washes, the status tokens, the overview tiles. The
inks sit at a similar lightness so no card shouts over its neighbours.

`tests/dark-mode-colour.test.mjs` pins the rule rather than the hues, because
the rule is what keeps getting broken.

**One thing to know before adding CSS:** `visual-pass.css` is emitted *before*
`globals.css` in the bundle, so an equal-specificity rule written in
visual-pass quietly loses. Fix things where they are defined.

---

## 7. Migrations applied

All are live on project `fqxknodpkjdmueevafdk`.

```
20260802_acct_007_maker_checker            20260803_notify_011_center
20260802_acct_008_authoritative_financials 20260803_notify_014_dispatch
20260803_acct_009_payroll                  20260804_notify_019_email_channel
20260803_acct_010_payroll_portal           20260804_acct_020_viewer_sections
20260803_acct_015_waiver_reason
20260803_acct_016_viewer_accounts
20260803_acct_017_viewer_accounts_hardening
20260803_acct_018_viewer_portal
```

Two traps found the hard way, both now avoided in the files:
`create or replace function` with a changed signature creates an **overload**,
not a replacement — drop it explicitly first. And `account_audit_log` takes
`(actor, p_action, p_target_type, p_target_id, p_target_label, p_details)`.

---

## 8. Still open — read this part

**Known gaps.**

- `send-mail` is deployed but its source is not in this repo. `notify-mail` is
  here and delegates to it. If `send-mail` is ever lost, it has to be rewritten
  from the calling contract.
- **Live email delivery has never been tested end to end.** Address resolution
  is verified; an actual message arriving in an actual inbox is not.
- **There is no file storage at all** — zero buckets, zero objects. Six of the
  eight Viewer portal sections originally asked for have no data to expose. The
  five that do are built.

**Not started, from the restructuring request.**

- The unified Request Center as a single screen, and the workflow builder in
  Administration that would configure the chains now being enforced.
- Duplicated nested headers on the iframe-embedded engine pages.
- Additive work on Accounting and Administration.
- Smart card layouts on the Accounting pages.
- Employee identity reconciliation — "Unknown employee" references, and the
  differing headcounts between modules. This one is worth doing early; it makes
  every report downstream of it suspect.

**Test baseline.** 296 tests, 287 pass, **9 pre-existing failures** and 23
pre-existing lint errors. That baseline predates this work. Compare against it
with `comm -13` rather than expecting zero, or you will chase ghosts.

**Deploying.** There are no push credentials in the sandbox, so deploys go
through the GitHub web UI. Two things that cost me real time: GitHub's keyboard
shortcuts steal a typed commit message, so set the field's value
programmatically; and always `git fetch origin main` and diff before assuming a
commit landed. One did not, silently, and three test files went missing.
