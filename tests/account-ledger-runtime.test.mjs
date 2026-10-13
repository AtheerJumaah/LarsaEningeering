import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/accounts-ledger.ts', import.meta.url), 'utf8');

function runtime(client, seed = {}) {
  const data = new Map(Object.entries(seed));
  const exports = {};
  const localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
  const context = vm.createContext({
    exports,
    module: { exports },
    console: { log() {}, warn() {}, error() {} },
    localStorage,
    require: name => name.includes('supabase/client')
      ? { getSupabaseClient: () => client, supabaseConfigured: () => true }
      : (() => { throw new Error(`unexpected import ${name}`); })(),
    Date, Map, Set, Promise, AbortController, URL,
    setTimeout, clearTimeout,
  });
  vm.runInContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { api: exports, data };
}

const queued = {
  uid: 'fixture-staff-self-001',
  name: 'Synthetic Employee',
  normalized_email: 'self-001@example.test',
  access: 'Employee',
  username: 'fixture-self-001',
  record: { id: 'fixture-staff-self-001', name: 'Synthetic Employee', email: 'self-001@example.test' },
};

function authClient(user, calls, authError = null) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: authError }) },
    rpc: async (name, payload) => { calls.push({ name, payload }); return { data: null, error: null }; },
  };
}

test('account queue requires non-anonymous Auth and sends no client actor field', async () => {
  const calls = [];
  const client = authClient({ id: '00000000-0000-4000-8000-000000000001', is_anonymous: false }, calls);
  const r = runtime(client, { larsaAccountQueueV1: JSON.stringify([queued]) });
  await r.api.flushAccountQueue();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'staff_account_upsert');
  assert.deepEqual(Object.keys(calls[0].payload), ['p_accounts']);
  assert.equal(JSON.parse(r.data.get('larsaAccountQueueV1')).length, 0);
});

test('anonymous Auth leaves queued account writes pending', async () => {
  const calls = [];
  const client = authClient({ id: '00000000-0000-4000-8000-000000000002', is_anonymous: true }, calls);
  const r = runtime(client, { larsaAccountQueueV1: JSON.stringify([queued]) });
  await r.api.flushAccountQueue();
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(r.data.get('larsaAccountQueueV1')), [queued]);
});

test('Auth lookup failure leaves queued account writes pending', async () => {
  const calls = [];
  const client = authClient(null, calls, { message: 'fixture auth unavailable' });
  const r = runtime(client, { larsaAccountQueueV1: JSON.stringify([queued]) });
  await r.api.flushAccountQueue();
  assert.equal(calls.length, 0);
  assert.deepEqual(JSON.parse(r.data.get('larsaAccountQueueV1')), [queued]);
});

test('account RPC failure leaves queued rows pending for retry', async () => {
  const calls = [];
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000005', is_anonymous: false } }, error: null }) },
    rpc: async (name, payload) => { calls.push({ name, payload }); return { data: null, error: { code: 'PGRST000', message: 'fixture timeout' } }; },
  };
  const r = runtime(client, { larsaAccountQueueV1: JSON.stringify([queued]) });
  await r.api.flushAccountQueue();
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(r.data.get('larsaAccountQueueV1')), [queued]);
});

test('tombstone derives legacy audit actor from verified Auth UUID', async () => {
  const calls = [];
  const client = authClient({ id: '00000000-0000-4000-8000-000000000003', is_anonymous: false }, calls);
  const r = runtime(client);
  assert.equal(await r.api.tombstoneAccount('fixture-target-001', 'fixture reason'), true);
  assert.equal(calls[0].name, 'staff_account_tombstone');
  assert.equal(calls[0].payload.p_by, '00000000-0000-4000-8000-000000000003');
  assert.equal(calls[0].payload.p_reason, 'fixture reason');
});

test('anonymous Auth cannot tombstone an account', async () => {
  const calls = [];
  const client = authClient({ id: '00000000-0000-4000-8000-000000000004', is_anonymous: true }, calls);
  const r = runtime(client);
  assert.equal(await r.api.tombstoneAccount('fixture-target-001', 'fixture reason'), false);
  assert.equal(calls.length, 0);
});
