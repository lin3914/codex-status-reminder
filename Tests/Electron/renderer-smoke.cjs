"use strict";
// Run with the pristine matching Electron executable after npm run build.
// Does not import the production main entry, read Codex, create a Tray,
// register login items, or launch the installed app.
const { app, BrowserWindow, ipcMain } = require("electron");
// CI Macs may not expose a working virtual GPU/Viz capture surface. Use
// software capture only in this isolated test process, not in the application.
app.disableHardwareAcceleration();
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");
const root = path.resolve(__dirname, "../..");
const candidateVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const base = path.join(root, ".build/products/CodeX状态提醒.app/Contents/Resources/app.asar");
const { rendererURL, protectRendererWindow, trustedRendererEvent } = require(path.join(base, "renderer-security.js"));
const { normalizeSettings } = require(path.join(base, "settings-store.js"));
assert.equal(JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).version, candidateVersion);
const isolatedData = fs.mkdtempSync(path.join(os.tmpdir(), "codex-renderer-smoke-"));
app.setPath("userData", isolatedData);
const windows = {};
const messages = [], unexpectedConsole = [];
const reportDir = process.env.CODEX_COMPANION_SMOKE_REPORT || path.join(root, ".build/smoke");
fs.mkdirSync(reportDir, { recursive: true });
let settings = {
  ...normalizeSettings(), effectiveLocale: "zh-CN", version: candidateVersion,
  codexConnection: {
    valid: true, title: "已自动连接 Codex",
    pathLabel: "~/.codex", manualSelectionAvailable: false
  }, menuBarStatus: { state: "visible" }
};
const { speedPanel } = require(path.join(base, "token-speed.js"));
const demoSpeeds = speedPanel([
  { state: "unread", tokenSpeed: { completeStart:true,hasUsage:true,endedAt:Date.now(),durationMs:10000,output:450 } },
  { state: "running", tokenSpeed: { samples:[{at:Date.now(),output:1230}],phase:"sampled" } },
  { state: "completed", tokenSpeed: { completeStart:true,hasUsage:true,endedAt:Date.now(),durationMs:20000,output:700 } }
], "zh-CN");
const panelState = {
  tokenSpeed: demoSpeeds.total,
  quotaValue: "81%", timeValue: "85%", resetValue: "5天 23小时",
  quotaPercent: 81, timePercent: 85, resetTitle: "2026-11-16 13:00",
  usage: { week: { state: "ready", value: 28_760_000 }, day: { state: "ready", value: 6_420_000 } },
  unreadCount: 1, runningCount: 1, locale: "zh-CN", direction: "down",
  tasks: [
    { id: "demo-unread", title: "整理项目计划", progress: "项目计划已整理，待确认本周优先级和交付顺序。已把待确认事项单独列出，便于集中查看。", stateLabel: "待查看", stateClass: "unread", speed:demoSpeeds.rows[0], usage:{state:"ready",value:2_380_000} },
    { id: "demo-running", title: "检查文档格式与最新任务进展", progress: "正在核对文档格式、链接和完整内容。首轮核对已经完成，正在复查有修改的段落。待确认的条目会汇总在最终结果中，方便项目组在交付前逐项核对。", stateLabel: "进行中", stateClass: "running", speed:demoSpeeds.rows[1], usage:{state:"ready",value:1_460_000} },
    { id: "demo-processed", title: "核对代码样本", progress: "样本已核对，结果和例外说明已归档。", stateLabel: "已处理", stateClass: "completed", speed:demoSpeeds.rows[2], usage:{state:"ready",value:936_000} }
  ], renderRevision: 1
};
let notificationExpanded = false;
const notificationState = () => ({
  locale: "zh-CN", expanded: notificationExpanded, expandedContentHeight: 260,
  collapsedLayers: 2,
  items: [1, 2, 3].map(i => ({
    threadID: "demo-notification-" + i,
    title: i === 1 ? "整理项目计划" : "示例任务 " + i,
    body: "演示进展：工作已完成，点击查看对应会话。",
    closeLabel: "关闭通知", appName: "CodeX状态提醒"
  }))
});
const dotState = {
  quotaAvailable: true, quotaRemainingPercent: 81, timeRemainingPercent: 85,
  unreadCount: 0, runningCount: 1,
  accessibilityLabel: "演示：81% 周额度剩余"
};
function requireTrusted(event, name) {
  assert(trustedRendererEvent(event, windows[name], rendererURL(base, name + ".html")), name + " real IPC sender must match packaged main frame");
}
for (const channel of ["get", "update"]) {
  ipcMain.handle("companion:settings-" + channel, (event, patch) => {
    requireTrusted(event, "settings");
    messages.push({ window: "settings", type: channel });
    if (channel === "get") return settings;
    const next = normalizeSettings({ ...settings, ...patch });
    settings = {
      ...settings, ...next, codexConnection: { ...next.codexConnection, ...settings.codexConnection },
      effectiveLocale: next.locale === "en" ? "en" : "zh-CN"
    };
    return { settings };
  });
}
ipcMain.on("companion:panel-message", (event, message) => {
  requireTrusted(event, "panel"); messages.push({ window: "panel", type: message.type });
  if (message.type === "ready") windows.panel.webContents.send("companion:snapshot", panelState);
});
ipcMain.on("companion:dot-message", (event, message) => {
  requireTrusted(event, "dot"); messages.push({ window: "dot", type: message.type });
  if (message.type === "ready") windows.dot.webContents.send("companion:snapshot", dotState);
});
ipcMain.on("companion:notification-message", (event, message) => {
  requireTrusted(event, "notification"); messages.push({ window: "notification", type: message.type });
  if (message.type === "toggle-expanded") notificationExpanded = !notificationExpanded;
  if (message.type === "ready" || message.type === "toggle-expanded") {
    windows.notification.webContents.send("companion:notification-content", notificationState());
  }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(name, expression) {
  for (let i = 0; i < 50; i++) {
    if (await windows[name].webContents.executeJavaScript(expression)) return;
    await delay(40);
  }
  throw new Error("Renderer did not become ready: " + name);
}
app.whenReady().then(async () => {
  app.dock?.hide();
  const checks = [];
  try {
    await require("./token-speed-worker-check.cjs")({ base, isolatedData });
    checks.push("packaged external worker reads synthetic SQLite and incremental usage under Electron, switches live to average and clears total on stop");
    for (const [name, width, height] of [
      ["dot", 64, 64], ["panel", 400, 545], ["settings", 560, 900], ["notification", 440, 144]
    ]) {
      const win = new BrowserWindow({
        width, height, show: false, frame: false, transparent: true,
        backgroundColor: "#00000000",
        webPreferences: { preload: path.join(base, "preload-" + name + ".js"), sandbox: true, contextIsolation: true, nodeIntegration: false }
      });
      windows[name] = win;
      protectRendererWindow(win, rendererURL(base, name + ".html"));
      win.webContents.on("console-message", (_event, ...details) => {
        const message = typeof details[0] === "object" ? details[0].message : details[1];
        if (message && /error|violat|refused/i.test(message) && !String(message).includes("badSmokeProbe")) {
          unexpectedConsole.push({ name, message });
        }
      });
      await win.loadFile(path.join(base, "renderer", name + ".html"));
    }
    await waitFor("dot", "document.body.textContent.includes('81')");
    await waitFor("panel", "document.querySelectorAll('.status-task-row').length === 3");
    await waitFor("settings", "document.getElementById('app-version').textContent === " + JSON.stringify(candidateVersion));
    await waitFor("notification", "document.querySelectorAll('.completion-notification').length === 1");
    fs.writeFileSync(path.join(reportDir, "notification-collapsed.png"),
      (await windows.notification.capturePage()).toPNG());
    checks.push("all four packaged pages render through production preloads and real main-frame IPC");
    await windows.panel.webContents.executeJavaScript("document.querySelector('.status-task-row').click()");
    await windows.settings.webContents.executeJavaScript("document.getElementById('showDesktopWidget').click()");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelector('.status-speed-value').textContent"), "41.0 tok/s");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelectorAll('.status-task-speed-value')[0].textContent"), "平均 45.0 tok/s");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelectorAll('.status-task-speed-value')[1].textContent"), "41.0 tok/s");
    assert.deepEqual(await windows.panel.webContents.executeJavaScript(
      "[...document.querySelectorAll('.status-usage-label')].map(e=>e.textContent)"
    ), ["最近 7 天","最近 24 小时","当前速率"]);
    assert.deepEqual(await windows.panel.webContents.executeJavaScript(
      "[...document.querySelectorAll('.status-usage-values, .status-task-usage')].map(el=>el.textContent)"
    ), ["28.8M Token","6.4M Token","41.0 tok/s","累计 2.4M Token","累计 1.5M Token","累计 936.0K Token"]);
    assert.equal(await windows.panel.webContents.executeJavaScript(
      "document.querySelectorAll('.status-task-usage')[1].title"
    ), "累计 1,460,000 Token");
    const rateColors = await windows.panel.webContents.executeJavaScript(`(() => {
      const rows=[...document.querySelectorAll('.status-task-row')];
      return {total:getComputedStyle(document.querySelector('.status-speed-value')).color,
        rows:rows.map(e=>({color:getComputedStyle(e.querySelector('.status-task-speed-value')).color,
          phase:getComputedStyle(e.querySelector('.status-task-phase')).color})),
        runningCount:getComputedStyle(document.querySelector('.status-task-metric.is-running')).color};
    })()`);
    assert.equal(rateColors.total,"rgb(212, 172, 132)","global throughput uses readable, restrained running-task orange");
    assert.deepEqual(rateColors.rows.map(r=>r.color),["rgb(149, 183, 163)","rgb(212, 172, 132)","rgb(165, 177, 185)"]);
    assert(rateColors.rows.every(r=>r.color===r.phase),"each rate exactly matches its own state label color");
    assert.equal(rateColors.runningCount,rateColors.rows[1].color,"running count uses the same orange as its task rows");
    assert.equal(rateColors.total,rateColors.runningCount,"aggregate, running rows, labels and count share one color");
    const hierarchy=await windows.panel.webContents.executeJavaScript(`(() => {
      const row=document.querySelectorAll('.status-task-row')[1],title=getComputedStyle(row.querySelector('.status-task-title')),
        speed=getComputedStyle(row.querySelector('.status-task-speed-value')),phase=getComputedStyle(row.querySelector('.status-task-phase')),
        body=getComputedStyle(row.querySelector('.status-task-update-text'));
      return {titleSize:parseFloat(title.fontSize),speedSize:parseFloat(speed.fontSize),phaseSize:parseFloat(phase.fontSize),
        bodySize:parseFloat(body.fontSize),titleWeight:Number(title.fontWeight),speedWeight:Number(speed.fontWeight),phaseWeight:Number(phase.fontWeight),phaseBackground:phase.backgroundColor};
    })()`);
    assert(hierarchy.titleSize>hierarchy.speedSize&&hierarchy.titleSize>hierarchy.phaseSize);
    assert.equal(hierarchy.speedSize,10.5);
    assert.equal(hierarchy.speedSize,hierarchy.bodySize,"rate uses the same size as the progress text");
    assert.equal(hierarchy.phaseSize,hierarchy.bodySize,"state label uses the same size as the progress text");
    assert.equal(await windows.panel.webContents.executeJavaScript(`(() => [...document.querySelectorAll('.status-task-row')].every(row=>{
      const size=el=>parseFloat(getComputedStyle(row.querySelector(el)).fontSize);
      return size('.status-task-speed-value')===size('.status-task-update-text')&&size('.status-task-phase')===size('.status-task-update-text');
    }))()`),true,"all three states have equally readable metadata");
    assert(hierarchy.titleWeight>hierarchy.speedWeight&&hierarchy.titleWeight>hierarchy.phaseWeight,"session title has the strongest type hierarchy");
    assert(hierarchy.phaseBackground.includes("0.07"),"status background is slightly stronger while remaining subdued");
    fs.writeFileSync(path.join(reportDir, "token-rate-colors.png"), (await windows.panel.capturePage()).toPNG());
    const layout = await windows.panel.webContents.executeJavaScript(`(() => {
      const frame=document.querySelector('.status-popover-frame').getBoundingClientRect();
      return {height:frame.height, overflow:document.documentElement.scrollWidth>innerWidth,
        summarySeparate:!!document.querySelector('.status-usage-section .status-speed-value')
          && !document.querySelector('.status-popover-header .status-speed-value')
          && !!document.querySelector('.status-popover-header .status-task-summary'),
        quota:[...document.querySelectorAll('.status-info-value')].map(e=>getComputedStyle(e).color),
        reset:document.querySelector('.status-info-card.is-time .status-reset-value').textContent,
        noExtraArea:!document.querySelector('.status-speed-strip') && !document.querySelector('.status-task-speed'),
        progress:[...document.querySelectorAll('.status-task-row')].every(row=>{
          const text=row.querySelector('.status-task-update-text'), box=text.getBoundingClientRect(), headline=row.querySelector('.status-task-headline');
          const speed=row.querySelector('.status-task-speed-value'),usage=row.querySelector('.status-task-usage');
          return box.bottom<=row.getBoundingClientRect().bottom-5 && box.width>=row.clientWidth-22 && getComputedStyle(text).webkitLineClamp==='3'
            && headline.children[1]===speed && speed.nextElementSibling.classList.contains('status-task-phase')
            && headline.nextElementSibling===usage && usage.getBoundingClientRect().top>=headline.getBoundingClientRect().bottom;
        })};
    })()`);
    assert(layout.height<=545 && !layout.overflow && layout.progress && layout.summarySeparate && layout.noExtraArea, JSON.stringify(layout));
    assert.equal(layout.quota.length, 2);
    assert.equal(layout.quota[0],layout.quota[1],"quota cards share neutral value color");
    assert.equal(layout.reset,"5天 23小时后重置");
    windows.panel.show();
    windows.panel.webContents.focus();
    const focusDetails = [];
    for (const selector of [".status-info-card.is-time", ...[1, 2, 3].map(i => ".status-usage-metric:nth-child(" + i + ")")]) {
      windows.panel.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      windows.panel.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      await waitFor("panel", `document.activeElement.matches(${JSON.stringify(selector)})`);
      focusDetails.push(await windows.panel.webContents.executeJavaScript(`(() => {
        const el = document.activeElement;
        return { shown: el.matches(':focus-visible') && getComputedStyle(el, '::after').content !== 'none', title: el.title };
      })()`));
    }
    await windows.panel.webContents.executeJavaScript("document.activeElement.blur()");
    windows.panel.hide();
    assert(focusDetails.every(item => item.shown && item.title), JSON.stringify(focusDetails));
    assert.match(focusDetails[0].title, /2026-11-16 13:00/);
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelectorAll('.status-task-update-text')[1].textContent"),panelState.tasks[1].progress);
    const longProgress = await windows.panel.webContents.executeJavaScript(`(() => {const e=document.querySelectorAll('.status-task-update-text')[1];return {height:e.getBoundingClientRect().height,line:parseFloat(getComputedStyle(e).lineHeight)};})()`);
    assert(longProgress.height > longProgress.line*2,"three full lines of current progress must remain visible");
    for (const seconds of [60,300,30]) {
      await windows.settings.webContents.executeJavaScript(`var range=document.getElementById('tokenSpeedWindowSeconds');range.value='${seconds}';range.dispatchEvent(new Event('change',{bubbles:true}));`);
      await waitFor("settings",`document.getElementById('tokenSpeedWindowSeconds').value === '${seconds}' && document.getElementById('save-state').textContent === '设置会自动保存'`);
      assert.equal(settings.tokenSpeedWindowSeconds,seconds);
    }
    const held=speedPanel([{state:"running",tokenSpeed:{completeStart:true,samples:[{at:Date.now()-40_000,output:630}],phase:"sampled"}}],"zh-CN");
    windows.panel.webContents.send("companion:snapshot",{...panelState,renderRevision:10,unreadCount:0,runningCount:1,tokenSpeed:held.total,
      tasks:[{...panelState.tasks[1],speed:held.rows[0]}]});
    await waitFor("panel","document.querySelector('.status-speed-value').textContent === '21.0 tok/s' && document.querySelector('.status-task-speed-value').textContent === '21.0 tok/s'");
    const rateCopy=await windows.panel.webContents.executeJavaScript("[...document.querySelectorAll('.status-speed-value,.status-task-speed-value')].map(e=>[e.textContent,e.title,e.getAttribute('aria-label')].join(' ')).join(' ')");
    assert.doesNotMatch(rateCopy,/实时|沿用|≈|30秒|5分钟/);
    assert.equal(await windows.panel.webContents.executeJavaScript("(()=>{const v=document.querySelector('.status-speed-value');return v.scrollWidth<=v.clientWidth+1 && v.closest('.status-usage-metric')===document.querySelectorAll('.status-usage-metric')[2];})()"),true,"current rate fits in its own third cell");
    windows.panel.showInactive();
    await windows.panel.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    fs.writeFileSync(path.join(reportDir,"token-rate-held.png"),(await windows.panel.capturePage()).toPNG());
    windows.panel.hide();
    const fresh=speedPanel([{state:"running",tokenSpeed:{completeStart:true,samples:[{at:Date.now(),output:900}],phase:"sampled"}}],"zh-CN");
    windows.panel.webContents.send("companion:snapshot",{...panelState,renderRevision:11,unreadCount:0,runningCount:1,tokenSpeed:fresh.total,
      tasks:[{...panelState.tasks[1],speed:fresh.rows[0]}]});
    await waitFor("panel","document.querySelector('.status-speed-value').textContent === '30.0 tok/s' && document.querySelector('.status-task-speed-value').textContent === '30.0 tok/s'");
    const pending=speedPanel([{state:"running"}],"zh-CN");
    windows.panel.webContents.send("companion:snapshot",{...panelState,renderRevision:12,tokenSpeed:pending.total,tasks:[{...panelState.tasks[1],speed:pending.rows[0]}]});
    await waitFor("panel","document.querySelector('.status-task-speed-value').textContent === '待上报'");
    const stopped = speedPanel([{state:"completed",tokenSpeed:{completeStart:true,hasUsage:true,endedAt:Date.now(),durationMs:10000,output:250}}], "en");
    windows.panel.setContentSize(320, 545);
    windows.panel.webContents.send("companion:snapshot", {...panelState,locale:"en",runningCount:0,renderRevision:4,
      usage:{week:{state:"partial",value:123456},day:{state:"partial",value:null}},
      tokenSpeed:stopped.total,tasks:[{...panelState.tasks[1],title:"Very long session name ".repeat(20),stateClass:"completed",stateLabel:"Processed",speed:stopped.rows[0],usage:{state:"partial",value:936000}}]});
    await waitFor("panel", "document.querySelector('.status-speed-value').textContent === '0.0 tok/s' && document.querySelector('.status-task-speed-value').textContent === 'Average 25.0 tok/s'");
    assert.equal(await windows.panel.webContents.executeJavaScript("getComputedStyle(document.querySelector('.status-task-speed-value')).color"),rateColors.rows[2].color,"a processed row changes from orange to its gray label color");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.documentElement.scrollWidth <= innerWidth"),true);
    assert.equal(await windows.panel.webContents.executeJavaScript(`(() => {
      const row=document.querySelector('.status-task-row'), title=row.querySelector('.status-task-title'),speed=row.querySelector('.status-task-speed-value'),phase=row.querySelector('.status-task-phase'),body=row.querySelector('.status-task-update-text');
      return innerWidth===320&&title.clientWidth>=60&&title.scrollWidth>title.clientWidth
        && speed.scrollWidth<=speed.clientWidth+1&&phase.scrollWidth<=phase.clientWidth+1
        && title.getBoundingClientRect().right<=speed.getBoundingClientRect().left
        && speed.getBoundingClientRect().right<=phase.getBoundingClientRect().left
        && phase.getBoundingClientRect().right<=row.getBoundingClientRect().right
        && body.getBoundingClientRect().bottom<=row.getBoundingClientRect().bottom-5;
    })()`),true,"larger English rate and label keep readable title space and full-width progress without overlap");
    assert.deepEqual(await windows.panel.webContents.executeJavaScript("[...document.querySelectorAll('.status-usage-values, .status-task-usage')].map(e=>e.textContent)"),
      ["123.5K Token","Unavailable","0.0 tok/s","Total 936.0K Token"]);
    windows.panel.setContentSize(400, 545);
    windows.panel.webContents.send("companion:snapshot", {...panelState,locale:"en",unreadCount:123,runningCount:104,renderRevision:6,
      copy:{taskProgress:"Task progress",unread:"To review",running:"Running",quotaRemaining:"Quota left",timeRemaining:"Time left",resetCountdown:"Resets in"}});
    await waitFor("panel", "document.querySelector('.status-popover-header .status-popover-title').textContent === 'Task progress'");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelector('.status-popover-header').getBoundingClientRect().height <= 21 && document.documentElement.scrollWidth <= innerWidth"),true,"English labels and 99+ counts must not wrap the header or clip the task list");
    windows.panel.webContents.send("companion:snapshot", {...panelState,renderRevision:5});
    await waitFor("panel", "document.querySelectorAll('.status-task-row').length === 3");
    await waitFor("settings", "document.getElementById('showDesktopWidget').checked === false");
    await windows.notification.webContents.executeJavaScript("document.querySelector('.completion-notification-more').click()");
    await waitFor("notification", "document.querySelectorAll('.completion-notification-row').length === 3");
    windows.notification.setContentSize(440, 276);
    assert.equal(await windows.notification.webContents.executeJavaScript(
      "(()=>{const list=document.querySelector('.completion-notification-list');return list.scrollHeight<=list.clientHeight;})()"
    ), true, "three notifications must fit without clipping the last row");
    await windows.notification.webContents.executeJavaScript("document.querySelector('.completion-notification-close').click()");
    await delay(100);
    assert(messages.some(x => x.window === "panel" && x.type === "openTask"));
    assert(messages.some(x => x.window === "settings" && x.type === "update"));
    assert(messages.some(x => x.window === "notification" && x.type === "close"));
    checks.push("task click, settings save, notification expand and close IPC");
    const unknown = {...panelState, unreadCount: "–", renderRevision: 2,
      tasks: [{id: "demo-syncing", title: "等待未读回执", progress: "未读状态暂未同步",
        stateLabel: "待同步", stateClass: "unknown"}]};
    windows.panel.webContents.send("companion:snapshot", unknown);
    await waitFor("panel", "document.querySelectorAll('.status-task-row').length === 1 && document.body.textContent.includes('待同步')");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelector('.status-task-phase').textContent"), "待同步");
    assert.equal(await windows.panel.webContents.executeJavaScript("document.querySelector('.status-task-metric-value').textContent"), "–");
    checks.push("unavailable unread receipts render as syncing and unknown count, never processed or a false zero");
    windows.panel.webContents.send("companion:snapshot", {...panelState, renderRevision: 3});
    await waitFor("panel", "document.querySelectorAll('.status-task-row').length === 3");
    await windows.settings.webContents.executeJavaScript("document.getElementById('showDesktopWidget').click()");
    await waitFor("settings", "document.getElementById('showDesktopWidget').checked === true");
    assert.equal(await windows.settings.webContents.executeJavaScript(
      "!!document.querySelector('#notifyOnUnreadCompletion') && !document.querySelector('#quota-health-title')"
    ),true,"notification remains, advanced quota settings are gone");
    windows.panel.webContents.send("companion:snapshot", {...panelState, renderRevision: 13,
      usage:{week:{state:"partial",value:123456},day:{state:"ready",value:0}},
      tasks:panelState.tasks.map((task,i)=>({...task,usage:{state:"partial",value:i===0?936000:null}}))});
    await waitFor("panel", "document.querySelector('.status-usage-values').textContent === '123.5K Token'");
    assert.deepEqual(await windows.panel.webContents.executeJavaScript(
      "[...document.querySelectorAll('.status-usage-values, .status-task-usage')].map(e=>e.textContent)"
    ),["123.5K Token","0.0 Token","41.0 tok/s","累计 936.0K Token","累计 不可用","累计 不可用"]);
    assert.equal(await windows.panel.webContents.executeJavaScript(`(() => {
      const shown = [...document.querySelectorAll('.status-usage-metric, .status-task-row, .status-task-usage')];
      return shown.some(el => /部分记录|Partial/.test([el.textContent,el.title,el.getAttribute("aria-label")].join(" ")));
    })()`), false, "coverage badges must not appear in panel copy, tooltips or accessibility labels");
    windows.panel.webContents.send("companion:snapshot", {...panelState, renderRevision: 14});
    await waitFor("panel", "document.querySelector('.status-usage-values').textContent === '28.8M Token'");
    checks.push("neutral quota cards, plain usage totals versus unknown and real zero, and rate immediately left of status");
    assert.deepEqual(unexpectedConsole, [], "legitimate renderer content must have no CSP or script errors");
    for (const [name, win] of Object.entries(windows)) {
      assert.equal(await win.webContents.executeJavaScript("typeof window.require"), "undefined");
      // Resizing a hidden window can invalidate its capture surface on macOS.
      win.showInactive();
      await win.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const img = await win.capturePage();
      fs.writeFileSync(path.join(reportDir, name + ".png"), img.toPNG());
      win.hide();
      // An injected DOM script must be blocked, while existing hashed scripts worked.
      await win.webContents.executeJavaScript("var s=document.createElement('script');s.textContent='window.badSmokeProbe=1';document.body.append(s)");
      assert.equal(await win.webContents.executeJavaScript("typeof window.badSmokeProbe"), "undefined");
    }
    checks.push("sandbox has no window.require, hashed CSP permits legitimate pages and blocks injected scripts");
    // Console will include the deliberately blocked probe; all earlier legitimate content must have been clean.
    const legitimateErrors = unexpectedConsole.filter(x => !/Content Security Policy|script-src|Refused to execute inline script/i.test(x.message));
    assert.deepEqual(legitimateErrors, []);
    fs.writeFileSync(path.join(reportDir, "renderer-smoke.json"), JSON.stringify({
      passed: true, checks, messages, electron: process.versions.electron, version: candidateVersion,
      runID: process.env.CODEX_COMPANION_TEST_RUN_ID || "manual",
      renderingMode: "isolated-test-software-capture",
      data: "synthetic only; no Codex data or installed app touched",
      screenshots: ["dot.png", "panel.png", "settings.png", "notification-collapsed.png", "notification.png"]
    }, null, 2) + "\n");
    console.log("PASS Electron renderer smoke: " + checks.length + " groups; synthetic data only");
    for (const win of Object.values(windows)) if (!win.isDestroyed()) win.destroy();
    // These isolated renderer assertions are complete. Do not wait on the
    // pristine runtime's ordinary UI termination flow (which can hang on CI).
    // This is not the installed application's quit/recovery implementation.
    fs.rmSync(isolatedData, {recursive: true, force: true});
    app.exit(0);
  } catch (error) {
    console.error(error.stack);
    for (const win of Object.values(windows)) if (!win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});
