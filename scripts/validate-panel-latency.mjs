import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {spawn,execFile} from "node:child_process";
import {promisify} from "node:util";
import readline from "node:readline";
import {fileURLToPath} from "node:url";
const run=promisify(execFile), delay=ms=>new Promise(r=>setTimeout(r,ms));
const temp=process.env.CODEX_COMPANION_VALIDATION_OUTPUT || process.argv[2];
assert(temp && path.isAbsolute(temp), "An explicit absolute evidence directory is required");
const reportName=process.argv[3]||"fixed", iterations=Number(process.argv[4]||10);
assert(Number.isInteger(iterations) && iterations > 0 && iterations <= 100);
const port=Number(process.env.COMPANION_DEBUG_PORT || 9338);
await fs.mkdir(temp,{recursive:true});
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const expectedVersion=JSON.parse(await fs.readFile(path.join(project,"package.json"),"utf8")).version;
await run("/usr/bin/xcrun",["swiftc",path.join(project,"scripts/panel-window-probe.swift"),"-o",path.join(temp,"panel-probe")]);
const sources=(process.argv[5]||"tray,dot").split(",");
const support=path.join(os.homedir(),"Library/Application Support/codex-companion");
const report={testedAt:new Date().toISOString(),scenario:reportName,samples:[]};
report.measurement = {
 native: "CGWindowList first visible native window, sampled about every 10 ms; not a pixel/video timestamp",
 renderer: "first visible requestAnimationFrame callback after show; not physical display presentation",
 automation: "AXPress completion and DOM verification are recorded separately from opening latency"
};
const nativeProbe=spawn(path.join(temp,"panel-probe"),[],{stdio:["pipe","pipe","inherit"]});
const lines=readline.createInterface({input:nativeProbe.stdout});
const waits=[];lines.on("line",line=>waits.shift()?.(JSON.parse(line)));
const native=pid=>new Promise(resolve=>{waits.push(resolve);nativeProbe.stdin.write(pid+"\n");});
async function targets(){return(await fetch(`http://127.0.0.1:${port}/json/list`)).json();}
async function waitFor(read,accept,label,timeout=15000){
 const end=Date.now()+timeout;let last;
 while(Date.now()<end){try{last=await read();if(accept(last))return last;}catch(error){last={error:String(error)};}await delay(10);}
 throw new Error(label+": "+JSON.stringify(last));
}
async function runtime(){
 for(const name of await fs.readdir(support)){
  if(!/^menu-bar-runtime-\d+\.json$/.test(name))continue;
  try{const state=JSON.parse(await fs.readFile(path.join(support,name),"utf8"));process.kill(state.pid,0);if(state.bundleIdentifier === "com.lindaozhi.codexstatusreminder")return state;}catch{}
 } throw new Error("App not running");
}
async function cdp(target){
 const socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
 let next=1;const pending=new Map();
 socket.addEventListener("message",event=>{
  const value=JSON.parse(String(event.data)),req=pending.get(value.id);if(!req)return;
  pending.delete(value.id);clearTimeout(req.timer);value.error?req.reject(new Error(value.error.message)):req.resolve(value.result);
 });
 const send=(method,params={})=>new Promise((resolve,reject)=>{
  const id=next++,timer=setTimeout(()=>{pending.delete(id);reject(new Error("CDP timeout "+method));},10000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
 });
 return {send,close:()=>socket.close(),evaluate:async expression=>{
  const result=await send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result?.value;
 }};
}
async function pressTray(pid){
 const script=['tell application "System Events"',
  'set targetProcess to first application process whose unix id is '+pid,
  'repeat with bar in menu bars of targetProcess',
  'repeat with statusItem in menu bar items of bar',
  'set itemSize to size of statusItem','if item 1 of itemSize > 18 then',
  'perform action "AXPress" of statusItem','return','end if','end repeat','end repeat','end tell'].join("\n");
 await run("/usr/bin/osascript",["-e",script]);
}
let settings,original;
try {
 const initial=await waitFor(runtime,s=>Number.isInteger(s?.pid),"App did not become ready");report.pid=initial.pid;
 const list=await waitFor(targets,items=>items.some(t=>t.url.includes("settings.html")),"Settings absent");
 settings=await cdp(list.find(t=>t.url.includes("settings.html")));
 await waitFor(()=>settings.evaluate("Boolean(window.companionSettings?.get)"),v=>v===true,"Settings preload not ready");
 original=await settings.evaluate("window.companionSettings.get()");
 report.version=original.version;
 if(reportName!=="baseline")assert.equal(original.version,process.env.COMPANION_EXPECT_VERSION || expectedVersion,"Benchmark must target the built application version");
 await settings.evaluate("window.companionSettings.update({showDesktopWidget:true})");
 const dotTarget=(await waitFor(targets,items=>items.some(t=>t.url.includes("dot.html")),"Desktop dot absent")).find(t=>t.url.includes("dot.html"));
 const dot=await cdp(dotTarget);
 await waitFor(()=>dot.evaluate("Boolean(document.getElementById('dot') && window.webkit?.messageHandlers?.dot)"),v=>v===true,"Desktop widget preload not ready");
 try {
  for(const source of sources){
   for(let i=0;i<iterations;i++){
    assert.equal((await native(initial.pid)).visible,false,"Previous panel must be hidden before the measured action");
    await delay(300);
    // Observe in parallel: AXPress itself may return long after the native
    // window appeared. Do not attribute that automation overhead to the app.
    const preparedBeforeAction=await runtime();
    const firstVisible = waitFor(()=>native(initial.pid),v=>v.visible,"Native panel never shown");
    firstVisible.catch(()=>{});
    let requestedAt;
    if(source==="tray"){
     const before=await runtime();await pressTray(initial.pid);
     requestedAt=(await waitFor(runtime,s=>s.lastLeftClickAt>before.lastLeftClickAt,"Click not handled")).lastLeftClickAt;
    } else {
     requestedAt=await dot.evaluate("(()=>{const at=Date.now();document.getElementById('dot').dispatchEvent(new MouseEvent('mouseenter'));return at;})()");
    }
    const target=(await waitFor(targets,items=>items.some(t=>t.url.includes("panel.html")),"Panel page absent")).find(t=>t.url.includes("panel.html"));
    const panel=await cdp(target);
    try {
     const displayed=reportName!=="baseline"?await waitFor(runtime,v=>v.taskPanel?.visible&&v.taskPanel.renderRevision===v.taskPanel.renderedRevision,"Current complete snapshot was not shown"):null;
     const dom=await waitFor(()=>panel.evaluate("({at:Date.now(),revision:Number(document.getElementById('root').dataset.renderRevision),navigationStart:performance.timeOrigin,domReadyAt:performance.timing.domContentLoadedEventEnd,values:[...document.querySelectorAll('.status-info-value')].map(e=>e.textContent),rows:document.querySelectorAll('.status-task-row').length,height:document.querySelector('.status-popover-frame')?.getBoundingClientRect().height})"),v=>v.values?.length===3&&v.height>60&&(!displayed||v.revision>=displayed.taskPanel.renderedRevision),"Full current panel content absent");
     const first=await firstVisible;
     const screen=await waitFor(()=>native(initial.pid),v=>v.visible,"Native panel not visible after complete content validation");
     const frame=displayed?.taskPanel.prewarmCount !== undefined
       ? await waitFor(runtime,v=>v.taskPanel?.presentationID===displayed.taskPanel.presentationID && Number.isFinite(v.taskPanel?.lastFrameLatencyMs),"Visible renderer frame not acknowledged")
       : null;
     const renderer=await panel.evaluate("window.panelRendererDiagnostics?.() || null");
     if(displayed)assert.equal(dom.values[0],displayed.weeklyQuotaAvailable?`${Math.round(displayed.weeklyQuotaRemainingPercent)}%`:"–","The shown quota must match the current application snapshot");
     report.samples.push({source,index:i+1,targetID:target.id,requestedAt,observedAt:screen.at,latencyMs:Math.round(first.at-requestedAt),firstNativeObservedAt:first.at,verificationLatencyMs:Math.round(screen.at-requestedAt),domReadyMs:dom.domReadyAt>=requestedAt?Math.round(dom.domReadyAt-requestedAt):null,contentObservedMs:dom.at-requestedAt,content:dom.values,rows:dom.rows,nativeHeight:screen.panels[0].height,preparedBeforeAction:preparedBeforeAction.taskPanel?.prepared ?? null,retainedBeforeAction:Boolean(preparedBeforeAction.taskPanel?.retained),renderer,...(displayed?{preparedLatencyMs:displayed.taskPanel.lastOpenLatencyMs,firstVisibleRendererFrameMs:frame ? frame.taskPanel.lastFrameLatencyMs+(source==='dot' ? displayed.taskPanel.hoverOpenMs : 0) : null,createCount:displayed.taskPanel.createCount,reuseCount:displayed.taskPanel.reuseCount,renderRevision:dom.revision}:{})});
     console.log(JSON.stringify(report.samples.at(-1)));
     if(source==="tray")await pressTray(initial.pid);
     else {
      await dot.evaluate("document.getElementById('dot').dispatchEvent(new MouseEvent('mouseleave'))");
      await panel.evaluate("window.webkit.messageHandlers.panel.postMessage({type:'leave'})");
     }
     await waitFor(()=>native(initial.pid),v=>!v.visible,"Panel did not close");
     if(reportName==="baseline")await waitFor(targets,items=>!items.some(t=>t.url.includes("panel.html")),"Baseline panel did not release");
    } finally {panel.close();}
   }
  }
 } finally {dot.close();}
 const sorted=values=>[...values].sort((a,b)=>a-b);
 const stats=values=>{
  const list=sorted(values);
  return list.length ? {count:list.length,minMs:list[0],medianMs:list[Math.floor(list.length/2)],p95Ms:list[Math.ceil(list.length*0.95)-1],maxMs:list.at(-1)} : null;
 };
 report.summary={};
 for(const source of sources){
  const samples=report.samples.filter(s=>s.source===source),values=sorted(samples.map(s=>s.latencyMs));
  report.summary[source]={...stats(values),firstMs:samples[0]?.latencyMs,warm:stats(samples.filter(s=>s.retainedBeforeAction).map(s=>s.latencyMs)),rendererFrame:stats(samples.map(s=>s.firstVisibleRendererFrameMs).filter(Number.isFinite)),distinctRendererTargets:new Set(samples.map(s=>s.targetID)).size};
 }
 report.passed=true;
} catch(error){report.passed=false;report.error=String(error.stack||error);process.exitCode=1;}
finally{
 if(settings&&original){
  await settings.evaluate("window.companionSettings.update("+JSON.stringify({showDesktopWidget:original.showDesktopWidget})+")").catch(error=>{report.restoreError=String(error);process.exitCode=1;});
 }
 settings?.close();nativeProbe.stdin.end();lines.close();
 await fs.writeFile(path.join(temp,reportName+"-latency.json"),JSON.stringify(report,null,2)+"\n");
 console.log(JSON.stringify({passed:report.passed,summary:report.summary,error:report.error},null,2));
}
