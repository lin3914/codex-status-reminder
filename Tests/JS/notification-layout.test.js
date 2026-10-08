"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/notification.html"),
  "utf8"
);
const css = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/notification.css"),
  "utf8"
);
const main = fs.readFileSync(path.join(root, "ElectronApp/main.js"), "utf8");
const completion = fs.readFileSync(
  path.join(root, "ElectronApp/completion-notifications.js"),
  "utf8"
);

assert(html.includes("completion-notification-titlebar"));
assert(html.includes("completion-notification-icon"));
assert(html.includes("completion-notification-body"));
assert(html.includes("completion-notification-close"));
assert(html.includes("completion-notification-group"));
assert(html.includes("completion-notification-stack-layer"));
assert(html.includes("completion-notification-more"));
assert(html.includes("completion-notification-expanded"));
assert(html.includes("completion-notification-list"));
assert.match(
  html,
  /event\.stopPropagation\(\)[\s\S]*?companionNotification\.close\(item\.threadID\)/,
  "关闭按钮不得触发打开会话动作"
);
assert.match(
  html,
  /function bindOpen\(notification, item\)[\s\S]*?companionNotification\.open\(item\.threadID\)/,
  "收起卡片和展开列表必须共用打开对应 Codex 会话的行为",
);
assert.match(
  html,
  /function createExpandedRow\(item\)[\s\S]*?bindOpen\(row, item\)/,
  "展开列表中的每个任务都必须可直接打开对应会话",
);
assert.match(html, /const closeLabel = item\.closeLabel \|\| "关闭通知"/);
assert.match(css, /\.completion-notification-icon\s*\{[\s\S]*?width:\s*22px;/);
assert.match(css, /\.completion-notification-body\s*\{[\s\S]*?width:\s*100%;/);
assert.match(
  css,
  /\.completion-notification-stack\s*\{[\s\S]*?position:\s*relative;[\s\S]*?overflow:\s*visible;/,
  "通知容器应使用透明的组栈层，而不是滚动列表背景",
);
assert.match(
  css,
  /\.completion-notification-group\s*\{[\s\S]*?height:\s*calc\(104px\s*\+\s*var\(--stack-depth,\s*0px\)\);/,
  "收起态应仅露出两层轻量边缘，而非叠放完整瀑布流卡片",
);
assert.match(
  css,
  /\.completion-notification-stack-layer\s*\{[\s\S]*?top:\s*var\(--layer-y,\s*0px\);[\s\S]*?pointer-events:\s*none;/,
  "后层卡片只能作为视觉边缘，不能抢占前层任务交互",
);
assert.match(
  css,
  /\.completion-notification-list\s*\{[\s\S]*?overflow-y:\s*auto;/,
  "超过三条时必须在展开组内滚动，而不是继续拉长通知窗口",
);
assert.match(
  css,
  /\.completion-notification\s*\{[\s\S]*?box-shadow:\s*none;/,
  "卡片外层不应再绘制灰色遮罩阴影",
);
assert.match(
  css,
  /html,[\s\S]*?background:\s*transparent\s*!important;[\s\S]*?background-color:\s*transparent\s*!important;/,
  "通知窗口根层必须保持透明",
);
assert.match(
  css,
  /grid-template-columns:\s*22px\s+minmax\(0,\s*1fr\)\s+auto\s+22px/,
  "通知标题栏应保留图标、会话标题、展开数量和关闭按钮"
);
assert.match(
  css,
  /\.completion-notification-close\s*\{[\s\S]*?grid-column:\s*-2\s*\/\s*-1;/,
  "无论是否显示展开数量，关闭按钮都必须固定在标题栏最后一列"
);
assert.match(
  css,
  /\.completion-notification-close\s*\{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;[\s\S]*?background:\s*transparent;/,
  "关闭按钮应保留 22pt 命中区，但默认不绘制厚重底板"
);
assert.match(
  css,
  /\.completion-notification-close::before\s*\{[\s\S]*?inset:\s*1px;[\s\S]*?border-radius:\s*50%;/,
  "关闭按钮的视觉圆底应缩进到 20pt"
);
assert.match(
  css,
  /\.completion-notification-close-glyph\s*\{[\s\S]*?width:\s*10px;[\s\S]*?height:\s*10px;/,
  "关闭符号应使用接近 macOS 通知的轻量 10pt xmark"
);
assert.match(
  css,
  /\.completion-notification-close-glyph::before[\s\S]*?rotate\(45deg\)[\s\S]*?\.completion-notification-close-glyph::after[\s\S]*?rotate\(-45deg\)/,
  "关闭符号必须由同一圆心交叉的两条线段构成"
);
assert.doesNotMatch(css, /grid-template-columns:\s*(?:5[0-9]|6[0-9])px/);
assert.match(
  main,
  /const completionBannerEntries = new Map\(\)/,
  "通知必须按会话维护独立横幅"
);
assert.match(
  completion,
  /const retainedPending = prunePendingNotifications\(pending\)/,
  "完成通知必须保留持久待查看队列"
);
assert.doesNotMatch(
  main,
  /setTimeout\(\(\)\s*=>\s*closeCompletionBanner/,
  "完成通知不能再按固定时长自动关闭"
);
assert.match(
  main,
  /positionCompletionBanners\(\)/,
  "多个完成通知必须重新计算叠放位置"
);
assert.match(
  main,
  /const COMPLETION_BANNER_MAX_COLLAPSED_LAYERS = 2;/,
  "收起态最多只能展示两层背景边缘",
);
assert.match(
  main,
  /const COMPLETION_BANNER_MAX_VISIBLE_ROWS = 3;/,
  "展开态默认最多展示三条任务高度",
);
assert.match(
  main,
  /const COMPLETION_BANNER_EXPANDED_HEADER_HEIGHT = 56;/,
  "展开高度必须计入内边距、边框、标题和间隔，不能裁切第三条通知",
);
assert.match(
  main,
  /function completionBannerLayout\(entryCount\)/,
  "主进程必须根据展开态重新计算透明通知窗口高度",
);
assert.match(
  main,
  /--show-notification-preview-group/,
  "需要保留隔离的四任务预览入口，以便真实验证组栈和内部滚动",
);
assert.match(
  main,
  /function completionEntryTimestamp\(entry\)/,
  "通知排序必须读取完成时间",
);
assert.match(
  main,
  /sortCompletionEntries\(completionBannerEntries\.values\(\)\)/,
  "最新完成的通知必须位于最前面",
);
assert.match(
  main,
  /setBackgroundColor\("#00000000"\)/,
  "通知窗口必须清除原生背景色",
);
assert.match(
  main,
  /setHasShadow\(false\)/,
  "通知窗口不得保留原生灰色阴影",
);
assert.match(
  main,
  /message\?\.type === "close"[\s\S]*?dismissCompletionBanner\(message\.threadID\)/,
  "关闭按钮必须通过主进程关闭对应横幅"
);
assert.match(
  main,
  /message\?\.type === "toggle-expanded"[\s\S]*?completionBannerExpanded = !completionBannerExpanded;/,
  "点击 +N 必须在同一通知窗口内切换完整任务列表",
);
assert.match(
  main,
  /closeLabel:\s*effectiveLocale\(\) === "en"\s*\?\s*"Close notification"\s*:\s*"关闭通知"/,
  "关闭按钮标签必须跟随应用的有效语言（包括系统语言）"
);
assert.match(
  fs.readFileSync(path.join(root, "ElectronApp/preload-notification.js"), "utf8"),
  /toggleExpanded\(\)[\s\S]*?type: "toggle-expanded"/,
  "安全 preload 必须只暴露展开组所需的窄 IPC 能力",
);

console.log("PASS notification-layout");
