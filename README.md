# FreeRoute for Android

把 [dsh-freeroute](https://github.com/dushaobindoudou/dsh-freeroute)（DeepSeek Harness 插件）
脱壳成可**后台常驻**的 Android 应用，界面仿照
[CLIProxyAPI](https://github.com/liaoyh9422-creator/CLIProxyAPI)。

## 结构

```
engine/     脱壳后的引擎（Node ESM，无外部二进制依赖）
webui/      内置 Web UI（5 个底部标签，深色极客风）
android/    Android 宿主（WebView + 前台服务 + nodejs-mobile 运行时）
.github/    GitHub Actions：构建 APK
```

## 关键设计

**引擎自包含。** 原插件通过 `child_process.spawn` 调用 `curl` 做全部 HTTP 通信。
Android 10+ 禁止从应用数据目录执行文件（W^X），因此 `engine/shim.js` 的
`subprocess` 服务用纯 Node（`node:http`/`https`/`tls`/`zlib`）**模拟 curl**——
解析同样的 argv，复现流式语义、`-L` 重定向、`--proxy` CONNECT 隧道、
`--speed-time` 读空闲超时、`--max-time` 绝对上限与 `-w` 尾部状态码。
APK 内不需要打包任何可执行文件。

**宿主服务脱壳。** 原插件依赖 7 个 dsh 宿主服务；`shim.js` 提供了本地实现：
`llm` / `timer` / `settings` / `credentials` / `subprocess` / `webServer` /
`commands` / `agentDefaultModel`，以及 `ctx`（含直接属性访问 `ctx.llm`、`ctx.timer`）。
配置与密钥落在应用私有目录（`files/home/.freeroute`、`files/home/.dsh`）。

**常驻后台。** `EngineService` 是前台服务（`START_STICKY` + `PARTIAL_WAKE_LOCK`），
把 Node 运行时以共享库形式加载进本进程（不 exec 外部二进制），
引擎退出时按指数退避重启（最多 5 次）。Activity 销毁后 API 端点持续可用。

## 端点

引擎监听 `127.0.0.1:8787`（`FREEROUTE_PORT` 可覆盖）：

| 路径 | 用途 |
|---|---|
| `/freeroute/v1/models` | OpenAI 兼容模型列表 |
| `/freeroute/v1/chat/completions` | OpenAI 兼容对话（SSE 流式 + 非流式） |
| `/freeroute/health` | 健康检查 |
| `/freeroute/rpc` | Web UI 的 `{method,args}` JSON-RPC |
| `/freeroute/app/` | 内置 Web UI |

## 构建

推送到 GitHub 后由 Actions 自动构建（见 `.github/workflows/build.yml`）：
校验引擎 → 下载 nodejs-mobile 运行时 → Gradle 打包 → 上传 APK。
打 `v*` 标签时自动附加到 Release。

## 本地验证引擎

```bash
cd engine
node sync-assets.mjs   # 汇入 Android assets
node test.mjs          # 端到端自检
```
