// Read-only production probe. Public build configuration stays in memory;
// output contains connection metadata and aggregate attendance findings only.
import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const base = process.env.ATTENDANCE_PROBE_URL || 'https://larsaeng.app';
const page = await fetch(base).then(r => r.text());
const assets = [...new Set([...page.matchAll(/(?:src|href)="([^" ]+\.js[^" ]*)"/g)].map(m => m[1]))];
const code = (await Promise.all(assets.map(path => fetch(new URL(path, base)).then(r => r.text())))).join('\n');
const url = code.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
const key = code.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0];
if (!url || !key) throw new Error('Public Supabase build configuration not found');
const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
const report = { application: base, deployment: page.match(/dpl_[A-Za-z0-9]+/)?.[0], database: new URL(url).hostname };
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const auth = await client.auth.signInAnonymously();
report.databaseSession = auth.error ? auth.error.message : 'anonymous session established';
if (auth.data.session) headers.Authorization = `Bearer ${auth.data.session.access_token}`;
const request = async (path, options = {}) => {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers, ...options });
  const body = await response.json();
  return { status: response.status, body };
};
const time = await request('rpc/server_now', { method: 'POST', body: '{}' });
report.serverClock = { status: time.status, value: time.status === 200 ? time.body : time.body.code };
// Invalid input proves RPC availability without inserting an attendance event.
const rpc = await request('rpc/record_attendance_punch', { method: 'POST', body: JSON.stringify({
  p_client_event_id: '', p_occurred_at: null, p_uid: '', p_normalized_email: null,
  p_person_name: null, p_status: null,
}) });
report.punchRpc = { status: rpc.status, code: rpc.body.code, message: rpc.body.message };
const staff = await request('app_state?select=data,updated_at&store_key=eq.larsaStaffV8');
report.staffRead = staff.status;
const store = staff.status === 200 ? staff.body?.[0]?.data : null;
if (store) {
  const logs = store.logs || [];
  const removed = new Set(store.removedLogIds || []);
  report.staff = { updatedAt: staff.body[0].updated_at, employees: store.users?.length || 0, logs: logs.length,
    recoveredLogs: logs.filter(l => l.recovery).length, activeFlags: logs.filter(l => l.active).length,
    missingAttribution: logs.filter(l => !l.clockedBy && !l.actorId && !l.source).length };
  const ledger = [];
  for (let page = 0; page < 8; page++) {
    const result = await request(`attendance_events?select=client_event_id,uid,status,occurred_at,inserted_at,source&order=inserted_at.desc&limit=1000&offset=${page * 1000}`);
    if (result.status !== 200) { report.ledgerRead = result.status; break; }
    ledger.push(...result.body);
    if (result.body.length < 1000) break;
  }
  report.ledger = { scanned: ledger.length, sourceCounts: {} };
  for (const row of ledger) report.ledger.sourceCounts[row.source] = (report.ledger.sourceCounts[row.source] || 0) + 1;
  const current = new Map();
  for (const row of ledger) if (!removed.has(row.client_event_id) && ['In', 'Out'].includes(row.status) && !current.has(row.uid)) current.set(row.uid, row);
  const local = new Map();
  for (const log of [...logs].sort((a,b) => Date.parse(b.time) - Date.parse(a.time))) if (['In','Out'].includes(log.status) && !local.has(log.uid)) local.set(log.uid, log);
  report.statusMismatches = [];
  for (const [uid, row] of current) {
    const log = local.get(uid);
    if (log && log.status !== row.status) report.statusMismatches.push({
      employee: createHash('sha256').update(uid).digest('hex').slice(0,12),
      screenStatus: log.status, ledgerStatus: row.status, screenAt: log.time,
      ledgerAt: row.occurred_at, ledgerReceivedAt: row.inserted_at, source: row.source,
    });
  }
}
console.log(JSON.stringify(report, null, 2));
