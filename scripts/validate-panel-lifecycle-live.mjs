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
const reportName=process.argv[3]||"after", idleSeconds=Number(process.argv[4]||600);
assert(Number.isInteger(idleSeconds) && idleSeconds >= 60 && idleSeconds <= 900);
const port=Number(process.env.COMPANION_DEBUG_PORT || 9338);
await fs.mkdir(temp,{recursive:true});
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const expectedVersion=JSON.parse(await fs.readFile(path.join(project,"package.json"),"utf8")).version;
await run("/usr/bin/xcrun",["swiftc",path.join(project,"scripts/panel-window-probe.swift"),"-o",path.join(temp,"panel-probe")]);
const sources=(process.argv[5]||"tray,dot").split(",");
const support=path.join(os.homedir(),"Library/Application Support/codex-companion");
const report={testedAt:new Date().toISOString(),scenario:reportName,samples:[]};
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

let settings, original, dot, panel;
report.checks = [];
async function connectPage(fragment) {
  const list = await waitFor(targets, items => items.some(t => t.url.includes(fragment)), fragment + " absent");
  return cdp(list.find(t => t.url.includes(fragment)));
}
async function panelShown(pid) {
  const visible = await waitFor(() => native(pid), v => v.visible, "Native panel did not show");
  await waitFor(runtime, v => v.taskPanel?.visible && v.taskPanel.renderRevision === v.taskPanel.renderedRevision,
    "Panel did not render the latest snapshot");
  return visible;
}
try {
  const state = await waitFor(runtime, s => Number.isInteger(s?.pid), "App not ready");
  report.pid = state.pid;
  settings = await connectPage("settings.html");
  await waitFor(() => settings.evaluate("Boolean(window.companionSettings?.get)"), v => v, "Settings preload not ready");
  original = await settings.evaluate("window.companionSettings.get()");
  assert.equal(original.version, expectedVersion);
  await settings.evaluate("window.companionSettings.update({showDesktopWidget:true,locale:'zh-CN'})");
  dot = await connectPage("dot.html");
  await waitFor(() => dot.evaluate("Boolean(document.getElementById('dot') && window.webkit?.messageHandlers?.dot)"),
    v => v, "Dot preload not ready");
  await waitFor(runtime, v => v.taskPanel?.prepared && v.taskPanel.prewarmCount === 1,
    "Startup did not prepare the latest complete card");
  if ((await runtime()).taskPanel.visible) {
    panel = await connectPage("panel.html");
    await panel.evaluate("window.close()");
    panel.close(); panel = null;
  }
  await delay(300);
  await pressTray(state.pid);
  await panelShown(state.pid);
  panel = await connectPage("panel.html");
  const initial = await panel.evaluate(`({
    lang:document.documentElement.lang, revision:Number(document.getElementById('root').dataset.renderRevision),
    values:[...document.querySelectorAll('.status-info-value')].map(e=>e.textContent),
    rows:document.querySelectorAll('.status-task-row').length,
    listHeight:document.querySelector('.status-task-list').clientHeight,
    scrollHeight:document.querySelector('.status-task-list').scrollHeight
  })`);
  assert.equal(initial.values.length, 3);
  assert(initial.rows >= 4 && initial.scrollHeight > initial.listHeight);
  report.initial = initial;
  const initialDiagnostics = await panel.evaluate("window.panelRendererDiagnostics()");
  assert.equal(initialDiagnostics.builds, 1);
  assert(initialDiagnostics.measurements >= 1);
  report.initialRenderer = initialDiagnostics;
  report.checks.push("real quota/time/countdown and all retained tasks render within a three-row viewport");
  await panel.evaluate("document.querySelector('.status-task-list').scrollTop=150;document.querySelector('.status-task-list').dispatchEvent(new Event('scroll'))");
  await delay(300);
  await pressTray(state.pid);
  await waitFor(() => native(state.pid), v => !v.visible, "Panel did not hide");
  const hiddenRevision = await panel.evaluate("Number(document.getElementById('root').dataset.renderRevision)");
  const retainedTarget = (await targets()).find(t => t.url.includes("panel.html")).id;
  await settings.evaluate("window.companionSettings.update({locale:'en'})");
  await waitFor(() => panel.evaluate("({revision:Number(document.getElementById('root').dataset.renderRevision),lang:document.documentElement.lang})"),
    v => v.revision > hiddenRevision && v.lang === "en", "Hidden language preparation did not finish");
  await waitFor(runtime, v => v.taskPanel?.prepared, "Hidden preparation not acknowledged");
  assert.equal((await native(state.pid)).visible, false);
  const hiddenRenderer = await panel.evaluate("window.panelRendererDiagnostics()");
  assert.equal(hiddenRenderer.builds, 1);
  assert.equal(hiddenRenderer.firstFrameAt, initialDiagnostics.firstFrameAt);
  report.checks.push("hidden language/data changes are prepared incrementally without showing the card or scheduling animation frames");
  await pressTray(state.pid);
  await panelShown(state.pid);
  assert.equal((await targets()).find(t => t.url.includes("panel.html")).id, retainedTarget);
  assert.equal(await panel.evaluate("document.documentElement.lang"), "en");
  assert.equal(await panel.evaluate("document.querySelector('.status-task-list').scrollTop"), 150);
  assert.equal((await panel.evaluate("window.panelRendererDiagnostics()")).measurements, hiddenRenderer.measurements,
    "Opening an already prepared card must not measure its height again");
  const displayed = await runtime();
  assert.equal((await panel.evaluate("[...document.querySelectorAll('.status-info-value')].map(e=>e.textContent)"))[0],
    displayed.weeklyQuotaAvailable ? `${Math.round(displayed.weeklyQuotaRemainingPercent)}%` : "–");
  report.checks.push("reopen uses current prepared language/data, preserves task scroll position and adds no layout measurement");
  await delay(300);
  await pressTray(state.pid);
  await waitFor(() => native(state.pid), v => !v.visible, "Tray panel did not hide");
  await dot.evaluate("document.getElementById('dot').dispatchEvent(new MouseEvent('mouseenter'))");
  await panelShown(state.pid);
  assert.equal((await runtime()).taskPanel.source, "dot");
  await panel.evaluate("window.__frameBeforeDrag=document.querySelector('.status-popover-frame')");
  const beforeDrag = await panel.evaluate("({revision:Number(document.getElementById('root').dataset.renderRevision),x:screenX,y:screenY})");
  const dotBefore = await dot.evaluate("({x:screenX,y:screenY})");
  await dot.evaluate("window.webkit.messageHandlers.dot.postMessage({type:'dragStart'})");
  for (const multiplier of [1,-1]) {
    for (let i=0;i<10;i++) {
      await dot.evaluate(`window.webkit.messageHandlers.dot.postMessage({type:'move',dx:${4*multiplier},dy:${2*multiplier}})`);
      await delay(12);
    }
  }
  const dotAfter = await dot.evaluate("({x:screenX,y:screenY})");
  assert.deepEqual(dotAfter, dotBefore);
  const afterDrag = await panel.evaluate("({revision:Number(document.getElementById('root').dataset.renderRevision),sameFrame:window.__frameBeforeDrag===document.querySelector('.status-popover-frame'),x:screenX,y:screenY})");
  if (afterDrag.revision === beforeDrag.revision) assert(afterDrag.sameFrame);
  assert((await native(state.pid)).visible);
  report.drag = {before:beforeDrag,after:afterDrag,moves:20};
  report.checks.push("20 desktop drag moves and reverse moves keep the panel visible and the geometry-only tree intact");
  await dot.evaluate("document.getElementById('dot').dispatchEvent(new MouseEvent('mouseleave'))");
  await panel.evaluate("window.webkit.messageHandlers.panel.postMessage({type:'leave'})");
  await waitFor(() => native(state.pid), v => !v.visible, "Desktop panel did not hide");
  const idleBegan = Date.now();
  const idleState = await runtime();
  const idleRenderer = await panel.evaluate("window.panelRendererDiagnostics()");
  assert(idleState.taskPanel.retained && idleState.taskPanel.prepared);
  report.idleSamples = [];
  while (Date.now() - idleBegan < idleSeconds * 1000) {
    await delay(Math.min(60_000, idleSeconds * 1000 - (Date.now() - idleBegan)));
    const current = await runtime();
    assert.equal(current.pid, state.pid);
    assert.equal(current.taskPanel.visible, false);
    assert.equal(current.taskPanel.createCount, idleState.taskPanel.createCount);
    assert(current.taskPanel.retained, "Normal idle must not force a cold card every minute");
    const renderer = await panel.evaluate("window.panelRendererDiagnostics()");
    assert.equal(renderer.builds, idleRenderer.builds);
    assert.equal(renderer.measurements, idleRenderer.measurements);
    assert.equal(renderer.firstFrameAt, idleRenderer.firstFrameAt);
    const sample = { elapsedSeconds:Math.round((Date.now()-idleBegan)/1000), panel:current.taskPanel, renderer };
    report.idleSamples.push(sample);
    console.log(JSON.stringify({phase:"hidden-idle",...sample}));
  }
  report.idleObservedMs = Date.now()-idleBegan;
  report.checks.push(`after ${idleSeconds} seconds of real hidden idle the same prepared card has no frame or structural-layout activity`);
  const countBefore = (await runtime()).taskPanel.createCount;
  const firstVisible = waitFor(() => native(state.pid), v => v.visible, "Idle desktop panel did not appear");
  const enteredAt = await dot.evaluate("(()=>{const at=Date.now();document.getElementById('dot').dispatchEvent(new MouseEvent('mouseenter'));return at})()");
  const visible = await firstVisible;
  await panelShown(state.pid);
  report.idleDesktopLatencyMs = Math.round(visible.at-enteredAt);
  assert.equal((await runtime()).taskPanel.createCount, countBefore);
  assert.equal(await panel.evaluate("document.querySelectorAll('.status-info-value').length"), 3);
  report.checks.push("long-idle desktop entry shows current complete content without recreating a renderer");
  await panel.evaluate("window.close()");
  panel.close(); panel = null;
  await waitFor(runtime, v => !v.taskPanel.retained, "Explicitly closed renderer not released");
  await dot.evaluate("document.getElementById('dot').dispatchEvent(new MouseEvent('mouseleave'))");
  await delay(300);
  await dot.evaluate("document.getElementById('dot').dispatchEvent(new MouseEvent('mouseenter'))");
  await panelShown(state.pid);
  panel = await connectPage("panel.html");
  assert.equal((await runtime()).taskPanel.createCount, countBefore + 1);
  assert.equal(await panel.evaluate("document.querySelectorAll('.status-info-value').length"), 3);
  report.checks.push("a discarded renderer is rebuilt only by the next user open; the app and tray do not restart");
  await dot.evaluate("document.getElementById('dot').dispatchEvent(new MouseEvent('mouseleave'))");
  await panel.evaluate("window.webkit.messageHandlers.panel.postMessage({type:'leave'})");
  await waitFor(() => native(state.pid), v => !v.visible, "Recovered panel did not hide");
  const final = await runtime();
  assert.equal(final.pid, state.pid);
  assert.equal(final.trayCreateCount, 1);
  assert.equal(final.trayRecoveryCount, 0);
  assert(final.trayBoundsInMenuBar);
  report.final = {pid:final.pid,trayCreateCount:final.trayCreateCount,taskPanel:final.taskPanel};
  report.passed = true;
} catch(error) {
  report.passed = false; report.error = String(error.stack || error); process.exitCode = 1;
} finally {
  if (settings && original) {
    await settings.evaluate("window.companionSettings.update("+JSON.stringify({
      showDesktopWidget:original.showDesktopWidget,locale:original.locale
    })+")").catch(error=>{report.restoreError=String(error);process.exitCode=1});
  }
  settings?.close();dot?.close();panel?.close();nativeProbe.stdin.end();lines.close();
  await fs.writeFile(path.join(temp,"panel-detail.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error,idleDesktopLatencyMs:report.idleDesktopLatencyMs,idleObservedMs:report.idleObservedMs},null,2));
}
