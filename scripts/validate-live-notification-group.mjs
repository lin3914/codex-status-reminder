import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.COMPANION_DEBUG_PORT || 9338);
const baseURL = `http://127.0.0.1:${port}`;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const outputDir = path.join(projectDir, "dist");

const delay = (milliseconds) => new Promise(
  (resolve) => setTimeout(resolve, milliseconds),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function listTargets() {
  const response = await fetch(`${baseURL}/json/list`);
  if (!response.ok) {
    throw new Error(`CDP target list failed: HTTP ${response.status}`);
  }
  return response.json();
}

async function waitForNotificationTarget(timeoutMilliseconds = 12_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const target = (await listTargets()).find(
        (item) => item.url.includes("notification.html"),
      );
      if (target) return target;
    } catch {
    }
    await delay(100);
  }
  throw new Error("CDP notification target not found");
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextID = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });

  const send = (method, params = {}) => {
    const id = nextID++;
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

  await send("Runtime.enable");
  await send("Page.enable");
  return { socket, send, evaluate };
}

async function screenshot(connection, filename) {
  const result = await connection.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
  });
  const output = path.join(outputDir, filename);
  await fs.writeFile(output, Buffer.from(result.data, "base64"));
  return output;
}

await fs.mkdir(outputDir, { recursive: true });
const target = await waitForNotificationTarget();
const notification = await connect(target);
await delay(320);

const collapsed = await notification.evaluate(`(() => {
  const card = document.querySelector(".completion-notification");
  const icon = document.querySelector(".completion-notification-icon");
  const close = document.querySelector(".completion-notification-close");
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    group: Boolean(document.querySelector(".completion-notification-group")),
    cardCount: document.querySelectorAll(".completion-notification").length,
    rearLayerCount: document.querySelectorAll(".completion-notification-stack-layer").length,
    more: document.querySelector(".completion-notification-more")?.innerText || "",
    card: card?.getBoundingClientRect().toJSON() || null,
    icon: icon?.getBoundingClientRect().toJSON() || null,
    close: close ? {
      rect: close.getBoundingClientRect().toJSON(),
      ariaLabel: close.getAttribute("aria-label"),
    } : null,
    rootBackground: getComputedStyle(document.documentElement).backgroundColor,
  };
})()`);

assert(collapsed.group, "多任务提醒没有使用方案 A 的原生组栈收起态");
assert(collapsed.cardCount === 1, "收起态不能叠放多张完整通知卡片");
assert(collapsed.rearLayerCount === 2, "收起态必须保留两层轻量边缘");
assert(collapsed.more === "+3", "收起态没有展示其余提醒数量");
assert(
  collapsed.rootBackground === "rgba(0, 0, 0, 0)",
  "通知窗口根层没有保持透明，四角可能再次出现灰色遮罩",
);
assert(collapsed.card?.height === 104, "收起态前卡高度不是 104px");
assert(
  collapsed.icon?.width === 22 && collapsed.icon?.height === 22,
  "通知图标没有保持 22px 标题栏尺寸",
);
assert(
  collapsed.close?.rect?.width === 22
    && collapsed.close?.rect?.height === 22
    && collapsed.close?.ariaLabel === "关闭通知",
  "收起态缺少可访问的 22px 单条关闭按钮",
);
assert(
  Math.abs(collapsed.card.right - collapsed.close.rect.right - 15) < 1,
  "收起态关闭按钮没有固定在卡片右侧 14px 内边距加 1px 描边内",
);

const collapsedScreenshot = await screenshot(
  notification,
  "live-electron-notification-group-collapsed.png",
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
    rowTitles: [...document.querySelectorAll(".completion-notification-row-title")]
      .map((element) => element.innerText),
    listClientHeight: list?.clientHeight || 0,
    listScrollHeight: list?.scrollHeight || 0,
    collapseLabel: document.querySelector(".completion-notification-collapse")?.innerText || "",
    listScrollbarWidth: list ? getComputedStyle(list).scrollbarWidth : null,
  };
})()`);

assert(expanded.panel, "点击 +N 后没有展开方案 A 任务组");
assert(expanded.rowCount === 4, "展开态没有保留全部待查看任务");
assert(expanded.collapseLabel === "收起通知", "展开态缺少收起操作");
assert(
  expanded.listScrollHeight > expanded.listClientHeight,
  "超过三条任务时展开组没有使用内部滚动",
);
assert(
  expanded.rowTitles[0] === "完善预算健康度说明",
  "展开列表没有把最新完成任务保持在最前",
);

const expandedScreenshot = await screenshot(
  notification,
  "live-electron-notification-group-expanded.png",
);

await notification.evaluate(`(() => {
  document.querySelector('[data-thread-id="preview-group-4"] .completion-notification-close')?.click();
  return true;
})()`);
await delay(220);
const afterClose = await notification.evaluate(`(() => ({
  rowCount: document.querySelectorAll(".completion-notification-row").length,
  retainedFirstTitle: document.querySelector(".completion-notification-row-title")?.innerText || "",
}))()`);
assert(afterClose.rowCount === 3, "关闭按钮没有只移除当前提醒");
assert(
  afterClose.retainedFirstTitle === "完善预算健康度说明",
  "关闭较早提醒不应影响最新提醒排序",
);

const result = {
  passed: true,
  collapsed,
  expanded,
  afterClose,
  screenshots: { collapsed: collapsedScreenshot, expanded: expandedScreenshot },
};
await fs.writeFile(
  path.join(outputDir, "live-electron-notification-group-validation.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
notification.socket.close();
