# 开发与贡献

先通过 Issue 讨论影响任务状态、未读同步、用量协议或菜单栏生命周期的大改动。界面优化应保留已确认的功能与行为。不要在用户电脑上使用系统私有偏好写入来补偿应用错误。

## 准备

- macOS，Xcode Command Line Tools，Swift 6+。
- Node.js 22；`.nvmrc` 用于版本选择。构建依赖由 package-lock.json 固定。
- 项目 `.npmrc` 与 lockfile 使用公共 npm 源，不依赖开发者的公司镜像；版本和 tarball 完整性校验均保留。
- ripgrep（`rg`）。若已使用 Homebrew，可通过 `brew install ripgrep` 安装；普通用户不需要这些开发工具。

```sh
npm ci
npm test
npm run audit:public
npm run audit:dependencies
npm run build
npm run check:release
npm run test:renderer
npm run test:notifications
```

默认测试使用固定样本，未安装／未登录 Codex 也能运行。`test:notifications` 在临时配置中模拟任务，验证打包后的前台查询、完成判断、真实提醒窗口及关闭 IPC；不读写 Codex，也不改系统通知权限。为确定前台状态，它会短暂激活自己的测试窗口。只有选择 `npm run test:live` 才读取你本机 Codex 的真实状态并调用额度协议；测试输出可能涉及状态，提交前脱敏。

构建不借用已安装的本应用、Flux Island 或个人 npm 缓存里的其他 runtime。它只使用与锁定依赖版本、架构匹配的 Electron 分发包，必要时通过 @electron/get 下载并核验校验值。生成应用携带 Electron／Chromium 许可。

产物、暂存与发布输出必须在当前 checkout 的 `.build` 子目录内，不能指向应用程序、家目录或仓库根。开发者覆盖输出路径仍受该约束。`scripts/install-app.sh` 是历史本地迁移工具，默认直接拒绝运行；只有开发者明确设置 CODEX_COMPANION_ALLOW_DEVELOPMENT_INSTALL=1 才会替换本机安装版并处理本产品旧身份，不作为普通测试或公开安装入口。普通用户按 Finder 拖拽安装方式操作。

## 结构

实际应用入口是 `ElectronApp/main.js`；`Resources/LegacyV11` 只是保留的资源目录名称，不依赖安装 Flux Island。NativeRecovery 是本应用的有限恢复 helper。

`Sources` 中部分 Swift 读取／模型代码用于兼容测试和预览；`NativeMenuBar` 以及旧 Swift UI 不作为发行版第二个宿主打包。它们保留用于现有回归，不能据此注册另一个同名应用。

## PR 检查

提供原因、范围、测试与未验证边界。任务／额度／图标／通知改动应有对应固定样本；安装、菜单栏、空间、睡眠唤醒或速度改动需补实机记录。禁止提交真实数据、截图中的私人会话、证书、环境秘密和生成的应用包。

贡献者必须有权提交自己的代码和素材。贡献遵循仓库 Apache-2.0 许可，并保留第三方归属。

## 发行

源码准备、源码公开、正式下载是三个不同的验收阶段。见[发行流程](docs/RELEASING.md)。本仓库不会因推送一个 tag 自动发布可下载的正式包。
