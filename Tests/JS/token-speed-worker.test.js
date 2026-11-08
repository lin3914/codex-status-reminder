"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const {IncrementalTranscriptReader}=require("../../ElectronApp/task-data-worker");
const {rateFor}=require("../../ElectronApp/token-speed");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"codex-speed-fixture-"));
const base=Date.parse("2026-11-08T12:00:00Z");
const record=(seconds,payload)=>JSON.stringify({timestamp:new Date(base+seconds*1000).toISOString(),type:"event_msg",payload});
const usage=(total,last)=>({type:"token_count",info:{total_token_usage:{output_tokens:total},last_token_usage:{output_tokens:last}}});
try{
  const file=path.join(dir,"fixture.jsonl");
  fs.writeFileSync(file,[record(0,{type:"task_started"}),record(1,{type:"synthetic_padding",padding:"x".repeat(600000)}),record(5,usage(1000,300)),record(20,{type:"task_complete",duration_ms:20000}),""].join("\n"));
  const reader=new IncrementalTranscriptReader();const partial=reader.read(file);
  assert.equal(rateFor(partial.tokenSpeed,false).value,null);
  assert.equal(reader.backfillSpeed(file,100),-1,"bounded read is deferred, never over budget");
  assert(reader.backfillSpeed(file,8*1024*1024)>0);
  assert.equal(rateFor(reader.read(file).tokenSpeed,false).value,15);
  assert.equal(reader.backfillSpeed(file,8*1024*1024),0,"history is not scanned again");
  fs.appendFileSync(file,[record(100,{type:"task_started"}),record(105,usage(1600,600)),record(120,{type:"task_complete",duration_ms:20000}),""].join("\n"));
  assert.equal(rateFor(reader.read(file).tokenSpeed,false).value,30,"append computes latest turn, not idle time or lifetime total");
  fs.writeFileSync(file,record(200,{type:"task_started"})+"\n"+record(205,usage(300,300))+"\n");
  assert.equal(rateFor(reader.read(file).tokenSpeed,true,base+206000).value,10,"rotation/truncation discards stale state");
  const source=fs.readFileSync(path.join(__dirname,"../../ElectronApp/main.js"),"utf8");
  const start=source.indexOf("function scheduleSpeedDisplay()"),end=source.indexOf("function sendDotSnapshot()",start);
  let visible=false,scheduled=0,sends=0;
  const ctx={quitting:false,speedDisplayTimer:null,snapshot:{tasks:[{state:"running"}]},
    panelWindow:{isDestroyed:()=>false,isVisible:()=>visible},clearTimeout(){},setTimeout(fn,ms){scheduled++;assert.equal(ms,1000);return{fn,unref(){}};},sendPanelSnapshot(){sends++;}};
  vm.createContext(ctx);vm.runInContext(source.slice(start,end),ctx);
  ctx.scheduleSpeedDisplay();assert.equal(scheduled,0,"no hidden polling");
  visible=true;ctx.scheduleSpeedDisplay();assert.equal(scheduled,1);ctx.speedDisplayTimer.fn();assert.equal(sends,1);
  ctx.snapshot.tasks=[];ctx.scheduleSpeedDisplay();assert.equal(scheduled,1,"no idle polling");
  console.log("PASS token-speed-worker: bounded history, append, rotation, full-turn average, visible-only timer, no idle polling");
}finally{fs.rmSync(dir,{recursive:true,force:true});}
