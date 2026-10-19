# 发行流程

## 当前发布：1.9.15（66）公开试用包

维护者已明确批准发布本轮验证通过的原始 Apple Silicon DMG 和 ZIP。发布内容是 **ad-hoc 签名、未公证试用包**，不是下文的 Developer ID 正式发行流程；不运行签名工作流，不把 `binaryPublicationApproved` 改为 true 来暗示正式发行门禁已通过。

1. 提交并审阅 1.9.15 源码、说明和版本清单，完成分支保护要求的 CI 检查。
2. 将通过检查的版本合入 main，以对应提交创建 `v1.9.15` 标签；标签与已公开资产不覆盖或重用。
3. 创建 Draft Release，逐个上传[版本清单](releases/v1.9.15.json)指定的原始安装包、SHA256SUMS 和清单，不重新构建或修改包内文件。
4. 核对资产大小和 SHA-256；公开后通过不带登录凭据的下载链接回下载复核，确认与本地已安装验证的文件完全一致。
5. 将它设为 GitHub 最新发布，同时在中英文 README 和使用说明列出直接下载、首次打开限制与保留配置的更新方法。

试用发布不改变正式包的签名、公证、跨设备验收要求。后续如需更换二进制内容，应递增版本和构建号、重新验证，不能覆盖本版文件。原始镜像内说明保留构建时的发布状态，当前 GitHub 发布状态以 Release 页面为准。

## 第一道门：权利与源码

确认代码、图标和继承资源可再分发后，选择许可，加入完整 LICENSE，同步 package.json／package-lock.json 的许可字段与归属，更新 publication-policy.json 的源码批准项及审阅状态。运行 `npm run check:publication` 必须通过。

这个文件只是流程的防错检查，不能替代真实授权。没有权利依据时保持 false，不通过勾选字段假装拿到授权。

公开仓库已确定为个人账户 `lin3914/codex-status-reminder`，许可为 Apache-2.0，维护者已确认代码与图标的公开权利。首次只提交审阅后的独立源码，不带历史聊天和原始工作目录。启用私密漏洞报告、依赖告警与 main 分支保护，让候选 CI 在干净 runner 中实际通过。未运行的 workflow 不能算已验证。

## 第二道门：普通用户下载

未读单独读取失败时误显示为已处理的历史问题，已由 1.9.14 改为“待同步”／未知数量，并纳入失败恢复回归。正式二进制发行前仍需完成目标系统和真实 Codex 验收；固定样本通过、签名与公证都不能替代该验收。参见[兼容性](COMPATIBILITY.md)。

需要 Apple Developer 账户、Developer ID Application 证书、团队身份和公证凭据。本机 ad-hoc 签名不能替代 Developer ID。

证书与密码直接放入 GitHub `release` environment 的 Secrets，不提交文件、不写入聊天、不放进普通 Issue。先配置 environment 审批与 tag 限制，再添加 Secrets。签名、公证和凭据保存使用同一个临时 keychain，由 CODEX_COMPANION_KEYCHAIN 指定；任何退出路径都清理证书。

所需 Secrets：`MACOS_SIGN_IDENTITY`、`MACOS_CERTIFICATE_BASE64`、`MACOS_CERTIFICATE_PASSWORD`、`MACOS_KEYCHAIN_PASSWORD`、`APPLE_ID`、`APPLE_APP_PASSWORD`、`APPLE_TEAM_ID`。也可以改用 Apple 官方支持的 App Store Connect API key 公证方式；需单独接线和验证，不能仅改变量名。

发行前运行 `npm run check:electron-support`，从 Electron 官方发布索引检查支持线和本大版本的最新补丁；网络失败或补丁过期时阻止二进制发行。候选将基线 43.4.1 更新到 2026-10-08 查询的同线最新补丁 43.7.9，不跨大版本。不能靠“major ≥ 43”的静态判断永久宣称受支持，也不能把 npm audit 没发现漏洞当作 Chromium 已没有漏洞的证明。

1. 完成 [实机验收清单](QA_CHECKLIST.md)，批准 binaryPublicationApproved。
2. 为完成回归的提交创建版本 tag。当前源码版本为 1.9.15（66），增加打开 Codex 撤回全部提醒、标准浮动层级与不重复抬高窗口，并保留完成提醒的故障恢复；递增 patch 与 build，避免同版本对应不同产物。
3. 手动运行 “Prepare signed macOS draft”，选择已审阅 tag。默认只生成 arm64 包；Intel 完成真实设备测试后才选择双架构。
4. 工作流运行测试、许可／源码检查，导入证书，构建、签名、公证、staple、Gatekeeper 校验，生成 SHA256SUMS。
5. 仅创建 Draft + Prerelease。不自动公开、不覆盖旧资产。
6. 真实浏览器下载候选包，在另一台 Mac 保留隔离属性完成安装、登录启动、菜单栏／全部功能验收，再人工发布 draft。

Gatekeeper 校验通过、公证通过、签名有效是不同证据；它们也不等于所有功能正确。

## 本地命令

```sh
npm ci
npm test
npm run audit:public
npm run audit:dependencies
npm run check:publication
# Apple 凭据只保存在自己的安全位置或 keychain 中：
npm run package:macos
```

默认 distribution 缺授权／签名／公证配置时直接失败。仅开发本地验证可用：

```sh
CODEX_COMPANION_RELEASE_MODE=development CODEX_COMPANION_RELEASE_ARCHS=arm64 npm run package:macos
```

开发 ZIP 不冒充签名公证正式包。维护者明确批准公开试用时，按上面的独立试用流程记录版本、哈希和限制；正式发行仍执行签名工作流。应用自带的许可位于 Contents/Resources/licenses。普通用户采用拖拽安装，不要求 Terminal、管理员脚本或关闭安全机制。

## 不在首发范围

自动更新、Mac App Store、Homebrew cask、遥测、自建云服务、Intel 与全系统版本“保证兼容”都不是首发的前提。前两项如果后续引入，会增加签名、权限和发布链路，不能假定已经具备。
