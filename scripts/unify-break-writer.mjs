import { readFileSync, writeFileSync } from 'node:fs';
const path = 'app/page.tsx';
const raw = readFileSync(path, 'utf8');
const from = raw.indexOf('  const punchBreak = useCallback(');
const to = raw.indexOf('  /* Breaks share the clock', from);
if (from < 0 || to < from) throw new Error('Unexpected break writer');
writeFileSync(path, raw.slice(0,from) + `  const punchBreak = useCallback(async (note = "", intent?: "Break Start" | "Break End") => {
    if (!intent) { notify("Select Start Break or End Break explicitly."); return false; }
    return punchClock("Break", note, intent);
  }, [punchClock, notify]);
` + raw.slice(to));
