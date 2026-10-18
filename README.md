# MAGI 议会评审

MAGI Review 是运行在 DeepSeek Harness（DSH）中的议会式代码评审系统：多席独立陈词 → 匿名讨论 → 秘密表决 → 规则裁决 → 揭示 → 纪要（MAGI council）。

每席从不同视角核查同一份冻结差异；规则决定裁决，书记官只记录共识、争议与少数派意见。V1 仅审查代码变更，按需调用，不自动修改代码，也不充当提交门禁。

## 安装与兼容

当前版本 **0.1.0**，对接并验证的 DSH 版本为 **0.2.1-rc.2**。本仓库根目录就是 bundle，包名 `@local/dsh-magi-review`，无需构建、无需安装 npm 包。纯 ESM，零运行时依赖，不 import DSH 包；Host 通过注入的服务接入 DSH，Client 使用宿主模块加载器。

在 DSH **desktop profile** 的 Plugins 页面选择本地目录安装，目标为仓库绝对路径。也可在该 profile 中调用 `plugin_manager`：

```json
{
  "action": "install_bundle",
  "target": "C:\\Users\\mail\\Documents\\Github\\magi-review"
}
```

安装后按 DSH 提示重载，检查 `magi_review` 工具及 `/magi-review` 命令。模型 provider、凭据和父会话权限沿用 DSH 配置。本地目录安装链接 checkout；`package.json.files` 为打包预留，包含 README 与 docs。调试工具 `magi_ping` 已退役，`debug.selftest` 仅保留配置兼容键。

## 使用

### 工具 `magi_review`

| 参数 | 类型 / 默认值 | 含义 |
|---|---|---|
| `mode` | `quick` / `council`；默认 `council` | quick 只做独立陈词与最终投票，无讨论、脚本或纪要；council 为完整议会流程。 |
| `target` | `auto` / `turn` / `working-tree` / `staged` / `base-ref` / `patch`；默认 `auto` | 选择被冻结的差异来源。 |
| `base` | string；未设置 | `base-ref` 的 Git 引用；`auto` 带 base 时选择 `base-ref`。 |
| `paths` | string[]；未设置 | 按路径限定文件；当前相对原快照计算覆盖率，排除其他文件可能产生 partial，不能因此 approve。 |
| `patch` | string；未设置 | `target=patch` 时必填，直接传 unified diff 文本；不是文件路径。 |
| `seats` | `3` / `5` / `7`；默认 3 | 席位数；超出已配置名单的席位使用 general 视角，专业视角需在配置中定义。 |
| `focus` | string[]；未设置 | 重点，例如 `security`、`tests`。 |
| `detail` | `digest` / `full`；默认 `digest` | full 在结果值中附完整 `result`；给模型的文本渲染仍是摘要。 |

```json
{"mode":"quick","target":"staged","seats":3,"focus":["security","tests"]}
```

`auto` 当前由 Host 确定范围：有 base 则比较基线；否则工作区与 HEAD 比较（含未跟踪文件）；工作区无变更且有回合快照时尝试 `turn`。书记官解释冻结范围并提出模型分配，不重新选择快照。`turn` 依赖当前会话的 workspaceChanges；无法获取时可能回退工作区或返回 `NO_CHANGES`。`base-ref` 当前比较指定提交与工作区，不是 merge-base PR diff。

### 命令 `/magi-review`

```text
/magi-review [quick|council] [--base <ref> | --staged | --target <kind>]
             [--seats 3|5|7] [--focus <a,b>] [--detail digest|full]
/magi-review --report <id>
```

```text
/magi-review
/magi-review quick --staged
/magi-review --base main --seats 5 --focus security,tests
/magi-review council --target working-tree --focus "security, public API" --detail full
/magi-review --report 4741cc06-a1e4-4db5-a8df-7f717306f9fe
```

双引号或单引号可包裹含空格的参数，未闭合引号和未知参数会报错。解析不执行 shell，也不支持 shell 转义/插值。`--patch` 不读取文件，请用工具的 `patch` 文本参数；命令没有 `--paths`。`ping` 按未知参数报错。

命令输出结构化 Markdown，不显示三灯卡，也不进入父模型上下文。`--report <id>` 读取已有报告，返回同样的 Markdown（最多 20 KiB，保留 reportId），不会重新评审或自动写出 Markdown 文件。`--detail full` 不改变命令的 Markdown 渲染。完整 JSON 在存储目录的 `reviews/<reportId>.json`；可复制该文件导出。报告不存在或存储失败时会明确报错。

council 达到轮次上限时，**命令**可询问继续讨论或直接表决，默认等待 120 秒；**工具**直接表决，并在需要询问而未询问时记录 `human_confirmation_missing`。命令追加轮次只询问一次，仍受总超时约束。

### 结果语义

工具成功返回 `{ok:true, digest, reportId}`，full 另含 `result`；输入、配置等失败返回 `{ok:false, error}`。`ok:true` 表示形成评审结果，不表示通过；结果本身也可能是 `none/error`。

| 字段 | 值与含义 |
|---|---|
| `digest.verdict` | `approve`：满足规则；`request_changes`：阻断项、反对票或平票触发；`insufficient`：证据/覆盖/有效票不足；`none`：没有有效裁决。 |
| `digest.status` | `completed`：流程完成；`degraded`：有回退、缺席、部分覆盖等；`error`：无法形成有效结果。 |
| `digest.trust` | `trustworthy`：流程完整；`needs_review`：需进一步核查；`untrustworthy`：失败结果。它是流程可信度标签，不是模型正确性的保证。 |
| `digest.homogeneous` | 同一 model id 的多席也标为同构，包括跨 provider 托管同一模型；独立性有限。 |
| `digest.degradedReasons` / `result.errors` | 降级原因及阶段错误，不能只看 verdict。 |
| `result.reveal` / `result.decision` | 裁决后揭示的席位/模型/首轮与最终立场，以及策略、票数、quorum、dissent。 |
| `result.coverage` / `result.redaction` | 已审与未审路径、partial 状态，以及不含秘密原值的脱敏记录。 |
| `reportId` | 本地保存报告的定位符；`storage_failed` 时结果仍返回，但该 ID 可能无法检索。 |

**`insufficient` 绝不等于通过。** 应补证据、缩小输入或人工核查后重审。默认 majority 的 quorum 为 `floor(n/2)+1`（3/5/7 席分别需 2/3/4 票）；有阻断 finding 时拒绝通过。部分覆盖或中断不得 approve。非覆盖类降级仍可能产生 `approve/degraded/needs_review`，例如书记官回退但有效票满足 quorum。

## 配置

修改 `cordis.patch.yml` 中 `id: magi-review` 的 Host row `config`，保留两个 preset 的 id/结构。默认值以 [lib/host/config.js](lib/host/config.js) 为准，运行时差异见下表。

| 配置项 | 默认值 | 作用与当前实现 |
|---|---|---|
| `seats` | architect / engineer / adversary；各 `perspective: builtin:<id>`、`required:true` | 架构、实现、对抗三视角；名单支持 3/5/7 席，每席可 pin `model:{provider,model}`。 |
| `clerk` | `{}` | `clerk.model` 省略时跟随 DSH agent 默认模型；不可用时按允许路由目录/默认路由回退。 |
| `modes` | `default:council`，quick/council 各 `seats:3` | 显式请求席数优先，其次显式模式席数，最后配置名单长度。 |
| `models` | `defaultRoute:{provider:deepseek-official,model:deepseek-flash}`，`fallbackOnError:true` | 分配时处理不可用 pin；运行时跨 provider 重试尚未接通，见实现偏差。 |
| `discussion` | `maxRounds:3`、`onExhaustion:ask_human`、`extendByRounds:2`、`allowScripts:true` | 稳定时提前结束；关闭脚本时讨论改用 readonly preset。 |
| `discussion.humanConfirmationTimeoutMs` | config.js 为 `300000`；入口运行时未显式设置则为 **`120000`** | M2e 编排覆盖旧默认；显式配置值生效，仅命令会询问。 |
| `policy` | `approval:majority`、`blockingSeverity:high`、`escalateOnRisk:false` | 可选 unanimous；风险升级启用后，高风险使用 unanimous。 |
| `execution.concurrency` | `3` | 分批并发，不提供 DSH 全局子 agent 容量队列。 |
| `execution.briefTimeoutMs` | `240000`（240 秒） | 每席每次陈词超时。 |
| `execution.discussionRoundTimeoutMs` | `180000`（180 秒） | 每席每次讨论响应超时。 |
| `execution.ballotTimeoutMs` | `60000`（60 秒） | 每席每次表决超时。 |
| `execution.totalTimeoutMs` | `1800000`（1800 秒） | 评审总截止时间；结束后的护栏、落盘各有独立 5 秒 I/O 上限。 |
| `execution.promptBudgetTokens` | `16000` | 冻结 diff 按完整文件边界截取的估算预算，不是所有消息合计的 token 上限。 |
| `execution.maxCostUsd` / `execution.cache` | `0.5` / `true` | 缺少真实价格/usage 时不能保证美元硬上限；缓存接口存在，主流程尚未使用。 |
| `anonymity` | `mode:until_verdict`、`revealInReport:true`、`auditLedger:true` | 当前流程固定裁决后揭示；后两项为保留配置，不能据此关闭揭示或声称平台日志隔离。 |
| `output` | `detail:digest`、`exportMarkdownDir:null` | 默认摘要；自动 Markdown 目录导出尚未接通。 |
| `security` | `redactSecrets:true`、`allowThirdPartyProviders:true` | 允许配置目录内的第三方路由；不会弹出首次外发确认。 |
| `tool` / `command` | `enabled:true`，名称 `magi_review` / `magi-review` | 名称可配；Client 卡片当前固定匹配 `magi_review`。 |
| `debug.selftest` | `false` | 兼容旧配置，不再注册或运行探针。 |

配置来自受信任的 profile，不加载工作区文件作为权限、路由或输出策略。非法配置在入口校验时报错；未知键被配置归一化忽略。完整实现偏差及未来补齐方向见 [实现说明](docs/implementation-notes.md)。

## 架构与安全

- **Host**：入口、冻结快照、意图上下文、模型路由、议会编排、结果存储。
- **Client**：聊天内三灯卡，运行中匿名占位，结果态展示揭示后的发现、讨论、裁决与纪要。
- **两套 preset**：readonly 用于陈词/表决，verify 用于允许脚本的讨论；表决另由 Host guard 禁止所有工具。
- **core 纯逻辑**：diff、指纹、合并、blocking、裁决、匿名化、脱敏、摘要和模板纪要，无 DSH 依赖。

安全依赖 preset 与 deny-by-default guard、继承的 DSH 沙箱/审批策略、提示分区、协议校验、脱敏和工作区突变检测。findings 与纪要仍是不可信证据。子会话可被平台 catalog 发现，匿名不是平台级访问隔离；详见 [安全边界与残余风险](docs/security.md)。

## 已知限制与开发验证

每个阶段使用一次性子 agent，属于设计允许的降级路径，额外消耗上下文与时间。三灯卡运行中只有匿名占位，没有实时完成数或投票进度。usage 为估算，成本基准尚未建立。

默认存储目录是 `~/.dsh/storages/magi-review/default`，报告位于 `reviews/`。`DSH_HOME` / `DSH_PROFILE` 环境变量可改变根目录/命名空间；当前入口不会自动发现 desktop profile 名，多 profile 部署需外部隔离。

在仓库根目录运行（Node.js 需支持 ESM、node:test、structuredClone；Git 用于快照测试）：

```powershell
node --test "test/core/*.test.js" "test/host/*.test.js"
node --test "test/unit/*.test.js"
node --check lib/index.js
```

测试无需启动 DSH 或调用模型；Git 测试仅在临时仓库构造夹具。本机 Windows 两项符号链接测试因 EPERM 跳过，不代表验证通过。已有真实运行记录、自动测试结果及 GUI 手工验收清单见 [验证记录](docs/verification.md)。

## English

**MAGI Council Review** is a native DeepSeek Harness bundle for code changes: independent briefs, anonymous discussion, sealed ballots, rule-based verdicts, reveal and minutes. Version 0.1.0 targets DSH 0.2.1-rc.2 and has no runtime npm dependencies.

Install this repository as a local bundle in the desktop profile, then use `magi_review` or `/magi-review quick --staged`. `insufficient` is never approval. Findings are untrusted evidence; homogeneous councils have limited independence. `/magi-review --report <id>` renders saved Markdown; full JSON lives under `~/.dsh/storages/magi-review/default/reviews/`. See the [security notes](docs/security.md) and [verification record](docs/verification.md) for limits and pending checks.
