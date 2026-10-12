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

test('real parent bridge respects current employee scope and sums daily net segments',()=>{
  const source=ts.createSourceFile('page.tsx',readFileSync(new URL('../app/page.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let effect;
  function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(source)==='useEffect'&&node.arguments[0]?.getText(source).includes('holder.__larsaAttendanceSessions = readSessions'))effect=node.arguments[0].getText(source);ts.forEachChild(node,visit);}
  visit(source);assert.ok(effect);
  const users=[{id:'e',name:'Test'},{id:'other',name:'Other'}];
  const record={uid:'e',employee:'Test',mode:'Office',clockIn:'2026-10-11T23:00:00Z',clockOut:'2026-10-12T01:00:00Z',hours:0.5,presenceHours:1,breakHours:0.5,open:false};
  const window={};const sessionUserRef={current:{id:'e'}};
  const context=vm.createContext({window,sessionUserRef,Map,Set,Number,
    parseStore:()=>({users}),isAdmin:()=>false,scopedUsers:actor=>users.filter(user=>user.id===actor.id),
    buildClockSessions:()=>[record,{...record,hours:0.75,breakHours:0.25},{...record,uid:'other',hours:8}]});
  vm.runInContext(ts.transpileModule(`(${effect})();`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const rows=window.__larsaAttendanceSessions();assert.equal(rows.length,1);
  assert.equal(rows[0].uid,'e');assert.equal(rows[0].Hours,1.25);assert.equal(rows[0].BreakHours,0.75);
  sessionUserRef.current=null;assert.equal(window.__larsaAttendanceSessions().length,0);
  sessionUserRef.current={id:'e'};users[0].enabled=false;assert.equal(window.__larsaAttendanceSessions().length,0);
});
