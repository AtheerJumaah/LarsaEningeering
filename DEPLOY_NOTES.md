# Deploy notes

Trivial commit to force a fresh Vercel build after correcting the
NEXT_PUBLIC_SUPABASE_ANON_KEY value (it previously had stray trailing
text appended, which broke every Supabase request with a
"non ISO-8859-1 code point" fetch error). NEXT_PUBLIC_* vars are baked
in at build time, so a new build is required to pick up the fix.
