# @suntion/dsh-tool-gate

仓库：<https://github.com/SunYanbox/DSHToolGate>

会话级的「按插件工具门控」插件（DeepSeek Harness 0.2.x）。

会话开始时弹出选择面板：列出**所有已启用、且会注册工具**的插件，每个插件一个标签（悬停显示它会注册哪些工具）。
被关掉的插件，其工具在**这个会话内**始终不会注入模型上下文，强行调用也会被拒绝；其它会话完全不受影响。

## 功能

- **按插件归因（静态扫描）**：读取 profile 的 `dsh.profile.bundles` 与每个包的 `cordis.patch.yml`，得到「loader 行 → 它 mount 的包 → 该包源码里 `tools.register({ name: '…' })` 的字面量」，再与运行时 `ctx.tools.schemas()` 求交集。不依赖插件加载顺序（插件作为 bundle 最后加载时也能正确归属宿主工具），宿主内置工具从 `resources/app.asar` 里读。归因结果只在内存里，不落盘。
  - 行名就是标签（如 `tool-browser`、`billion-context`），浏览器工具归到 `tool-browser` 而不是笼统一个桶。
  - 子路径行（`…/list-agents`）只认它自己 mount 的那个模块，不会把同包兄弟模块的工具算进来；名字写在常量里（`name: EXIT_PLAN_MODE`）或由行配置指定（`toolName: subagent_fork`）的也能解析。
  - 一个工具名只归一个标签：行的 `toolName` 配置优先，其次后声明的具体行先认领（`tool-browser` 胜于根行 `dsh-builtin-browser`）。
  - 预设文件只扫**当前启用的那个**（读 `agent-preset-registry` 的 `selectedDefault`）。像 `coding` 这种不随 web-app 发布预设文件的模式，roster 由 bundle 补丁声明：改为只认**挂在隔离 group 下的行**（如 `planning` group 里的 `plan-mode`），其它预设文件整体跳过。
  - 无法从源码拿到名字的工具（MCP 透传、运行时拼出来的名字）按**来源插件的根文件夹**再找一次：在本地已安装的插件包里搜该名字字面量，命中即归到该包名下（例如 billion-context 的 `compress` / `acp_status`）。仍未命中的才进 `（未识别）`。
- **会话开始弹窗**：新会话首个界面即出现面板（可在插件配置里用 `askOnSessionStart: false` 关闭）。标签 = 插件行名，悬停显示工具名列表，`✓` 启用 / `✕` 禁用，另有「全部启用 / 全部禁用」「应用」「稍后再说」。
  - 预设/官方内置工具（`@deepseek-ai/dsh-tool-*`，例如 `tool-fs`、`tool-bash`、`tool-subagent`）标记「待会话」：它们挂在会话的 agent scope 上，用虚线标签提前列出，第一条消息发出后按当前预设生效。所以官方内置插件的工具同样可以勾选/禁掉。
  - **官方内置插件默认折叠**：`@deepseek-ai/*` 的插件行收进「官方内置插件 · N 个」一行，点一下展开/收起，避免几十个内置标签挤满面板；第三方插件始终平铺显示。
  - **工具预览固定高度**：面板下方的浅色预览区始终占 132px 高、超出内部滚动，悬停不同插件时面板尺寸不变，不会抖动。
- **默认记忆**：应用时同时写入 profile 级默认，之后的会话直接沿用、不再自动弹窗；想改就点输入框左下角工具行里的「工具门控」。
- **会话内改配置要确认**：没发过消息的会话（草稿）随便改；已经发过消息的会话，若新选择与当前生效值有实际差异，服务端返回 `needs-confirmation`，面板先列出「将禁用 / 将重新启用」的插件，点「仍然应用」才落盘。
- **会话内生效**：选择保存在 `$DSH_HOME/tool-gate.json`（按 session id），并在 `agent/created` 时把两道闸门注册到该 agent 的 scoped ctx 上：
  - `system-prompt/assemble` 过滤掉被禁插件的工具 schema（模型看不到，也调用不了）；
  - `tools.guard()` 兜底：真被调用时返回 `tool-gate: tool is masked because its plugin was disabled for this session (<tool>)`。
  闸门随 agent 销毁自动卸载。
- **随时改**：输入框左下角工具行（`+` 按钮旁边）的「工具门控」按钮可重新打开面板，新会话、旧会话都能点到；面板显示当前关掉了几个插件。
- **无全局副作用**：不改插件加载状态、不重启、不影响其它会话；插件卸载后不留痕迹。

## 环境要求

- DeepSeek Harness 0.2.x。
- Node.js ≥ 18，见 `package.json` 的 `engines.node`；CI 在 18 / 20 / 22 / 24 上跑测试。桌面端插件实际运行在 DSH 内置的 Electron/Node 上，无需另装 Node；只有在源码里跑测试或用 `dsh` CLI 时才需要本机 Node。
- `engines` 只是元数据：npm 默认只在不匹配时给出 `EBADENGINE` 警告，不会阻止安装；要硬拦截需在消费侧开启 `engine-strict`。

## 安装

```powershell
dsh plugin --profile desktop add link:<本目录的绝对路径>
```

然后在 `$DSH_HOME/profiles/desktop/package.json`（`DSH_HOME` 默认是 `~/.dsh`）的 `dsh.profile.bundles` 末尾确认有 `@suntion/dsh-tool-gate`（`dsh plugin add` 会自动追加），重启 DSH 生效。

开发时可复制一份临时 profile 试用：

```powershell
dsh plugin --profile gate-test add link:<本目录的绝对路径>
dsh --profile gate-test --no-open --port 64001
```

## 配置（`cordis.patch.yml` 中该行的 `config`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `askOnSessionStart` | `true` | 新会话是否自动弹窗 |
| `file` | `$DSH_HOME/tool-gate.json` | 状态文件路径 |

状态文件结构：

```json
{
  "version": 1,
  "defaults": { "disabled": [], "updatedAt": "…" },
  "sessions": {
    "session-<uuid>": { "configured": true, "disabled": ["tool-browser", "billion-context"], "started": true, "updatedAt": "…" }
  }
}
```

`defaults` 是「不再反复弹窗」的默认值；`sessions.*.started` 记录该会话是否已经有 agent（发过消息），用于判断改配置是否需要二次确认。

## HTTP 接口（调试用）

`POST /tool-gate/api/state` body `{ sessionId }`；`POST /tool-gate/api/set` body `{ sessionId, disabled: string[], asDefault?, confirm? }`。

- `state` 返回 `{ ok: true, value: { sessionId, groups, choice, started, askOnSessionStart } }`；
- `set` 在「会话已开始且与当前值有差异、又没带 `confirm: true`」时返回 `409 { error: { code: "needs-confirmation", detail: { added, removed } } }`。

## 架构

```
lib/index.js     host 入口（name/inject/apply）
lib/registry.js  工具→插件归因（静态扫描 ∩ 运行时 schemas）
lib/scan/index.js  扫描 profile bundles / 包源码 / app.asar，得到 行→工具名
lib/scan/asar.js   只读 ASAR 解析（宿主内置插件源码在 app.asar 里）
lib/scan/patches.js cordis.patch.yml 行解析
lib/policy.js    agent/created → scoped assemble 过滤 + tools.guard
lib/store.js     $DSH_HOME/tool-gate.json 的读写（tmp+rename）
lib/gateway.js   webServer 路由 /tool-gate/api
lib/client.js    手写 __ModuleLoader__ bundle：会话开始弹窗 + 右上角按钮
```

## 验证

```powershell
node test/smoke.mjs        # 归因 / 门控 / 持久化（假 ctx）
node test/client-smoke.mjs # 客户端 bundle 的 slot 注册
```

端到端（真实 DSH web + 本地假模型 `test/fake-model.cjs`，Electron 驱动）：

- 会话 A：弹窗里关掉「（内置/先加载）」→ 发给模型的工具列表 30 个（不含 `working_directory`）→ 模型硬调该工具 → UI 显示 `Error: tool-gate: tool is masked because its plugin was disabled for this session (working_directory)`。
- 会话 B：弹窗选「稍后再说」→ 工具列表 31 个（含 `working_directory`）→ 调用正常执行。

## 发布

发布由 `.github/workflows/release.yml` 处理。发布 `vX.Y.Z` 格式的 GitHub Release 后，工作流会：

1. 校验 Release tag 与 `package.json` 的 `version` 一致；
2. 查询 npm registry，确认 `@suntion/dsh-tool-gate@X.Y.Z` 尚未发布；
3. 运行测试，用 `pnpm pack` 生成 tarball，再用 `npm publish` 发布到 npm（`pnpm` 与 `npm` 共用同一个 registry，不需要分别发布）。

发布到 npm 后工作流即结束，不再轮询 registry 做二次确认：`npm publish` 返回 0 就代表 tarball 已被接收，而 npm 会对新版本做自动审核，审核完成前 registry 一直对该版本返回 404（npm 网站上状态显示为「验证」，实测需要几分钟）。想看结果直接打开 `https://www.npmjs.com/package/@suntion/dsh-tool-gate`。

首次使用前，在仓库 **Settings → Secrets and variables → Actions** 中添加 `NPM_TOKEN`，token 需要拥有该包的发布权限。工作流也支持手动触发：填写已有的 Release tag 即可重试。
