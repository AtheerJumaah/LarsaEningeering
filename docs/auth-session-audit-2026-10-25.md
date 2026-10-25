# Account login, logout, and email-verification repair

Scope: account sign-in/sign-out and periodic mailbox verification. Attendance
records and clock calculations were not changed.

## Confirmed causes

- Ordinary email/password login marked a device as newly email-verified. The
  next login trusted that local timestamp and skipped the server policy. Frequent
  logins could continually postpone the required email challenge.
- Remembered PIN sessions and the active-session watchdog did not enforce the
  PIN verification policy. The email watchdog used a hardcoded local interval.
- The verification gate was entered only after sending mail. Failed sends left
  no usable challenge, and cancellation retained stale flow/session state.
- In-flight login/verification responses could finish after cancellation or
  logout and restore an unwanted session.
- The email-code handler ignored a failure to persist the authoritative proof.
  A successful-looking check could therefore be challenged again immediately.

## Resulting behavior

Manual and restored email/PIN sessions ask the server for one policy decision.
Only an accepted email code renews mailbox proof. The code handler must save
that proof before reporting success. A mail failure leaves the challenge open
with a retry button. Cancellation and logout invalidate asynchronous responses
and remove the remembered session. Cross-tab logout also cancels pending login.

Active sessions use server expiry, with a maximum five-minute policy refresh
and a check when returning to the window. Temporary lookup failure retries in
30 seconds without ending an active session. A new sign-in cannot silently
bypass an unavailable policy check: it shows a bounded retry message.
`force_relogin=false` keeps an existing session active; the next sign-in still
checks expiry. Previewing another user's access does not challenge their identity.

Production settings inspected and preserved: enabled, employee interval 72
hours, privileged interval 48 hours, PIN interval 168 hours, initial verification
required, PIN verification required, force re-verification enabled. Explicit
exemptions and disabled policies remain supported. The existing deployed
Super Admin permission to change only the PIN verification switch was preserved.

## Validation

- Type-checked production build.
- 679 automated tests, including nine executable edge-handler regressions for
  role intervals, first verification, disabled policies, exemptions, PIN hours,
  business days, persistence failures, and account/code mismatch.
- Eight real Chrome browser scenarios against production-built UI with all
  backend requests intercepted: repeated email/PIN login/logout; expiry despite
  a current local device flag; mail failure/retry; remembered email and PIN
  sessions; policy changes while active; lookup failure/retry; cross-tab logout
  during login; cancellation during code confirmation. Zero runtime errors.
- Attendance regression: 14 unique synthetic events, close/reopen, disconnected
  realtime, and a continuously advancing elapsed timer. No production writes.

The tests do not send employee email or verify delivery to every mailbox. They
exercise challenge issuance, code acceptance, and persistence using fixtures;
production policy and deployed handlers are also checked directly. This retains
the application's existing client-side staff-login architecture rather than
claiming a new server-session security model.

## Publication

Published application commit: `9b4903e0d410ea09b17dfe521ca5eb481f9d67a7`.
Vercel deployment: `dpl_CwnzxNcwm9CrAQVnwBbp5z8jwaRp`, assigned to
`https://larsaeng.app/`. Supabase `auth-policy` version 9 and `auth-code`
version 7 are active with JWT verification enabled; deployed sources match
the reviewed sources. Live status requests for the owner's account returned
the configured 48-hour email and 168-hour PIN intervals. A synthetic unknown
mailbox correctly required initial verification, without sending email.

All eight browser scenarios were also exercised against published assets.
Repeated cold downloads sometimes delayed startup before any policy request
or application rendering; the test host also reported `ERR_NETWORK_CHANGED`
during navigation. The browser fixture retries only those transport failures,
caches immutable published
assets across its isolated contexts (Playwright routing otherwise disables
HTTP caching) and waits for application initialization before measuring auth
behavior. These checks validate authentication behavior separately from cold
asset-download performance; they do not establish a universal startup-time
guarantee.
