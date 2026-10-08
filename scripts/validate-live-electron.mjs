import fs from "node:fs/promises";
import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.COMPANION_DEBUG_PORT || 9338);
const baseURL = `http://127.0.0.1:${port}`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const outputDir = path.join(projectDir, "dist");
const companionRuntimeDir = process.env.COMPANION_RUNTIME_DIR || "";
const validateNotificationGroup = process.env.COMPANION_NOTIFICATION_PREVIEW_GROUP === "1";
const companionCommandSocketPath = process.env.COMPANION_COMMAND_SOCKET_PATH
  || (companionRuntimeDir
    ? path.join(
      os.tmpdir(),
      `ccmb-${crypto.createHash("sha256")
        .update(path.join(companionRuntimeDir, "settings.json"))
        .digest("hex")
        .slice(0, 12)}.sock`,
    )
    : "");

const delay = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

async function listTargets() {
  const response = await fetch(`${baseURL}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP target list failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForTarget(title, timeoutMilliseconds = 12_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets();
    } catch {
      await delay(100);
      continue;
    }
    const target = targets.find((item) => item.title === title);
    if (target) return target;
    await delay(100);
  }
  throw new Error(`CDP target not found: ${title}`);
}

async function waitForTargetURL(urlFragment, timeoutMilliseconds = 12_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets();
    } catch {
      await delay(100);
      continue;
    }
    const target = targets.find((item) => item.url.includes(urlFragment));
    if (target) return target;
    await delay(100);
  }
  throw new Error(`CDP target not found: ${urlFragment}`);
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message));
    } else {
      waiter.resolve(message.result);
    }
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    const result = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    socket.send(JSON.stringify({ id, method, params }));
    return result;
  };

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  return { socket, send, evaluate };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function sendMenuCommand(command) {
  if (!companionCommandSocketPath) return false;
  const envelope = JSON.stringify({
    id: `live-validation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    command,
  });
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(companionCommandSocketPath);
    socket.once("connect", () => {
      socket.write(`${envelope}\n`, () => {
        socket.end();
        resolve();
      });
    });
    socket.once("error", reject);
  });
  return true;
}

await fs.mkdir(outputDir, { recursive: true });

const dotTarget = await waitForTargetURL("dot.html");
const dot = await connect(dotTarget);
await delay(400);

const dotDetails = await dot.evaluate(`(() => {
  const button = document.querySelector(".status-dot-button");
  const timeTrack = document.querySelector(".status-dot-ring-track.is-time");
  const quotaTrack = document.querySelector(".status-dot-ring-track.is-quota");
  const timeRing = document.querySelector(".status-dot-ring-progress.is-time");
  const quotaRing = document.querySelector(".status-dot-ring-progress.is-quota");
  const center = document.querySelector(".status-dot-center");
  const timeStart = document.querySelector(".time-ring-gradient-start");
  const timeMid = document.querySelector(".time-ring-gradient-mid");
  const timeEnd = document.querySelector(".time-ring-gradient-end");
  const quotaStart = document.querySelector(".quota-ring-gradient-start");
  const quotaMid = document.querySelector(".quota-ring-gradient-mid");
  const quotaEnd = document.querySelector(".quota-ring-gradient-end");
  const legacyShells = document.querySelectorAll(
    ".status-dot-time-shell, .status-dot-quota-shell, .status-dot-quota-highlight",
  );
  const value = document.querySelector(".status-dot-value");
  const rect = button?.getBoundingClientRect();
  const style = button ? getComputedStyle(button) : null;
  const timeStyle = timeRing ? getComputedStyle(timeRing) : null;
  const quotaStyle = quotaRing ? getComputedStyle(quotaRing) : null;
  const timeTrackStyle = timeTrack ? getComputedStyle(timeTrack) : null;
  const quotaTrackStyle = quotaTrack ? getComputedStyle(quotaTrack) : null;
  const centerStyle = center ? getComputedStyle(center) : null;
  const number = value?.querySelector(".status-dot-number");
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    button: rect ? {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      className: button.className,
      cursor: style.cursor,
    } : null,
    timeRing: timeStyle ? {
      stroke: timeStyle.stroke,
      strokeWidth: timeStyle.strokeWidth,
      strokeLinecap: timeStyle.strokeLinecap,
      transform: timeStyle.transform,
      dashOffset: timeStyle.strokeDashoffset,
      radius: timeRing.getAttribute("r"),
    } : null,
    tracks: {
      timeStroke: timeTrackStyle?.stroke || null,
      quotaStroke: quotaTrackStyle?.stroke || null,
      quotaPaintIndex: quotaTrack
        ? [...quotaTrack.parentElement.children].indexOf(quotaTrack)
        : -1,
      timePaintIndex: timeTrack
        ? [...timeTrack.parentElement.children].indexOf(timeTrack)
        : -1,
    },
    quotaRing: quotaStyle ? {
      stroke: quotaStyle.stroke,
      strokeWidth: quotaStyle.strokeWidth,
      strokeLinecap: quotaStyle.strokeLinecap,
      transform: quotaStyle.transform,
      dashOffset: quotaStyle.strokeDashoffset,
      radius: quotaRing.getAttribute("r"),
    } : null,
    centerFill: centerStyle?.fill || null,
    gradientColors: {
      timeStart: timeStart ? getComputedStyle(timeStart).stopColor : null,
      timeMid: timeMid ? getComputedStyle(timeMid).stopColor : null,
      timeEnd: timeEnd ? getComputedStyle(timeEnd).stopColor : null,
      quotaStart: quotaStart ? getComputedStyle(quotaStart).stopColor : null,
      quotaMid: quotaMid ? getComputedStyle(quotaMid).stopColor : null,
      quotaEnd: quotaEnd ? getComputedStyle(quotaEnd).stopColor : null,
    },
    legacyShellCount: legacyShells.length,
    value: value?.innerText || "",
    valueContainsPercent: (value?.innerText || "").includes("%"),
    locale: document.documentElement.lang,
    numberRect: number?.getBoundingClientRect().toJSON() || null,
    text: document.body.innerText,
  };
})()`);

const dotScreenshot = await dot.send("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  captureBeyondViewport: true,
});
await fs.writeFile(
  path.join(outputDir, "live-electron-dot.png"),
  Buffer.from(dotScreenshot.data, "base64"),
);

let notification = null;
let notificationDetails = null;
let notificationCollapsedScreenshot = null;
let notificationExpandedScreenshot = null;
const notificationTarget = validateNotificationGroup
  ? await waitForTargetURL("notification.html")
  : (await listTargets()).find((item) => item.url.includes("notification.html"));
if (notificationTarget) {
  notification = await connect(notificationTarget);
  notificationDetails = await notification.evaluate(`(() => {
    const card = document.querySelector(".completion-notification");
    const titlebar = document.querySelector(".completion-notification-titlebar");
    const icon = document.querySelector(".completion-notification-icon");
    const title = document.querySelector(".completion-notification-title");
    const close = document.querySelector(".completion-notification-close");
    const body = document.querySelector(".completion-notification-body");
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      card: card?.getBoundingClientRect().toJSON() || null,
      titlebar: titlebar?.getBoundingClientRect().toJSON() || null,
      icon: icon?.getBoundingClientRect().toJSON() || null,
      title: title?.innerText || "",
      close: close ? {
        rect: close.getBoundingClientRect().toJSON(),
        ariaLabel: close.getAttribute("aria-label"),
      } : null,
      body: {
        text: body?.innerText || "",
        rect: body?.getBoundingClientRect().toJSON() || null,
        lineClamp: body ? getComputedStyle(body).webkitLineClamp : null,
      },
    };
  })()`);
  assert(
    notificationDetails.icon?.width === 22
      && notificationDetails.icon?.height === 22,
    "通知图标没有缩小到标题栏",
  );
  assert(
    notificationDetails.close?.rect?.width === 22
      && notificationDetails.close?.rect?.height === 22
      && notificationDetails.close?.ariaLabel === "关闭通知",
    "通知右上角没有可访问的 22px 关闭控件",
  );
  assert(
    Math.abs(
      notificationDetails.card.right
        - notificationDetails.close.rect.right
        - 15,
    ) < 1,
    "通知关闭按钮没有固定在卡片右侧 14px 内边距加 1px 描边内",
  );
  assert(
    Math.abs(
      notificationDetails.body?.rect?.width
        - notificationDetails.titlebar?.width,
    ) < 1
      && Math.abs(
        notificationDetails.body?.rect?.left
          - notificationDetails.titlebar?.left,
      ) < 1,
    "通知正文仍为大图标预留了左侧整列空间",
  );
  assert(notificationDetails.body?.lineClamp === "2", "通知正文没有限制为两行");
  const notificationScreenshot = await notification.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  });
  await fs.writeFile(
    path.join(outputDir, "live-electron-notification.png"),
    Buffer.from(notificationScreenshot.data, "base64"),
  );

  if (validateNotificationGroup) {
    const collapsed = await notification.evaluate(`(() => ({
      group: Boolean(document.querySelector(".completion-notification-group")),
      rearLayers: document.querySelectorAll(".completion-notification-stack-layer").length,
      more: document.querySelector(".completion-notification-more")?.innerText || "",
      cardCount: document.querySelectorAll(".completion-notification").length,
    }))()`);
    assert(collapsed.group, "多任务提醒没有使用方案 A 的原生组栈收起态");
    assert(collapsed.rearLayers === 2, "收起态没有保留两层轻量边缘");
    assert(collapsed.more === "+3", "收起态没有展示其余提醒数量");
    assert(collapsed.cardCount === 1, "收起态不应叠放多张完整通知卡片");
    const collapsedScreenshot = await notification.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
    });
    notificationCollapsedScreenshot = path.join(
      outputDir,
      "live-electron-notification-group-collapsed.png",
    );
    await fs.writeFile(
      notificationCollapsedScreenshot,
      Buffer.from(collapsedScreenshot.data, "base64"),
    );

    await notification.evaluate(`(() => {
      document.querySelector(".completion-notification-more")?.click();
      return true;
    })()`);
    await delay(260);
    const expanded = await notification.evaluate(`(() => {
      const list = document.querySelector(".completion-notification-list");
      return {
        panel: Boolean(document.querySelector(".completion-notification-expanded")),
        rowCount: document.querySelectorAll(".completion-notification-row").length,
        listClientHeight: list?.clientHeight || 0,
        listScrollHeight: list?.scrollHeight || 0,
        collapseLabel: document.querySelector(".completion-notification-collapse")?.innerText || "",
      };
    })()`);
    assert(expanded.panel, "点击 +N 后没有展开方案 A 任务组");
    assert(expanded.rowCount === 4, "展开态没有保留全部待查看任务");
    assert(
      expanded.listScrollHeight > expanded.listClientHeight,
      "超过三条任务时展开组没有使用内部滚动",
    );
    assert(expanded.collapseLabel === "收起通知", "展开态缺少收起操作");
    const expandedScreenshot = await notification.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
    });
    notificationExpandedScreenshot = path.join(
      outputDir,
      "live-electron-notification-group-expanded.png",
    );
    await fs.writeFile(
      notificationExpandedScreenshot,
      Buffer.from(expandedScreenshot.data, "base64"),
    );

    await notification.evaluate(`(() => {
      document.querySelector('[data-thread-id="preview-group-4"] .completion-notification-close')?.click();
      return true;
    })()`);
    await delay(220);
    const afterClose = await notification.evaluate(
      `document.querySelectorAll(".completion-notification-row").length`,
    );
    assert(afterClose === 3, "展开组的单条关闭没有只移除对应提醒");
    notificationDetails.group = { collapsed, expanded, afterClose };
  }

  // The preview entry is isolated from the real completion queue. Exercise
  // the close control in the packaged renderer without marking a Codex task
  // as read or opening an external URL.
  const previewVisible = await notification.evaluate(
    `Boolean(document.querySelector('[data-thread-id="preview"] .completion-notification-close'))`,
  );
  if (previewVisible) {
    await notification.evaluate(
      `document.querySelector('[data-thread-id="preview"] .completion-notification-close').click(); true`,
    );
    await delay(300);
    const remainingTargets = await listTargets();
    const remainingNotification = remainingTargets.find(
      (item) => item.url.includes("notification.html"),
    );
    if (remainingNotification) {
      const remaining = await connect(remainingNotification);
      const previewStillVisible = await remaining.evaluate(
        `Boolean(document.querySelector('[data-thread-id="preview"]'))`,
      );
      assert(!previewStillVisible, "通知关闭按钮没有移除对应横幅");
      remaining.socket.close();
    }
  }
}

assert(dotDetails.viewport.width === 64, "圆点窗口宽度不是 64px");
assert(dotDetails.viewport.height === 64, "圆点窗口高度不是 64px");
assert(dotDetails.button?.width === 44, "可见圆点宽度不是 44px");
assert(dotDetails.button?.height === 44, "可见圆点高度不是 44px");
assert(dotDetails.timeRing?.strokeLinecap === "butt", "时间环端点不是平头切片");
assert(dotDetails.quotaRing?.strokeLinecap === "butt", "额度环端点不是平头切片");
assert(dotDetails.legacyShellCount === 0, "圆环仍保留额外壳层");
assert(
  dotDetails.timeRing?.strokeWidth === dotDetails.quotaRing?.strokeWidth,
  "内外环的线宽不一致",
);
assert(dotDetails.timeRing?.strokeWidth === "4px", "圆环未使用连续的 4px 色带");
assert(dotDetails.timeRing?.radius === "19", "外环半径发生意外变化");
assert(dotDetails.quotaRing?.radius === "15.5", "内环未与外环连续衔接");
assert(
  dotDetails.tracks?.timeStroke
    && dotDetails.tracks.timeStroke === dotDetails.tracks.quotaStroke,
  "内外环轨道没有使用统一底色，接缝可能再次出现亮线",
);
assert(
  dotDetails.tracks.quotaPaintIndex < dotDetails.tracks.timePaintIndex,
  "内环必须先绘制，让外环覆盖共享边缘",
);
assert(
  dotDetails.gradientColors.timeStart === "rgb(101, 230, 239)"
    && dotDetails.gradientColors.timeMid === "rgb(73, 215, 233)"
    && dotDetails.gradientColors.timeEnd === "rgb(40, 166, 222)",
  "时间环没有复用 Logo 的青蓝渐变",
);
assert(!dotDetails.valueContainsPercent, "圆心额度不应显示百分号");
const healthClass = ["healthy", "watch", "critical", "neutral"].find(
  (name) => dotDetails.button?.className.includes(`is-${name}`),
);
assert(healthClass, "圆点没有额度健康度状态类");
assert(
  [
    dotDetails.gradientColors.quotaStart,
    dotDetails.gradientColors.quotaMid,
    dotDetails.gradientColors.quotaEnd,
  ].every((color) => /^rgb\(\d+, \d+, \d+\)$/.test(color || "")),
  "额度环渐变缺少连续的 start/mid/end 色阶",
);

await dot.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: 1,
  y: 1,
});
await delay(80);
await dot.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: dotDetails.button.x + dotDetails.button.width / 2,
  y: dotDetails.button.y + dotDetails.button.height / 2,
});

const panelTarget = await waitForTargetURL("panel.html");
const panel = await connect(panelTarget);
await delay(700);
await panel.send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: -8,
  y: -8,
});
await delay(160);

const panelDetails = await panel.evaluate(`(() => {
  const frame = document.querySelector(".status-popover-frame");
  const content = document.querySelector(".status-popover-content");
  const grid = document.querySelector(".status-info-grid");
  const list = document.querySelector(".status-task-list");
  if (list) list.scrollTop = 0;
  const scroll = document.querySelector(".status-task-scroll");
  const rows = [...document.querySelectorAll(".status-task-row")];
  const metrics = [...document.querySelectorAll(".status-task-metric")];
  const phases = rows.map((row) =>
    row.querySelector(".status-task-phase")?.innerText || ""
  );
  const rank = {
    "待查看": 0,
    "进行中": 1,
    "已处理": 2,
    Unread: 0,
    Running: 1,
    Processed: 2,
  };
  const sorted = phases.every((phase, index) =>
    index === 0 || rank[phases[index - 1]] <= rank[phase]
  );
  const listRect = list?.getBoundingClientRect();
  const indicator = document.querySelector(".status-task-scrollbar");
  const firstProgress = document.querySelector(".status-task-update-text");
  const healthBadge = document.querySelector(".status-health-badge");
  return {
    viewport: {
      width: innerWidth,
      height: innerHeight,
      dpr: devicePixelRatio,
    },
    frame: frame?.getBoundingClientRect().toJSON() || null,
    content: content?.getBoundingClientRect().toJSON() || null,
    grid: grid?.getBoundingClientRect().toJSON() || null,
    infoLabels: [...document.querySelectorAll(".status-info-label")]
      .map((element) => element.innerText),
    health: {
      className: content?.className || "",
      label: healthBadge?.innerText || "",
      title: healthBadge?.title || "",
    },
    metrics: metrics.map((metric) => ({
      label: metric.querySelector(".status-task-metric-label")?.innerText || "",
      value: metric.querySelector(".status-task-metric-value")?.innerText || "",
      rect: metric.getBoundingClientRect().toJSON(),
      fontSize: getComputedStyle(metric).fontSize,
    })),
    tasks: rows.map((row) => ({
      title: row.querySelector(".status-task-title")?.innerText || "",
      progress: (row.querySelector(".status-task-update-text")?.innerText || "")
        .slice(0, 240),
      status: row.querySelector(".status-task-phase")?.innerText || "",
      rect: row.getBoundingClientRect().toJSON(),
    })),
    phaseStyles: rows.map((row) => {
      const phase = row.querySelector(".status-task-phase");
      return {
        className: phase?.className || "",
        color: phase ? getComputedStyle(phase).color : "",
      };
    }),
    taskList: list ? {
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      rowCount: rows.length,
      visibleRowCount: rows.filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > listRect.top + 0.5
          && rect.top < listRect.bottom - 0.5;
      }).length,
      nativeScrollbarWidth: getComputedStyle(list).scrollbarWidth,
      customScrollbarWidth: indicator?.getBoundingClientRect().width || null,
      customScrollbarOpacity: indicator
        ? getComputedStyle(indicator).opacity
        : null,
    } : null,
    phases,
    statusOrderValid: sorted,
    progress: firstProgress ? {
      lineClamp: getComputedStyle(firstProgress).webkitLineClamp,
      lineHeight: getComputedStyle(firstProgress).lineHeight,
      clientHeight: firstProgress.clientHeight,
      scrollHeight: firstProgress.scrollHeight,
    } : null,
    overflow: {
      horizontal: document.documentElement.scrollWidth > innerWidth,
      vertical: document.documentElement.scrollHeight > innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    },
  };
})()`);

const panelScreenshot = await panel.send("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  captureBeyondViewport: true,
});
await fs.writeFile(
  path.join(outputDir, "live-electron-panel.png"),
  Buffer.from(panelScreenshot.data, "base64"),
);

const settingsTarget = await waitForTargetURL("settings.html");
const settingsPage = await connect(settingsTarget);
await delay(250);
const originalSettings = await settingsPage.evaluate(
  "window.companionSettings.get()",
);
const settingsDetails = await settingsPage.evaluate(`(() => ({
  title: document.querySelector("h1")?.innerText || "",
  version: document.getElementById("app-version")?.innerText || "",
  locale: document.getElementById("locale")?.value || "",
  effectiveLocale: document.documentElement.lang,
  initialRoute: {
    onboardingPresent: Boolean(document.getElementById("onboarding")),
    settingsVisible: document.getElementById("settings-content")?.hidden !== true,
    legacyControlCount: document.querySelectorAll(
      'input[name="onboarding-display"], #onboarding-notifications, #onboarding-login, #onboarding-continue, #onboarding-finish'
    ).length,
  },
  quotaHealthThresholds: {
    mode: document.getElementById("custom-warning-enabled")?.checked
      ? "custom"
      : "linked",
    healthy: Number(document.getElementById("quotaHealthyLeadDays")?.value),
    warning: Number(document.getElementById("quotaWarningLeadDays")?.value),
    selectedPreset: document.querySelector(".quota-preset.is-selected")
      ?.dataset.healthy || null,
    summary: document.getElementById("quota-rule-summary")?.innerText || "",
    labels: [...document.querySelectorAll(".quota-state-labels b")]
      .map((element) => element.innerText),
    thresholdTrack: (() => {
      const track = document.getElementById("quota-track");
      const healthyMarker = document.getElementById("healthy-marker");
      const warningMarker = document.getElementById("warning-marker");
      if (!track || !healthyMarker || !warningMarker) return null;
      const trackRect = track.getBoundingClientRect();
      const markerPosition = (marker) => {
        const rect = marker.getBoundingClientRect();
        return ((rect.left + rect.width / 2) - trackRect.left) / trackRect.width * 100;
      };
      return {
        healthyMarker: markerPosition(healthyMarker),
        warningMarker: markerPosition(warningMarker),
        segmentCount: document.querySelectorAll(".quota-segment").length,
        warningLocked: warningMarker.classList.contains("is-locked"),
      };
    })(),
  },
  controls: [
    "showDesktopWidget", "showMenuBarQuota", "notifyOnUnreadCompletion", "launchAtLogin"
  ].map((id) => ({ id, present: Boolean(document.getElementById(id)) })),
  retiredControls: [
    "launchAtBoot", "keepInBackground", "showHoverPanel", "alwaysOnTop",
    "showOnAllWorkspaces", "recoverAfterCrash", "display-mode-widget",
    "display-mode-menu", "reset-position", "test-notification", "show-guide",
    "export-diagnostics", "restore-recommended"
  ].map((id) => ({ id, present: Boolean(document.getElementById(id)) })),
  codexConnection: {
    title: document.getElementById("connection-overview-title")?.innerText || "",
    description: document.getElementById("connection-overview-description")?.innerText || "",
    path: document.getElementById("connection-path")?.innerText || "",
    lastSync: document.getElementById("connection-last-sync")?.innerText || "",
    choosePresent: Boolean(document.getElementById("choose-codex-folder")),
    restorePresent: Boolean(document.getElementById("restore-codex-folder")),
    chooseHidden: document.getElementById("choose-codex-folder")?.hidden === true,
    restoreHidden: document.getElementById("restore-codex-folder")?.hidden === true,
    recoveryHidden: document.getElementById("connection-recovery-actions")?.hidden === true,
    detailsHidden: document.getElementById("connection-details")?.hidden === true,
  },
  notificationDelivery: document.getElementById("notification-delivery")?.innerText || "",
  rendererSandbox: {
    require: typeof window.require,
    process: typeof window.process,
    bridge: {
      chooseCodexFolder: typeof window.companionSettings?.chooseCodexFolder,
      restoreDefaultCodexFolder: typeof window.companionSettings?.restoreDefaultCodexFolder,
      retryCodexConnection: typeof window.companionSettings?.retryCodexConnection,
      openCodex: typeof window.companionSettings?.openCodex,
      testNotification: typeof window.companionSettings?.testNotification,
      restoreRecommended: typeof window.companionSettings?.restoreRecommended,
      exportDiagnostics: typeof window.companionSettings?.exportDiagnostics,
      resetPosition: typeof window.companionSettings?.resetPosition,
    },
  },
  brandIcon: (() => {
    const icon = document.querySelector(".settings-mark");
    return icon ? {
      source: icon.getAttribute("src"),
      naturalWidth: icon.naturalWidth,
      naturalHeight: icon.naturalHeight,
    } : null;
  })(),
  autoSaveVisible: Boolean(document.getElementById("save-state")?.innerText),
}))()`);
assert(
  settingsDetails.title === (settingsDetails.effectiveLocale === "en"
    ? "Codex Companion"
    : "CodeX状态提醒"),
  "设置窗口标题未加载"
);
assert(settingsDetails.version === "1.9.8", "设置窗口版本未同步");
assert(["system", "zh-CN", "en"].includes(settingsDetails.locale), "设置窗口语言值无效");
assert(
  ["zh-CN", "en"].includes(settingsDetails.effectiveLocale),
  "系统语言没有解析成有效界面语言",
);
assert(settingsDetails.controls.every((item) => item.present), "设置窗口缺少基础配置项");
assert(
  settingsDetails.retiredControls.every((item) => !item.present),
  "设置窗口仍保留已固化的软件默认行为",
);
assert(
  !settingsDetails.initialRoute.onboardingPresent
    && settingsDetails.initialRoute.settingsVisible
    && settingsDetails.initialRoute.legacyControlCount === 0,
  "首次启动没有直接进入完整设置页",
);
assert(
  settingsDetails.codexConnection.choosePresent
    && settingsDetails.codexConnection.title
    && settingsDetails.codexConnection.description
    && settingsDetails.codexConnection.path
    && settingsDetails.codexConnection.lastSync,
  "设置窗口缺少可检查的 Codex 数据连接"
);
if (
  settingsDetails.codexConnection.title.includes("已自动连接")
  || settingsDetails.codexConnection.title.includes("connected automatically")
) {
  assert(
    settingsDetails.codexConnection.chooseHidden
      && settingsDetails.codexConnection.restoreHidden
      && settingsDetails.codexConnection.recoveryHidden
      && settingsDetails.codexConnection.detailsHidden,
    "稳定自动连接时不应显示重复的重新检测或手动选择入口",
  );
}
assert(
  settingsDetails.rendererSandbox.require === "undefined"
    && settingsDetails.rendererSandbox.process === "undefined"
    && settingsDetails.rendererSandbox.bridge.chooseCodexFolder === "function"
    && settingsDetails.rendererSandbox.bridge.restoreDefaultCodexFolder === "function"
    && settingsDetails.rendererSandbox.bridge.retryCodexConnection === "function"
    && settingsDetails.rendererSandbox.bridge.openCodex === "function"
    && settingsDetails.rendererSandbox.bridge.testNotification === "undefined"
    && settingsDetails.rendererSandbox.bridge.restoreRecommended === "undefined"
    && settingsDetails.rendererSandbox.bridge.exportDiagnostics === "undefined"
    && settingsDetails.rendererSandbox.bridge.resetPosition === "undefined",
  "设置渲染器未保持沙箱边界或缺少受控数据连接桥接"
);
assert(
  settingsDetails.notificationDelivery.length > 0,
  "设置页没有说明当前任务提醒方式",
);
assert(
  settingsDetails.brandIcon?.source === "app-icon.png"
    && settingsDetails.brandIcon.naturalWidth === 128
    && settingsDetails.brandIcon.naturalHeight === 128,
  "设置页没有复用应用 Logo 资产",
);
assert(settingsDetails.autoSaveVisible, "设置页缺少固定的自动保存反馈");
assert(
  Number.isFinite(settingsDetails.quotaHealthThresholds.healthy)
    && Number.isFinite(settingsDetails.quotaHealthThresholds.warning)
    && settingsDetails.quotaHealthThresholds.warning
      > settingsDetails.quotaHealthThresholds.healthy,
  "额度健康阈值无效"
);
assert(
  settingsDetails.quotaHealthThresholds.mode === "linked"
    && Math.abs(
      settingsDetails.quotaHealthThresholds.warning
        - settingsDetails.quotaHealthThresholds.healthy * 2
    ) < 0.001,
  "默认额度健康度没有使用健康上限翻倍的警示线"
);
assert(
  (settingsDetails.effectiveLocale === "en"
    ? settingsDetails.quotaHealthThresholds.summary.includes("Watch")
      && settingsDetails.quotaHealthThresholds.summary.includes("Quota alert")
      && JSON.stringify(settingsDetails.quotaHealthThresholds.labels)
        === JSON.stringify(["Normal", "Watch", "Quota alert"])
    : settingsDetails.quotaHealthThresholds.summary.includes("需留意")
      && settingsDetails.quotaHealthThresholds.summary.includes("额度告警")
      && JSON.stringify(settingsDetails.quotaHealthThresholds.labels)
        === JSON.stringify(["正常使用", "需留意", "额度告警"])),
  "额度健康度缺少面向新用户的行为解释"
);
assert(
  settingsDetails.quotaHealthThresholds.thresholdTrack?.segmentCount === 3
    && settingsDetails.quotaHealthThresholds.thresholdTrack.healthyMarker > 0
    && settingsDetails.quotaHealthThresholds.thresholdTrack.warningMarker
      > settingsDetails.quotaHealthThresholds.thresholdTrack.healthyMarker
    && settingsDetails.quotaHealthThresholds.thresholdTrack.warningLocked,
  "额度健康度进度条没有形成两个分界点和三个状态区间"
);

const originalLocale = settingsDetails.locale;
const originalHealthyLeadDays = settingsDetails.quotaHealthThresholds.healthy;
const alternateHealthyLeadDays = originalHealthyLeadDays === 0.25 ? 0.5 : 0.25;
const alternateHealthSettings = await settingsPage.evaluate(
  `(async () => window.companionSettings.update({ quotaHealthMode: "linked", quotaHealthyLeadDays: ${alternateHealthyLeadDays} }))()`,
);
assert(
  alternateHealthSettings?.settings?.quotaHealthyLeadDays === alternateHealthyLeadDays,
  "设置窗口无法修改额度健康阈值",
);
await delay(150);
assert(
  Number(await settingsPage.evaluate(
    "document.getElementById('quotaHealthyLeadDays')?.value",
  )) === alternateHealthyLeadDays,
  "额度健康阈值没有即时刷新",
);
const linkedWarningSettings = await settingsPage.evaluate(
  "window.companionSettings.get()",
);
assert(
  linkedWarningSettings.quotaHealthMode === "linked"
    && linkedWarningSettings.quotaWarningLeadDays === alternateHealthyLeadDays * 2,
  "健康上限变化后警示线没有按 2 倍联动",
);
const customWarningLeadDays = alternateHealthyLeadDays + 0.75;
const customWarningSettings = await settingsPage.evaluate(
  `(async () => window.companionSettings.update({ quotaHealthMode: "custom", quotaWarningLeadDays: ${customWarningLeadDays} }))()`,
);
assert(
  customWarningSettings?.settings?.quotaHealthMode === "custom"
    && customWarningSettings?.settings?.quotaWarningLeadDays === customWarningLeadDays,
  "高级设置无法切换到独立警示线",
);
await settingsPage.evaluate(
  `(async () => window.companionSettings.update({ quotaHealthMode: ${JSON.stringify(originalSettings.quotaHealthMode)}, quotaHealthyLeadDays: ${originalHealthyLeadDays}, quotaWarningLeadDays: ${Number(originalSettings.quotaWarningLeadDays)} }))()`,
);
await delay(150);
const alternateLocale = originalLocale === "zh-CN" ? "en" : "zh-CN";
const alternateSettings = await settingsPage.evaluate(
  `(async () => window.companionSettings.update({ locale: ${JSON.stringify(alternateLocale)} }))()`,
);
assert(
  alternateSettings?.settings?.locale === alternateLocale,
  "设置窗口无法切换语言",
);
await delay(150);
assert(
  await settingsPage.evaluate("document.documentElement.lang") === alternateLocale,
  "设置窗口语言没有即时刷新",
);
assert(
  await settingsPage.evaluate("document.querySelector('h1')?.innerText")
    === (alternateLocale === "en" ? "Codex Companion" : "CodeX状态提醒"),
  "设置窗口切换语言后没有同步应用名称",
);
await settingsPage.evaluate(
  `(async () => window.companionSettings.update({ locale: ${JSON.stringify(originalLocale)} }))()`,
);
await delay(150);
assert(
  await settingsPage.evaluate("document.querySelector('h1')?.innerText")
    === (settingsDetails.effectiveLocale === "en" ? "Codex Companion" : "CodeX状态提醒"),
  "设置窗口恢复语言后没有还原应用名称",
);
await settingsPage.evaluate("document.activeElement?.blur()");
const settingsScreenshot = await settingsPage.send("Page.captureScreenshot", {
  format: "png",
  fromSurface: true,
  captureBeyondViewport: true,
});
await fs.writeFile(
  path.join(outputDir, "live-electron-settings.png"),
  Buffer.from(settingsScreenshot.data, "base64"),
);
const taskListPoint = await panel.evaluate(`(() => {
  const list = document.querySelector(".status-task-list");
  if (!list) return null;
  const rect = list.getBoundingClientRect();
  return { x: rect.right - 8, y: rect.top + 24 };
})()`);
if (taskListPoint) {
  await panel.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: taskListPoint.x,
    y: taskListPoint.y,
  });
  await delay(180);
  await panel.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: taskListPoint.x,
    y: taskListPoint.y,
    deltaX: 0,
    deltaY: 400,
  });
  await delay(180);
}
panelDetails.taskListInteraction = await panel.evaluate(`(() => {
  const list = document.querySelector(".status-task-list");
  const indicator = document.querySelector(".status-task-scrollbar");
  return list ? {
    scrollTop: list.scrollTop,
    customScrollbarOpacity: indicator
      ? getComputedStyle(indicator).opacity
      : null,
  } : null;
})()`);

assert(panelDetails.viewport.width === 360, "任务浮层宽度不是 360px");
const english = dotDetails.locale === "en";
const expectedInfoLabels = english
  ? ["Quota remaining", "Time remaining", "Reset in"]
  : ["额度剩余", "时间剩余", "重置倒计时"];
const expectedMetricLabels = english ? ["Unread", "Running"] : ["待查看", "进行中"];
assert(
  JSON.stringify(panelDetails.infoLabels) === JSON.stringify(expectedInfoLabels),
  "顶部三张额度信息卡不完整",
);
assert(panelDetails.health.label.length > 0, "额度卡片没有显示健康度标签");
assert(panelDetails.health.title.length > 0, "额度健康度缺少可解释说明");
const runningPhase = panelDetails.phaseStyles.find((item) => item.className.includes("is-running"));
if (runningPhase) {
  assert(runningPhase.color === "rgb(234, 212, 127)", "进行中任务没有使用独立的浅黄色状态");
}
assert(
  JSON.stringify(panelDetails.metrics.map((item) => item.label))
    === JSON.stringify(expectedMetricLabels),
  "任务标题栏不是“待查看、进行中”两个指标",
);
assert(panelDetails.taskList?.rowCount >= 3, "任务列表不足三个任务");
assert(panelDetails.taskList?.clientHeight === 258, "任务列表不是三卡片固定高度");
assert(panelDetails.taskList?.visibleRowCount === 3, "默认可见任务数量不是三个");
assert(panelDetails.taskList?.nativeScrollbarWidth === "none", "系统滚动条未隐藏");
assert(panelDetails.taskList?.customScrollbarWidth === 2, "自定义滚动条不是 2px");
assert(panelDetails.taskList?.customScrollbarOpacity === "0", "滚动条默认可见");
assert(panelDetails.taskListInteraction?.scrollTop > 0, "任务列表不能滚动");
assert(
  panelDetails.taskListInteraction?.customScrollbarOpacity === "1",
  "任务区悬停时滚动条未显示",
);
assert(panelDetails.statusOrderValid, "任务状态排序不是待查看、进行中、已处理");
assert(panelDetails.progress?.lineClamp === "3", "最新进展不是最多三行");
assert(!panelDetails.overflow.horizontal, "浮层存在横向溢出");
assert(!panelDetails.overflow.vertical, "浮层存在窗口级纵向溢出");

let menuTransport = null;
if (companionRuntimeDir) {
  await sendMenuCommand("hide-panel");
  await delay(380);
  assert(
    !(await listTargets()).some((item) => item.url.includes("panel.html")),
    "菜单栏命令无法关闭任务面板",
  );
  await sendMenuCommand("show-panel");
  await delay(320);
  assert(
    (await listTargets()).some((item) => item.url.includes("panel.html")),
    "菜单栏左键命令无法打开完整任务面板",
  );
  await sendMenuCommand("show-panel");
  await delay(320);
  assert(
    !(await listTargets()).some((item) => item.url.includes("panel.html")),
    "菜单栏左键命令无法切换关闭任务面板",
  );
  await sendMenuCommand("show-settings");
  await delay(160);
  assert(
    (await listTargets()).some((item) => item.url.includes("settings.html")),
    "菜单栏右键设置命令无法打开设置面板",
  );
  menuTransport = { passed: true, transport: "unix-domain-socket" };
}

const result = {
  passed: true,
  dot: dotDetails,
  panel: panelDetails,
  settings: settingsDetails,
  initialRoute: settingsDetails.initialRoute,
  menuTransport,
    notification: notificationDetails,
  screenshots: {
    dot: path.join(outputDir, "live-electron-dot.png"),
    panel: path.join(outputDir, "live-electron-panel.png"),
    settings: path.join(outputDir, "live-electron-settings.png"),
    notification: notificationDetails
      ? path.join(outputDir, "live-electron-notification.png")
      : null,
    notificationCollapsed: notificationCollapsedScreenshot,
    notificationExpanded: notificationExpandedScreenshot,
  },
};
await fs.writeFile(
  path.join(outputDir, "live-electron-validation.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify({
  passed: result.passed,
  dot: {
    viewport: result.dot.viewport,
    button: result.dot.button,
    value: result.dot.value,
    timeRing: result.dot.timeRing,
    quotaRing: result.dot.quotaRing,
  },
  panel: {
    viewport: result.panel.viewport,
    metrics: result.panel.metrics,
    taskList: result.panel.taskList,
    phases: result.panel.phases,
    statusOrderValid: result.panel.statusOrderValid,
    overflow: result.panel.overflow,
  },
  settings: result.settings,
  menuTransport: result.menuTransport,
  notification: result.notification,
  screenshots: result.screenshots,
}, null, 2));

try {
  await panel.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: panelDetails.viewport.width - 2,
    y: panelDetails.viewport.height - 2,
  });
} catch {
  // The explicit menu-bar toggle validation can intentionally close the
  // original panel target before this final mouse-leave cleanup.
}
panel.socket.close();
dot.socket.close();
settingsPage.socket.close();
notification?.socket.close();
await delay(50);
process.exit(0);
