# Attendance freeze investigation — 25 October 2026

## Reproduced failure

The visible Clock In / Out screen is the native QuickClock component. The
earlier embedded-engine optimizations did not address its background sync loop.
An isolated Chrome test loaded the real application with 26 synthetic employees
and 1,040 historical punch records. All backend writes were intercepted; no real
employee attendance or credentials were changed.

The application became unresponsive during repeated punches. The renderer grew
to several GB while the most recent measured JavaScript heap remained around
20 MB. Task tracing showed the last completed timer starting a shared-store save.

## Causes and repairs

1. **Endless save retry for an absent optional store.** `localStorage.getItem`
   returns `null` when a store is absent. `lastKnown.get` returns `undefined`.
   The sync layer compared them directly and considered an unused store dirty.
   The writer correctly performed no write, but the queue immediately retried
   through resolved promises indefinitely. This starved browser tasks and grew
   memory. Both dirty comparisons now normalize absence to `null`.
2. **Unbounded queue draining.** A persistent conflict, malformed document, or
   no-progress writer could produce the same infinite retry independently.
   One promise now owns the whole per-store drain. It yields between attempts
   and rejects after five unsuccessful passes. Local changes remain stored;
   an unconfirmed save cannot be reported as confirmed.
3. **Reentrant realtime cleanup.** `removeChannel` can synchronously emit
   `CLOSED`, invoking the cleanup callback again. Browser errors captured
   `Maximum call stack size exceeded` in `removeChannel`/`unsubscribe`.
   Cleanup now relinquishes channel ownership before removal and ignores
   callbacks from retired channels. Reconnection backs off to 30 seconds and
   resets after a successful subscription. The REST fallback remains active.
4. **Repeated timezone formatter allocation.** The baseline created over
   100,000 explicit formatters in eight punches. Zone validation, wall-clock
   conversion, midnight boundaries, and native attendance display now reuse
   bounded caches. The fixed browser run created eight formatters initially,
   with no per-punch growth. Exact attendance arithmetic and DST tests pass.
5. **Startup hydration mismatch.** The server's initial overview greeting could
   differ from the device's greeting in another timezone. The overview now mounts
   after hydration. The regression uses a UTC server and a Chicago browser and
   treats all browser errors, including hydration errors, as failures.

## Verification

- Full Node test suite and production Next.js/TypeScript build pass.
- Regression tests explicitly cover synchronous `CLOSED` reentry, stale channel
  callbacks, reconnect backoff, no-progress save draining, and timezone reuse.
- Isolated Chrome: 12 deliberate punches, actual tab close/new tab, another
  clock-in, running timer from `00:00:08` to `00:00:09`, then a successful out.
- All 14 event IDs are unique; final status is `Out`.
- Websocket closures are deliberately injected throughout the test. Optional
  shared stores are absent, reproducing the former empty-store trigger.
- In the final local run, click handling took 23–124 ms. Confirmation sometimes
  took longer because the async test backend/auth recovery was still settling;
  that waiting did not block the UI. These are test measurements, not a promise
  about every employee's network latency.

Reproduce with `node tests/attendance-freeze-local.smoke.mjs`. To verify a deployed
build without production writes, run
`node tests/attendance-freeze.smoke.mjs https://larsaeng.app/ --fail-realtime`.
The browser test uses synthetic data and mocks backend writes; it does not test
an actual employee's credentials or perform a live attendance transaction.
