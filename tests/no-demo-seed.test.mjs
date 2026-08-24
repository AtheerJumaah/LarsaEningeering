/* Larsa Control — the engine must never invent a company.
 *
 * The defect this file exists to keep dead:
 *
 *   let state = load();
 *   function load(){ try { return JSON.parse(localStorage.getItem('larsaStaffV8')) || seed() }
 *                    catch(e){ return seed() } }
 *   function save(){ localStorage.setItem('larsaStaffV8', JSON.stringify(state)) }
 *
 * seed() builds a demo COMPANY — users u1..u21 under invented names, and
 * eight fake punches at fixed minute offsets (-95, -80, -70, -65, -60, -140,
 * -25, -35). It ran whenever the shared store could not be read in that one
 * instant: an engine iframe booting before the app has hydrated the store, a
 * cleared cache, a private window, any storage exception. The next save()
 * wrote the invention into the real store, the add-only log merge adopted it
 * permanently, and the ledger recorded it.
 *
 * In production that put 132 fabricated punches across 17 batches into the
 * live company in a fortnight. Each fabricated "In" becomes somebody's newest
 * punch, so the next press of a button reading "Clock In" writes an Out —
 * people clocked out by nobody — and the shift that was genuinely open is
 * dropped from every total. The same seed is where the wrong names on real
 * accounts came from.
 *
 * Two independent guards, because one of them being wrong is how this
 * happened: nothing is ever invented, and an empty roster can never be
 * written over a real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const raw = await readFile(new URL("../public/engines/timeclock.html", import.meta.url), "utf8");
const tpl = raw.split("\n").find((line) => line.startsWith('"<!DOCTYPE html>'));
assert.ok(tpl, "the engine bundler template line could not be found");
const engine = JSON.parse(tpl);

test("load() can never fabricate a company", () => {
  assert.match(engine, /function load\(\)\{return readStore\(\)\|\|emptyState\(\)\}/);
  // The old line, in either of its two halves, must stay gone.
  assert.doesNotMatch(engine, /localStorage\.getItem\('larsaStaffV8'\)\)\|\|seed\(\)/);
  assert.doesNotMatch(engine, /catch\(e\)\{return seed\(\)\}/);
  // And seed() itself can no longer hand demo data to anything that calls it.
  assert.match(engine, /function seed\(\)\{return emptyState\(\)\}/);
  // Nothing calls it any more either. Comments are stripped first, because
  // the rationale above the fix necessarily names the function it removed.
  const code = engine.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const callSites = code.match(/(?<!function )seed\(\)/g) || [];
  assert.equal(callSites.length, 0, "seed() must have no call sites");
});

test("the unhydrated shell is empty, marked, and never persisted", () => {
  assert.match(engine, /function emptyState\(\)\{return \{users:\[\],shifts:\[\],schedule:\{\},logs:\[\],performance:\[\],approvals:\[\],rules:\[\],flowConfig:\{\},columns:/);
  assert.match(engine, /__unhydrated:true\}\}/);
  assert.match(engine, /function save\(\)\{\n if\(state&&state\.__unhydrated&&!hydrate\(\)\)return;/);
  // Second, independent guard: an empty roster never overwrites a real one.
  assert.match(engine, /if\(cur&&Array\.isArray\(cur\.users\)&&cur\.users\.length&&\(!Array\.isArray\(state\.users\)\|\|!state\.users\.length\)\)return;/);
  // And the real store is adopted the moment it appears.
  assert.match(engine, /function hydrate\(\)\{if\(!state\|\|!state\.__unhydrated\)return false;/);
  assert.match(engine, /function render\(\)\{hydrate\(\);/);
});

test("the clock decides from the last CLOCK punch, not the last log", () => {
  /* A Break End is the newest log but says nothing about being on shift.
     Reading it as "not clocked in" made the button and the record disagree:
     the screen offered Clock In and the write was an Out. */
  /* The write itself now goes through the shared lastPunchOf() helper (see
     tests/clock-intent.test.mjs); the clock screens still filter inline. */
  assert.match(engine, /function lastPunchOf\(uid\)\{return \(state\.logs\|\|\[\]\)\.filter\(function\(l\)\{return l\.uid===uid&&\(l\.status==='In'\|\|l\.status==='Out'\)\}\)/);
  const decisions = engine.match(/l\.uid===currentUser\.id&&\(l\.status==='In'\|\|l\.status==='Out'\)/g) || [];
  assert.ok(decisions.length >= 2, "both clock screens must filter to In/Out");
  assert.match(engine, /function clockStatusForUser\(uid\)\{return state\.logs\.filter\(l=>l\.uid===uid&&\(l\.status==='In'\|\|l\.status==='Out'\)\)/);
  assert.doesNotMatch(engine, /function clockToggle\(type\)\{let latest=state\.logs\.filter\(l=>l\.uid===currentUser\.id\)\./);
});

test("an unclosed shift is kept, not silently replaced", () => {
  /* The pairing did `if(status==='In') open=l`, so a second In threw the
     first one's hours away with no trace — "it didn't record my hours". */
  const kept = engine.match(/if\(l\.status==='In'\)\{if\(open\)return;open=l\}/g) || [];
  assert.equal(kept.length, 2, "both copies of sessions() must keep the earlier open punch");
  assert.doesNotMatch(engine, /arr\.forEach\(l=>\{if\(l\.status==='In'\)open=l;else/);
});
