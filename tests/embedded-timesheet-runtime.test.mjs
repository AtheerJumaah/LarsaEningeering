import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const raw=readFileSync(new URL('../public/engines/timeclock.html',import.meta.url),'utf8');
const inner=JSON.parse(raw.split('\n').find(line=>line.startsWith('"<!DOCTYPE html>')));
function functions(names){
  const found=[];
  for(const block of inner.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)){
    const source=ts.createSourceFile('engine.js',block[1],ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
    function visit(node){if(ts.isFunctionDeclaration(node)&&names.includes(node.name?.text))found.push(node.getText(source));ts.forEachChild(node,visit);}
    visit(source);
  }return found.join('\n');
}
test('real embedded timesheet uses authoritative net hours, not gross shift duration',()=>{
  const logs=[['In','08:52:10.165'],['Break Start','08:53:13.388'],['Break End','08:57:32.769'],['Out','09:01:10.798']].map(([status,time])=>({uid:'e',type:'Office',status,time:`2026-10-12T${time}Z`}));
  const rows=[{uid:'e',Employee:'Test',Type:'Office',In:logs[0].time,Out:logs[3].time,Hours:281.252/3600,Open:false}];
  const window={parent:{__larsaAttendanceSessions:()=>rows}};
  const context=vm.createContext({state:{logs},window,Date,Map,Number,userName23:()=> 'Test'});
  vm.runInContext(functions(['larsaSharedAttendanceSessions','sessions23']),context);
  const actual=vm.runInContext('sessions23()',context);
  assert.equal(actual.length,1);assert.ok(Math.abs(actual[0].Hours-281.252/3600)<1e-10);
});

test('an embedded panel without its authoritative parent does not invent gross hours',()=>{
  const logs=[{uid:'e',status:'In',time:'2026-10-12T16:00:00Z'},{uid:'e',status:'Out',time:'2026-10-12T17:00:00Z'}];
  const context=vm.createContext({state:{logs},window:{parent:{}},Date,Map,Number,userName23:()=> 'Test'});
  vm.runInContext(functions(['larsaSharedAttendanceSessions','sessions23']),context);
  assert.equal(vm.runInContext('sessions23()',context).length,0);
});
