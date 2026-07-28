# Where to host Larsa Control

The application is entirely client-side by design — no API routes, no server
components. That means you are not tied to one host; pick whichever of the
options below suits you. It also means data lived only in each browser until
now — see **Sharing data across the company with Supabase** below if you
want everyone seeing the same records, which is the recommended pairing with
Vercel Pro.

Run `npm run install:ci` once before any of these.

---

## Recommended: Vercel Pro + Supabase

```
npm run build:vercel
```

1. Push this repo to GitHub/GitLab and import it in Vercel. It detects
   Next.js automatically.
2. In the Vercel project's build settings, override the **Build Command** to
   `npm run build:vercel`. Leave everything else on the Next.js defaults.
3. Add the two Supabase environment variables (below) in **Settings →
   Environment Variables**, then redeploy.

Without the Supabase variables set, the app still works exactly as before —
one browser at a time. Add them whenever you're ready; nothing else changes.

---

## Sharing data across the company with Supabase

Today the app stores everything in the browser's localStorage. That means
what one person enters does not show up on a colleague's machine. Supabase
gives the same three data stores (Timeclock/staff, HR, Accounting) a shared
home in a real Postgres database, so everyone sees the same records within a
second or two of a change — no other code changes needed.

**Setup (10 minutes):**

1. Create a project at supabase.com (the free tier is enough to start; move
   to a paid tier as usage grows).
2. Open **SQL Editor → New query**, paste the contents of
   `supabase/schema.sql` from this repo, and run it.
3. Open **Authentication → Sign In / Providers** and enable **Anonymous
   Sign-ins**. The app uses this silently on load — it does not add a second
   login screen, it just gives each browser session a real, authenticated
   connection so the database can tell a real visitor from a stray script
   hitting the API cold.
4. Open **Settings → API** and copy the **Project URL** and **anon public
   key**.
5. Set these two variables (in `.env.local` for local dev, and in your
   host's environment variable settings for the deployed site — see
   `.env.local.example`):

   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
   ```

6. Redeploy. On first sign-in after this, whichever browser has the most
   complete local data seeds the shared database; every browser after that
   reads and writes the same shared copy.

**What this does and doesn't change:** permission checks (who can see or
approve what) still happen the same way they do today, in the browser. This
step closes the "only my machine has the data" gap; it does not add
server-enforced, per-role security. That's a real follow-on project — giving
each employee an actual Supabase login instead of today's shared
email/password check — described in a comment at the bottom of
`supabase/schema.sql`, and worth doing as its own reviewed change.

---

## Other hosting options

### Any web host at all — the simplest, no server required

```
npm run build:static
```

Produces a folder called `out/`. Upload its **contents** (not the folder) to
any web host: Netlify, GitHub Pages, Cloudflare Pages, Firebase Hosting,
Amazon S3, Azure Static Web Apps, or ordinary shared hosting / cPanel over
FTP. Supabase sync (above) still works from a static export — it's all
client-side JavaScript either way.

| Setting | Value |
|---|---|
| Build command | `npm run build:static` |
| Publish directory | `out` |
| Node version | 22 or newer |

### A VPS or self-managed Node host

```
npm run build:node
npm run start:node
```

`build:node` produces `.next/standalone`, which runs anywhere Node 22 is
available: a plain VPS, Render, Railway, Fly.io, or your own server behind
nginx. (On Vercel specifically, use `build:vercel` instead — see above;
Vercel has its own optimized runtime and doesn't need the standalone
bundle.)

### Cloudflare Workers — what it runs on today

```
npm run build
```

Unchanged. This is the vinext build, and the remote Cloudflare builder runs
it against your pushed commit, so commit and push and it deploys itself.

---

## After deploying, check these

1. **Sign in with email and password.** A blank sign-in must be refused.
2. **Open Accounting.** Every ledger should show a period selector and a
   totals row. If the pages are blank, the `engines` folder didn't upload —
   confirm `/engines/accounting.html` loads directly in the browser.
3. **Hard refresh once** (Ctrl+F5) so the old service worker releases.
4. **If Supabase is connected:** open the same account in two different
   browsers (or a normal window and a private one), change something in one,
   and confirm it appears in the other within a couple of seconds.
