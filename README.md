# CodeX状态提醒

<img src="Resources/AppIcon/AppIcon-1024.png" width="96" alt="CodeX状态提醒应用图标">

在 Mac 菜单栏和桌面圆点里查看 Codex 的周额度、重置时间和最近任务。任务完成后，可以收到持续保留的提醒卡片；点击提醒会撤下该卡片并请求打开会话，直接在 Codex 查看后也会依已读同步撤下。手动关闭不改变会话未读状态。

这是独立的第三方应用，不是 OpenAI 官方产品，不隶属于 OpenAI，也不代表其背书。普通用户不需要另外安装 Electron、Node.js 或 Python。

> 本项目采用 Apache-2.0，代码与图标的公开权利已由维护者确认。当前源码版本为 1.9.13（64），尚无面向普通用户的已签名、公证安装包；请勿把本地 ad-hoc 测试包当作正式发行版。

已知兼容缺陷：未读状态单独读取失败时，停止任务可能误显示为“已处理”。正式安装包发布前必须修复；详见[功能边界](docs/FUNCTIONAL_SPEC.md#已知界限)。

[English](README.en.md) · [使用说明](docs/USER_GUIDE.md) · [功能与边界](docs/FUNCTIONAL_SPEC.md) · [隐私](PRIVACY.md) · [开发与测试](CONTRIBUTING.md)

<img src="Resources/Documentation/panel.png" width="420" alt="额度与任务面板：使用虚构任务和演示数据的真实界面">

## 它能做什么

- 看周额度：菜单栏可以直接显示剩余百分比；关闭数字时恢复完整图标。
- 看任务：菜单栏左键展开完整任务卡片，右键打开配置菜单，悬停不弹窗。
- 看提醒：已停止且未查看的任务标为绿色“待查看”；真正运行中的任务为浅黄色“进行中”；已查看且停止的任务为灰色“已处理”。
- 看使用节奏：比较额度消耗和时间进度，默认超前不超过 12 小时为正常使用，超前达到 24 小时进入额度告警。提醒线可调整。
- 自动连接：优先自动发现 Codex 的程序和数据目录，多次失败后才提供手动选择；不修改 Codex 数据。
- 保持轻量交互：任务卡片预先准备并复用，内容变化才更新；异常退出有有限次数的恢复，用户主动退出不重启。

## 下载与安装

正式发行后，安装包将放在本仓库的 Releases 页面。首个面向普通用户的包计划先提供 Apple Silicon 预发布版，Intel 包在独立验证后提供。

1. 先安装 Codex 并正常登录使用。
2. 下载与你的处理器匹配、已签名和公证的 ZIP，解压后把 `CodeX状态提醒.app` 拖入“应用程序”。
3. 在“应用程序”里打开应用。默认直接进入设置，自动连接 Codex；菜单栏入口始终保留，不显示运行中的 Dock 图标。

不要关闭 Gatekeeper、执行去隔离命令，或对应用授予它不需要的系统权限。安装与故障处理见[使用说明](docs/USER_GUIDE.md)。

## 系统与兼容性

应用元数据保留现有 macOS 12.0 最低版本声明；这不等于已经在所有 macOS 12+ 设备上通过实机验证。候选 CI 计划覆盖 macOS 14 / 26、Apple Silicon 与 Intel 构建。macOS 12 / 13、其他设备、真实下载隔离和登录启动仍需发布前验证。

用量优先来自 Codex app-server 的公开方法；桌面任务和未读状态仍使用只读兼容层。Codex 版本变化、第三方模型、API Key 登录或没有周额度的账户，都可能造成部分信息不可用。不可用不是额度为零。详见[兼容性说明](docs/COMPATIBILITY.md)。

## 从源码运行

需要 macOS、Node.js 22、Xcode Command Line Tools（Swift 6+）和 ripgrep。这里的工具只给开发者使用，普通用户无需安装。

```sh
npm ci
npm test
npm run audit:public
npm run build
npm run check:release
```

产物：`.build/products/CodeX状态提醒.app`。该产物为开发测试版，不能用来证明正式下载的签名与公证已经通过。测试默认不读你的 Codex 账户；真实只读验证需自行运行 `npm run test:live`。

## 许可与反馈

原创代码与可授权图标采用 [Apache-2.0](LICENSE)，保留 Electron / Chromium 等第三方许可。源码公开不代表正式安装包已经发布；二进制仍需单独完成签名、公证和实机验收。[第三方许可说明](THIRD_PARTY_NOTICES.md)。

报告普通问题时，请提供应用、macOS、Codex 版本和脱敏复现步骤；不要上传账号令牌、数据库或完整会话。安全漏洞按 [SECURITY.md](SECURITY.md) 私密报告。
