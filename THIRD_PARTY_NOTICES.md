# 第三方代码与资源

## 发行包中的 runtime

Electron 按 MIT 许可提供；其 Chromium、Node.js 等组成部分分别受各自许可约束。构建保留匹配版本分发包中的完整 `LICENSE` 和 `LICENSES.chromium.html`，安装后可在应用包 `Contents/Resources/licenses` 查看。本目录 `licenses` 同步保留用于源码审阅的 runtime 通知。

构建只从锁定的 Electron 官方分发包开始，不提取或分发 Flux Island 的应用包、私有 node_modules、账号内容或品牌素材。

## 构建依赖

构建依赖和传递依赖由 package-lock.json 锁定。完整版本、许可证元数据和 dev-only 范围见 `licenses/build-dependencies.json`；该清单不取代依赖各自的完整许可。node_modules 不作为项目源码提交，安装通过 npm 获取。

## 项目原创代码与图标

项目原创代码与可授权图标采用 Apache-2.0；维护者已确认代码原创及图标公开权利，完整条款见 LICENSE。应用使用独立设计的图标，不使用 OpenAI 官方结标或 Flux Island 吉祥物。

早期实现曾以 Flux Island 的本机修改版本为参考。当前资源已经多轮重写，原始应用包、私有依赖和品牌素材不作为本项目分发。对后续新增的第三方资源，仍须分别确认许可与归属；不能用其他应用的包元数据替代授权。

本应用不受 OpenAI 认可或背书；产品名称中的 Codex 仅说明适配对象。开源许可不能替代商标或雇佣成果的权利确认。
