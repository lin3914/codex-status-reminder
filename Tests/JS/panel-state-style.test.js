"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const main = fs.readFileSync(path.join(root, "ElectronApp/main.js"), "utf8");
const panel = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/panel.html"),
  "utf8"
);
const css = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/pet-panel.css"),
  "utf8"
);
const dot = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/dot.html"),
  "utf8"
);
const dotCSS = fs.readFileSync(
  path.join(root, "Resources/LegacyV11/pet-status-dot.css"),
  "utf8"
);

assert.match(main, /completed:\s*"Processed"/);
assert.match(main, /completed:\s*"已处理"/);
assert.match(panel, /completed:\s*"已处理"/);
assert.match(
  css,
  /\.status-task-metric\.is-unread\s*\{[\s\S]*?color:\s*#76e3aa;[\s\S]*?background:\s*rgba\(105,\s*238,\s*174,\s*0\.12\)/,
  "待查看汇总必须使用绿色"
);
assert.match(
  css,
  /\.status-task-metric\.is-running\s*\{[\s\S]*?color:\s*#ead47f;[\s\S]*?background:\s*rgba\(239,\s*217,\s*124,\s*0\.12\)/,
  "进行中汇总必须使用浅黄色"
);
assert.match(
  css,
  /\.status-task-phase\.is-unread\s*\{[\s\S]*?color:\s*#76e3aa;[\s\S]*?background:\s*rgba\(105,\s*238,\s*174,\s*0\.12\)/,
  "待查看状态标识必须使用绿色"
);
assert.match(
  css,
  /\.status-task-phase\.is-running\s*\{[\s\S]*?color:\s*#ead47f;[\s\S]*?background:\s*rgba\(239,\s*217,\s*124,\s*0\.12\)/,
  "进行中状态标识必须使用浅黄色"
);
assert.match(
  css,
  /\.status-task-phase\.is-completed\s*\{[\s\S]*?color:\s*#b7c9d2;/,
  "已处理状态标识必须保留灰色色阶"
);
assert.match(dot, /class="status-dot-ring-track is-quota"[^>]*r="15\.5"/);
assert.match(dot, /class="status-dot-center"[^>]*r="13\.75"/);
assert(
  dot.indexOf('class="status-dot-ring-track is-quota"')
    < dot.indexOf('class="status-dot-ring-track is-time"'),
  "内环轨道必须先绘制，让外环覆盖共享边缘"
);
assert.match(
  dot,
  /track:\s*"--ring-track"/,
  "健康度变化必须只改变额度进度色，不能重新引入分离的浅色轨道"
);
assert.match(
  dotCSS,
  /--ring-track:\s*#a5dfe4/,
  "双环必须使用统一的连续轨道色"
);
assert.match(
  dotCSS,
  /\.status-dot-ring-track\.is-quota\s*\{[\s\S]*?stroke:\s*var\(--ring-track\)/,
  "额度轨道必须使用共享轨道色"
);
assert.match(
  dotCSS,
  /\.status-dot-ring-track\.is-time\s*\{[\s\S]*?stroke:\s*var\(--ring-track\)/,
  "时间轨道必须使用共享轨道色"
);

console.log("PASS panel-state-style");
