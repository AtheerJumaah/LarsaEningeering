import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../lib/ledger.ts', import.meta.url), 'utf8');

function runtime(client, seed) {
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

function event(id) {
  return {
    client_event_id: id,
    occurred_at: '2026-10-13T09:00:00.000Z',
    uid: 'fixture-staff-self-001',
    normalized_email: 'self-001@example.test',
    person_name: 'Synthetic Employee',
    status: 'In',
    work_mode: 'Office',
    note: null,
    clocked_by: null,
    source: 'fixture',
  };
}

test('ledger flush uses the explicit RPC boundary and drains recorded events', async () => {
  const calls = [];
  let directTableWrite = false;
  const client = {
    rpc: async (name, payload) => {
      calls.push({ name, payload });
      return { data: [{ outcome: 'recorded', event_id: payload.p_client_event_id }], error: null };
    },
    from: () => { directTableWrite = true; throw new Error('direct table writer must not be called'); },
  };
  const r = runtime(client, { larsaLedgerQueueV1: JSON.stringify([event('fixture-event-001')]) });
  await r.api.flushLedgerQueue();
  assert.equal(directTableWrite, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'record_attendance_action');
  assert.equal(calls[0].payload.p_client_event_id, 'fixture-event-001');
  assert.equal(calls[0].payload.p_uid, 'fixture-staff-self-001');
  assert.equal(JSON.parse(r.data.get('larsaLedgerQueueV1')).length, 0);
});
test('RPC unavailability leaves the event pending for a later retry', async () => {
  let calls = 0;
  const client = {
    rpc: async () => { calls++; return { data: null, error: { code: 'PGRST202', message: 'fixture unavailable' } }; },
  };
  const queued = [event('fixture-event-pending-001')];
  const r = runtime(client, { larsaLedgerQueueV1: JSON.stringify(queued) });
  await r.api.flushLedgerQueue();
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(r.data.get('larsaLedgerQueueV1')), queued);
});
test('a partial flush consumes only confirmed events and preserves later pending events', async () => {
  const calls = [];
  const client = {
    rpc: async (_name, payload) => {
      calls.push(payload.p_client_event_id);
      return calls.length === 1
        ? { data: [{ outcome: 'already' }], error: null }
        : { data: null, error: { code: 'PGRST000', message: 'fixture timeout' } };
    },
  };
  const queued = [event('fixture-event-already-001'), event('fixture-event-pending-002')];
  const r = runtime(client, { larsaLedgerQueueV1: JSON.stringify(queued) });
  await r.api.flushLedgerQueue();
  assert.deepEqual(calls, ['fixture-event-already-001', 'fixture-event-pending-002']);
  assert.deepEqual(JSON.parse(r.data.get('larsaLedgerQueueV1')).map(row => row.client_event_id), ['fixture-event-pending-002']);
});
// End ledger writer runtime tests.
