"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { TurnAverageBackfill, CHUNK_BYTES, MAX_RECORD_BYTES } = require("../../ElectronApp/turn-average-backfill");
const { IncrementalTranscriptReader } = require("../../ElectronApp/task-data-worker");
const { rateFor, speedPanel } = require("../../ElectronApp/token-speed");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-turn-average-"));
const base = Date.parse("2026-11-09T00:00:00Z"), budget = 8 * 1024 * 1024;
const event = (s, payload) => JSON.stringify({ timestamp:new Date(base+s*1000).toISOString(), type:"event_msg", payload });
const usage = (n,last) => ({type:"token_count",info:{total_token_usage:{output_tokens:n},last_token_usage:{output_tokens:last}}});
const start = (s=100,id="latest") => event(s,{type:"task_started",turn_id:id});
const end = (s=120,id="latest") => event(s,{type:"task_complete",turn_id:id,duration_ms:20000});
const huge = JSON.stringify({type:"response_item",payload:{type:"function_call_output",output:"x".repeat(9*1024*1024)}});
function scanner(lines, options={}) {
  const bytes=Buffer.from(lines.join("\n")), job=new TurnAverageBackfill({endOffset:bytes.length,endedAt:base+120000,turnId:"latest",...options});
  let rounds=0, largest=0;
  while(!job.done) {
    const used=job.step("unused",137,(file,a,b)=>{largest=Math.max(largest,b-a);return bytes.subarray(a,b);});
    assert(used<=137); assert(job.fragment.length<=MAX_RECORD_BYTES); assert(++rounds<100000);
  }
  assert(largest<=CHUNK_BYTES);
  return job.result;
}
try {
  const expected={startedAt:base+100000,baselineOutput:1000,latestTotal:1600,invalid:false};
  assert.deepEqual(scanner([event(5,usage(1000,1000)),start(),event(105,usage(1300,300)),event(115,usage(1600,300)),end(),""]),expected);
  assert.deepEqual(scanner([start(),event(105,usage(1300,300)),event(115,usage(1600,300)),end()]),expected,"EOF without newline and first-use baseline fallback");
  assert.deepEqual(scanner([start(),event(105,usage(1300,300)),event(115,usage(1600,300)),end(),""]),expected,"task_started at byte zero survives EOF finalization");
  assert.equal(scanner([start(0,"older"),event(5,usage(1000,300)),end()]).invalid,true,"cannot substitute an older turn");
  assert.equal(scanner([event(105,usage(1300,300)),end()]).invalid,true,"missing real start remains unknown");
  assert.equal(scanner([start(),event(105,usage(1300,300)),event(115,usage(100,50)),end()]).invalid,true,"counter reset cannot become a valid average");
  assert.equal(scanner([event(5,usage(2000,100)),start(),event(105,usage(1300,300)),end()]).invalid,true,"invalid baseline is rejected");
  const file=path.join(dir,"large.jsonl");
  const content=[start(0,"old"),event(5,usage(1000,1000)),event(6,{type:"task_complete",turn_id:"old"}),
    start(),event(105,usage(1300,300)),huge,event(115,usage(1600,300)),end(),""].join("\n");
  fs.writeFileSync(file,content);
  const reader=new IncrementalTranscriptReader(); let ranges=[];
  const readRange=reader.readRange.bind(reader);
  reader.readRange=(f,a,b)=>{ranges.push(b-a);return readRange(f,a,b);};
  reader.read(file);
  assert.equal(reader.backfillSpeed(file,1),-1);
  assert.equal(reader.backfillSpeed(file,budget),budget);
  let s=reader.read(file).tokenSpeed;
  assert.equal(s.historyPending,true);assert.equal(rateFor(s,false).value,null);
  assert.match(speedPanel([{state:"completed",tokenSpeed:s}]).rows[0].status,/补齐/);
  ranges=[];
  assert.equal(reader.backfillSpeed(file,0),-1,"recovery also respects the shared refresh budget");
  while(s.historyPending) assert(reader.backfillSpeed(file,budget)<=budget);
  assert(ranges.every(n=>n<=CHUNK_BYTES),"history recovery uses 256 KiB reads, including giant discarded tool output");
  assert.equal(rateFor(s,false).value,30,"latest turn is 600 output / 20 seconds; previous turn and 94-second user idle excluded");
  assert.deepEqual(s.turnAverage,expected);
  const reads=ranges.length;
  for(let i=0;i<100;i++){assert.equal(reader.backfillSpeed(file,budget),0);reader.read(file);}
  assert.equal(ranges.length,reads,"completed recovery is never repeated during polling");
  // Appending a new round while old recovery is queued must cancel the old job.
  fs.writeFileSync(file,content);const reader2=new IncrementalTranscriptReader();reader2.read(file);reader2.backfillSpeed(file,budget);
  fs.appendFileSync(file,[start(200,"new"),event(205,usage(2200,600)),end(220,"new"),""].join("\n"));
  s=reader2.read(file).tokenSpeed;reader2.backfillSpeed(file,budget);
  assert.equal(s.turnId,"new");assert.equal(s.historyPending,false);assert.equal(s.turnAverage,null);
  assert.equal(rateFor(s,false).value,30);
  // A still-running round may receive new usage while recovery is in progress.
  fs.writeFileSync(file,content.slice(0,content.lastIndexOf(end())));
  const reader3=new IncrementalTranscriptReader();reader3.read(file);reader3.backfillSpeed(file,budget);
  fs.appendFileSync(file,event(118,usage(1900,300))+"\n"+end()+"\n");
  s=reader3.read(file).tokenSpeed;
  while(s.historyPending)reader3.backfillSpeed(file,budget);
  assert.equal(rateFor(s,false).value,45,"new append counters are not overwritten by recovered snapshot counters");
  // An abort without duration uses the recovered latest start/end timestamps.
  fs.writeFileSync(file,[start(),event(105,usage(1300,300)),huge,event(115,usage(1600,300)),event(120,{type:"turn_aborted",turn_id:"latest"}),""].join("\n"));
  const reader4=new IncrementalTranscriptReader();reader4.read(file);reader4.backfillSpeed(file,budget);s=reader4.read(file).tokenSpeed;
  while(s.historyPending)reader4.backfillSpeed(file,budget);
  assert.equal(rateFor(s,false).value,30);
  fs.writeFileSync(file,start(300,"rotated")+"\n"+event(305,usage(300,300))+"\n");
  s=reader4.read(file).tokenSpeed;
  assert.equal(s.turnAverage,null);assert.equal(s.historyPending,false);assert.equal(rateFor(s,true,base+306000).value,10);
  console.log("PASS turn-average-backfill: chunk boundaries, EOF, counter reset, missing/wrong turns, >8 MiB history, budget, no rereads, new turn, concurrent append, abort, truncation");
} finally {fs.rmSync(dir,{recursive:true,force:true});}
