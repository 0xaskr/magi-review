# MAGI Review × DeepSeek Harness：插件化设计头脑风暴（讨论稿）

> 后续逐项确认的结论已固化为 [MAGI Review 设计文档 v1.1：DSH 原生议会式审查](../superpowers/specs/2026-10-18-magi-review-dsh-native-design-zh.md)。本文件保留讨论过程、备选方案与开放问题。

- 日期：2026-10-18（Asia/Shanghai）
- 仓库：`magi-review` @ `65f6201`（当前仅有设计文档，无代码）
- 依据：仓库内两份设计文档（[中文](../superpowers/specs/2026-06-12-magi-review-design-zh.md) / [English](../superpowers/specs/2026-06-12-magi-review-design.md)）、本机 DSH 桌面版所装包（profile 依赖的 DSH 包版本 `0.2.1-rc.2`）导出的官方包 README 与 profile 配置
- 状态：**讨论稿**。标有「待验证」的条目需要进入 Creator 模式的会话用 `cordis_inspect_query` 或做最小实验确认；最后一节是待拍板的问题。

---

## 0. 一页结论（TL;DR）

1. **形态**：把 magi-review 收敛为 **DSH 原生插件（Host + Web UI）**，而不是把 Python CLI 塞进 DSH。保留现有 JSON 契约作为跨宿主接口；Python CLI 降级为第二适配器、后置。
2. **复用 DSH 而不是重造**：模型调用用 `ctx.llm`（provider-neutral）+ 已配置的 provider（DeepSeek / OpenRouter）；"能读周边代码的审查者"用 `ctx.subagents` + 只读 agent preset；工具/命令/UI/存储/审计分别用 `ctx.tools`、`ctx.commands`、Client slots、`ctx.storageDomain`、session log。
3. **审查者执行分三档，显式审查默认走 agentic**：`quick`（单次 LLM、diff-only，用于自动/廉价检查与人可选的快路径）/ `standard`（只读 agentic 审查者，能读周边代码与测试，`magi_review` 与 `/magi-review` 的默认档）/ `deep`（standard + 更多步数预算 + 可选外部 CLI 异构模型 + 跨轮上下文）。高风险 diff（鉴权/迁移/依赖/CI、文件多、出现 critical）自动升级。**verdict 永远是纯函数算出来的，不是审查者或 workflow 投票/编排的产物。**
4. **决策策略必须重写为 fail-closed**：现有 spec 的 `approve|error|error → approve`、unanimous 表里"已完成者判断"、以及"blocking finding 不参与裁决"三处是实打实的 fail-open 漏洞。建议引入 `insufficient` 裁决 + blocking finding 一票否决 + 通用 quorum 算法。
5. **聚合器规则优先**：规则负责去重/severity/blocking/稳定 ID；模型只写叙事摘要，不参与 verdict。这样才有确定性、可测试、可降级。
6. **审查对象默认用"本回合变更"**：直接复用已挂载的 `dsh-workspace-changes` 的 per-turn 快照 diff，天然对焦"AI 生成代码变更"；working-tree/base/staged/patch 作为显式目标。
7. **输出做上下文经济学**：工具结果只回 digest（≤4KB：verdict、三席一句话、Top blocking findings、报告路径），完整 `ReviewResult` 落存储/文件；UI 卡片读 digest + 打开完整报告。
8. **深入 DSH 的差异化功能**：除了 diff，还能审查"agent 声称做了什么 vs 实际改了什么"（任务/计划/最终回答 vs diff）——这是通用 PR 审查工具做不到的，正好落在 spec 里 "hidden AI hallucination effects" 的对抗席职责上。
9. **安全边界 DSH 化**：审查者子 agent 固定 `never` 审批策略 + 只读工具预设；diff/文件/AGENTS.md 一律不可信；findings 回传父 agent 时按"不可信数据"处理（防二次注入）；脱敏在进入模型前完成。
10. **工程约束**：桌面 profile 由 Electron 独占，`dsh plugin` CLI 无法直连 desktop profile；安装/启停走 Web Plugins 页（本地绝对路径 / git / npm）。插件应 **零运行时 npm 依赖**，以降低本地安装与迭代失败率。

---

## 1. 现状：仓库有什么、spec 假设了什么

### 1.1 仓库

- 只有两份等价的 spec（中/英），无代码、无测试、无包结构。
- spec 的完成度很高：分层（Adapter / Core / Provider / Reporting）、输入与结果 schema、三审查者、聚合器、决策策略与降级、确定性、脱敏、信任边界、测试策略、扩展点都已定义。
- 定位原文："多模型、多智能体代码审查引擎……嵌入到不同的智能体工作流中，包括 Claude、Codex、Gemini、opencode、CI 以及未来的 GitHub 集成"；"CLI 只是首个适配器，不是核心产品边界"。

也就是说：**把 DSH 当适配器是 spec 原本就预留的路线**，现在的区别是——DSH 不是又一个 CLI 调用方，而是第一个"宿主 + UI"。

### 1.2 spec 里在 DSH 形态下会失效的假设

| spec 假设 | DSH 现实 |
|---|---|
| 生产代码用 Python | DSH 插件是 Node/ESM（Host + 浏览器半）；Python 只会作为被裁剪的 CLI 适配器存在 |
| 自建 Model Provider Layer（Anthropic/OpenAI/Gemini SDK） | DSH 已有 `ctx.llm` + provider 适配器（DeepSeek、pi-ai/OpenRouter…），插件不应直接调 SDK |
| Orchestrator 自行并行调用 provider | DSH 有 `ctx.subagents`（spawn/fork/外部 CLI provider）、`ctx.jobs`、协作式取消、审批策略继承 |
| CLI 负责收集 diff | DSH 已有 `dsh-workspace-changes`：per-turn 快照 diff（含 git 与文件工具捕获） |
| 输出严格 JSON 到 stdout | 插件输出是工具结果 / 命令结果 / UI 卡片；JSON 契约仍然可以保留在工具结果与报告文件里 |
| 配置来自 yaml 文件 + 信任边界 | DSH 插件的 row `config` 在 profile（可信层）；workspace 里的项目配置是不可信层；还有 preset/设置页等表面 |
| 人只通过 CLI 消费结果 | DSH 有人类命令、聊天卡片、侧栏、报告文件、`present` 交付物等多种消费面 |

---

## 2. 四种产品形态与推荐

### A. 维持"独立引擎 + CLI"（把 DSH 当又一个调用方）

- 优点：完全符合现有 spec；跨宿主（Claude Code / Codex / CI）价值最大；Python 生态成熟。
- 缺点：在 DSH 里只能做"外部进程 + 文本协议"适配，拿不到 session log、UI、模型目录、沙箱、预算、审批；安装分发多一层 Python 运行时依赖；"三灯卡片"这种产品体验做不出来。
- 结论：**作为 V2 的兼容出口**，不是当前主线。

### B. DSH 原生插件（推荐）

- 优点：直接吃 DSH 的全部能力；安装一条命令/一次点击；UI 可以做深；与 agent 工作流天然耦合（工具调用、命令、门禁、循环）。
- 缺点：绑定 DSH；Node 侧要重新实现 core（但 core 本来就是纯逻辑）；DSH API 仍在 rc 阶段，需要兼容性策略。
- 结论：**当前主线**。

### C. 双形态（契约冻结，TS 插件 + Python CLI 两实现）

- 优点：契约（ReviewInput / ReviewerResult / ReviewResult）真正跨宿主；CLI 与插件共享测试样例。
- 缺点：两套实现 = 双倍维护；M1 就会拖慢。
- 结论：**契约先冻结、CLI 实现后置**；等 core 稳定后由同一份 TypeScript 输出或由 Python 薄客户端复用 JSON 契约。

### D. 纯流程（skill / 提示词 + subagent 编排，无插件）

- 优点：0 工程成本，今天就能跑；验证"三席审查在 DSH 里到底有没有效"。
- 缺点：无确定性、无策略、无 UI、不可审计、无法门禁。
- 结论：**M0 的临时验证手段**，不是产品形态。

### 为什么"把 Python 引擎包进插件"不推荐

1. **安装与运行**：DSH 桌面版的 profile 由 Electron 应用管理，插件安装走 pnpm（npm/Git/本地路径）；Python 不在 DSH 的宿主运行时里（`workspace-dependencies` 的 Python 是给 agent 工作区用的工具链，不是插件运行时）。
2. **重复造轮子**：provider 路由、取消/超时、审批继承、沙箱、session log、UI slots、存储、预算，DSH 全有；插件再建一层，两套语义必然漂移。
3. **不变量**：DSH 的核心不变量是"模型可见 ⟺ 已记录"（session log 是唯一真相）、"注册即 effect"。审查动作如果发生在黑盒进程里，审计、重放、UI 都接不上。
4. **例外**：如果 magi 的长期目标是"任何宿主可用的审查引擎"，那就把 **JSON 契约**当成产品、把实现当适配器；这与推荐 B 不冲突。

---

## 3. DSH 能力 ↔ spec 分层映射

| spec 层 | DSH 对应物 | 用法 / 取舍 |
|---|---|---|
| Adapter Layer | Host 插件 + `ctx.tools` + `ctx.commands` + Client slots | `magi_review` 工具（agent 触发）、`/magi-review` 命令（人类触发）、工具卡/侧栏（展示） |
| Canonical Diff | `dsh-workspace-changes`（per-turn 快照 + 逐文件 hunk diff）、`ctx.subprocess` 跑 git、自研 canonical 模型 | turn 目标零 git 成本；working-tree/base 目标自己跑 git（参考 workspace-changes 的安全参数与超时） |
| Model Provider Layer | `ctx.llm`（provider-neutral 流式调用 + 模型能力解析）；provider 适配器既有 `deepseek-*`、`pi-ai` | 单次审查者用 `ctx.llm.stream()`；不要 import 供应商 SDK |
| Reviewer execution | `ctx.subagents.startActivation()`（spawn provider：新会话、可覆盖模型）、只读 agent preset | agentic 审查者 = 有限工具 + 只读职责的子 agent；外部 CLI（codex 等）= 异构模型选项 |
| Orchestrator | 插件内 service + `Promise`/`AbortSignal` + `ctx.jobs`（后台运行） | 禁止 fail-fast；每个审查者独立超时/取消；保留部分结果 |
| Aggregator | 纯规则合并（确定性）+ 可选 `ctx.llm` 叙事 | 模型只写 summary，不参与 verdict |
| Decision Policy | 纯 TypeScript 函数 | 表驱动单测；策略版本进 `config_hash` |
| Reporter | 工具结果 digest + 报告文件/存储 + 自定义工具卡 | JSON 契约保留；UI 渲染 digest |
| Audit / State | session log（tool call/result、子 agent 会话）+ `ctx.sessionProjections` + `ctx.storageDomain` | 不新增 session event type；projection 派生 UI 状态 |
| Security | 只读 agent preset + delegated child 固定 `never` 审批 + 脱敏 + 信任边界 | findings 回传父 agent 视为不可信数据 |
| Execution Controls | 工具 `timeoutMs`（由 timeout-policy 包装器执行）、`ctx.subagents` 容量、`ctx.tokenMeter`/usage ledger | 插件自己再记录每席 tokens/耗时/成本估算 |
| Testing | node/vitest 单测 + `dsh-llm-replay`（如可用）做 keyless 快照 + headless profile 集成 | 策略/解析器/ID/去重全部纯函数化 |

---

## 4. 关键设计决策（讨论项）

### D1 运行时与语言

- **选项**：TypeScript 插件（构建为 `lib/index.js` + `lib/client.js`）/ 纯 JS 无构建 / Python 子进程 / 双实现。
- **推荐**：TypeScript + 构建，**零运行时 npm 依赖**（Node 内置 + DSH 服务）。Host 侧把 `@deepseek-ai/*` 放 `peerDependencies`（由宿主解析，参考已安装的第三方插件 `@kenz1117/dsh-ui-usage-billing` 的包结构）；Client 侧不 import 任何 Harness client 包（practices 明确禁止），需要的基础组件自己写、样式只用 `--dsw-alias-*` token。
- **理由**：本地目录安装不需要 registry 就绪；HMR/重载失败面小；与 DSH 模块体系不打架。
- **待验证**：本地目录安装是否仍需 pnpm 联网解析 peer 依赖；`package.json` 的 `dsh.compatibility` 字段对 rc 版本的行为。

### D2 审查者执行档位（核心决策）

| 档位 | 执行方式 | 上下文 | 典型耗时/席 | 质量 | 成本 | 确定性 |
|---|---|---|---|---|---|---|
| `quick` | `ctx.llm` 单次调用 | canonical diff + 项目约定摘要 | 5–20s | 中 | 低 | 较高（单发、可 temperature=0） |
| `standard` | `ctx.subagents` spawn + 只读 preset | diff + 可读周边代码/测试/配置 | 30–120s | 高 | 中高 | 中（多步 agent 行为有随机性） |
| `deep` | standard + 更多步数/预算 + 可选外部 CLI 异构模型 + 历史轮次 | 全部 + 跨轮上下文 | 1–5min | 最高 | 高 | 低 |

- **推荐默认**：`magi_review` 工具与 `/magi-review` 命令 = `standard`（显式审查，质量优先）；自动审查/预览/廉价检查 = `quick`，并在敏感路径、>8 文件、出现 critical finding 时自动升级；门禁与 `--deep` = `deep`。配置可改默认。
- **只读强制（关键）**：agentic 审查者必须用**独立只读 agent preset**（allowlist：`read`/`grep`/`glob`/`lsp` 等；denylist：`bash`/`write`/`edit`/`web_*`/`terminal_*`/`present`），并且被委托子 agent 的审批策略固定为 `never`（DSH 语义：被委托子 agent 无法请求/获得审批）。**不要依赖沙箱继承**：委托子 agent 只复制父会话"显式 override"的权限，workspace-write 的父会话可能带出能写文件的子 agent；只读性必须由工具集/preset 保证，而不是由 sandbox 模式保证。
- **调用形态**：`ctx.subagents.startActivation({ provider: 'spawn', signal, delivery: 'caller', request: { prompt, cwd, agentOptions, outputSchema } })`。`delivery: 'caller'` 不产生父会话完成通知，三席内部过程不会污染父对话；`parent + delivery:'parent'` 会给每席加一条 notice（不要用）。并发 2–3，每席 120s deadline（AbortController + `dispose()` 等待子树收敛），保留部分结果。
- **确定性锚点**：`AgentOptions` 只有 provider/model/reasoningEffort/maxTokens，**没有 temperature**；agentic 档的可复现性是"相同输入 + 相同 prompt/config hash + 记录模型路由"，而不是逐字相同。`quick` 档走 `ctx.llm` 可以显式设 temperature=0，确定性最好。
- **结构化输出**：优先用 `outputSchema` 约束审查者返回 JSON（子 agent 通过 `structured_output` 提交）；插件侧仍要做二次校验/修复/失败映射（`invalid_output`）。待验证：deadline/`dispose()`/max-tokens 对已暂存 structured result 的影响。
- **异构模型**：本机 profile 只有两条路由（`deepseek-official/deepseek-flash`、`openrouter/stealth/space-bunny-alpha`），另装有 codex subagent provider（外部 CLI）。所以 A/B 档的"独立性"主要来自角色/上下文，**只有 C（外部 CLI）是真正的模型族多样性**；三席可按席配置 provider/model，但必须如实记录，不能宣称不存在的独立性。
- **workflow 引擎不是编排器**：`workflow` 工具适合做 M0 原型，但产品化应由插件自己的 service 编排（超时/取消/预算/结构化输出/错误映射可控）；`workflowEngine.start` 在桌面 profile 是否可用需实测，且 `agent() === null` 会丢失败原因，不适合作为审查裁决链路。
- **待验证**：`SubagentStartRequest` 是否允许直接传 `toolFilter`/`persona`（还是必须挂 agent preset）；`activation.result.structured` 是否稳定；外部 provider 对 `agentOptions`/`outputSchema`/`maxDepth` 的拒绝行为；`maxActiveSubagents`（默认 8，与用户自己的子 agent 共享）是否会被审查占满。

### D3 审查对象与快照一致性

- **目标类型**（建议进 schema 的 `target`）：
  - `turn`：本回合变更（`ctx.workspaceChanges.summary/diff`），最贴合"AI 生成变更"，零 git 成本（仅当前 session 存活期有效）。
  - `working-tree`：工作区 vs HEAD（git 子进程）；`staged`；`base-ref`（vs main 等）。
  - `patch`：显式 patch 文本（工具参数/剪贴板/文件）。
  - `report` / `answer`：V2，审查非代码产物（spec 的次要目标）。
- **推荐默认**：`turn`；若工作区不是 git 仓库则必然回退到 `turn`（文件工具捕获）。
- **快照一致性**：审查开始时立即冻结输入（patch 字节 + base sha + 文件列表），`input_hash` 覆盖它；agentic 审查者读工作区时可能读到新改动 → MVP 记录"审查时刻 + input_hash"并声明该限制；deep 档可后续用 worktree 快照（DSH 有 worktree 工具）保证"审查者读到的 == 被审的"。
- **覆盖率**：部分审查（大 diff 切分）必须进 `coverage`，且不得产出 `approve`（见 D7）。

### D4 触发与参与点

| 触发 | 机制 | 是否进模型上下文 | 默认 |
|---|---|---|---|
| `magi_review` 工具 | agent 主动调用 | 是（只回 digest） | 开 |
| `/magi-review` 命令 | `ctx.commands.register`，人类触发 | 否（命令平面，可显式 `agent.inject`） | 开 |
| 回合结束自动审查 | `turn/end` 后异步 job | 默认否（写 storage + UI 徽标） | 关 |
| 门禁 | `ctx.tools.guard` / `tools/pre-execute`（commit/push/present 前） | 只回 deny 原因 | 关 |
| 修复循环 | review→fix→re-review（rounds） | 是 | 需要时 |
| 计划审查 | 审查 plan/answer 而非 diff（V2） | 是 | 关 |

- **工具参数绝不携带 diff 正文**：参数只允许 `{mode, target, base_ref, staged, detail}` 这类选择器，diff 由插件侧取。否则整份 diff 会留在父 session log 里，并被每一轮请求重发（上下文与成本双杀）。
- **推荐**：V1 只做工具 + 命令；门禁与自动审查作为两个显式 opt-in 配置，避免"每回合烧三份 agent 预算"。
- **注意**：自动审查若要出现在聊天流里，通常需要新的 conversation 事件类型；DSH 明确不建议第三方插件新增 session event type（`appendPluginRecord` 是 experimental 保留）。因此自动审查的结果应落 storage + projection + 侧栏/徽标，而不是伪造聊天行。

### D5 三席 vs 动态议会

- **保留三席**：Architect / Engineer / Adversary 的差异是产品价值与可解释性来源；奇数投票席让多数决简单。
- **增加"专家席"**：不参与多数票计数，只贡献 findings 与 blocking 信号；按 diff 特征自动路由（鉴权/加密、数据库迁移、并发、公开 API、依赖变更、CI/部署、i18n…）。奇数约束只对**投票席**成立。
- **政策通用化**：把决策写成对任意席数成立的 `quorum` 算法，而不是只支持 3 席的表格（spec 当前只有 3 席表）。
- **命名/IP**：产品名 `MAGI` 可用作视觉主题，但建议审查者用功能名（Architect / Engineer / Adversary），不要直接用 Evangelion 的角色名做产品标识；显示名可配置。

### D6 聚合器：规则优先，模型只叙事

- **规则负责**：去重合并（按指纹）、保留 provenance、severity/blocking 判定、稳定 ID、错误归一、覆盖率/降级说明、对决策策略的事实摘要。
- **模型可选**：只生成人类可读的叙事 summary（"主席陈述"），不参与 verdict；失败/超时直接丢弃，不影响决策。
- **模型可选的边界要写死**：模型只能*提议*合并/注释/叙事，核心做确定性应用与校验；`blocking`、`overall_impact`、`effective_policy` 只能由规则层产生；模型输出违反 provenance/union 规则时直接判 aggregation failed 并回落规则。聚合器若用模型，应尽量与审查者使用不同模型/路由，并在 metadata 里记录 `independence`（aggregator_model 是否与某席相同）。
- **修正 spec 的含糊点**：原 spec "聚合器可以使用模型提供商，但其输出必须被标准化" 容易被实现成"模型参与裁决"。建议明确：**payload 决策字段只能由规则产生，模型输出是展示层字段**。
- **缺失的中间契约**：spec 没有定义 `AggregatedEvidence`（聚合器 → 决策策略的输入 schema）。v1.1 必须补：规范化 findings（含 provenance/blocking/severity/confidence）、impact 票、coverage/scope、errors、aggregation status/mode；规则与模型两条路径都产出同一 schema，策略先校验再决策。

### D7 决策策略修正（建议重写，最影响产品正确性）

现有 spec 的问题（原文表格逐条）：

1. `approve | error | error → degraded / approve`：只有 1 票（且 2/3 失败）却给出 approve，与"避免 fail-open 批准"直接矛盾。
2. `request_changes | error | error → degraded / request_changes`：对称地，1 票 request_changes 就否决，说明策略实际是"单个幸存者说了算"，却没写清楚。
3. unanimous 表 `任意含 error（非全部）→ 已完成者的判断`：若已完成者只有 1 个 approve，这条会给出 approve，但 unanimity 根本没达成。
4. 多数决表格没有定义"分母"：是全部审查者、全部 required、还是 completed？
5. `blocking` 状态的 finding 不参与 verdict：对抗席发现一个 critical 漏洞，只要另外两席 approve 就被多数票淹没——这违背三席设计初衷。
6. 部分审查（大 diff 策略）只要求 `status=degraded`，但实际输出仍可能是 approve → fail-open。
7. `impact` 由审查者自评多数决决定是否升级 unanimous：自评不稳定，且 2 个 reviewer 出错时 1 个自评 normal 就把整体拉回 normal，等于用失败掩盖风险。

**建议的通用算法**（对任意奇数投票席成立，规则进单测）：

```text
输入:
  required_vote_seats n (奇数, n>=1), optional_seats, completed, findings(aggregated)
  A = completed 投票席中 approve 数; R = completed 投票席中 request_changes 数
  blocking = 规则判定: severity=critical 或 (severity>=high 且 confidence>=medium)
            [阈值可配置，但默认不依赖模型自评；聚合器只能抬高不能压低]
  quorum = floor(n/2) + 1                # 3 席 => 2, 5 席 => 3

majority 模式（严格多数 + 平票保守）:
1. 任一 blocking finding（投票席或专家席）              => request_changes
2. R >= quorum 且 R > A                                 => request_changes
3. A >= quorum 且 A > R 且无 blocking                   => approve
4. A == R > 0（已完成者平票，通常来自 error 缺席）      => request_changes（保守；可配置为 insufficient）
5. 其余（有 completed 但达不成任何结论）                => insufficient（证据不足）
6. 无任何可用证据 / 输入/核心失败                       => none（status=error）
7. 部分覆盖（partial）或 review 中断                    => 不得 approve；
                                                          有 blocking => request_changes，否则 insufficient

unanimous 模式（全票通过是充分必要条件）:
  approve      = 全部 required completed 且全部 approve 且无 blocking
  request      = 任一 completed request_changes 或任一 blocking
  insufficient = 其余（含"有 error 但无人反对"——不允许 degraded approve；
                 消费方若需要二值结论，应把 insufficient 当作未通过）
  none         = 全部 error

status:
  completed = 全部 required 完成 且 无部分覆盖 且 聚合成功
  degraded  = 至少 1 个 required error，或部分覆盖，或聚合 fallback，或 optional 席失败
  error     = 0 个可用 completed，或输入/核心失败

策略字段（避免"实际执行了哪条策略"说不清）:
  declared_policy  = 配置/CLI 声明的策略
  effective_policy = strictest(trusted_config, cli, risk_escalation)   // 只能单调升级
  escalated_by     = none | impact | risk | cli
  policy_downgrade 只能来自可信层的显式 opt-in 并记录
```

- **影响评级拆成两层**：
  - `reviewer.impact`：审查者主观信号，只进 metadata/叙事；
  - `overall_impact`：由**确定性风险特征**计算（改动文件数/行数、敏感路径：auth、crypto、migrations、CI、部署、依赖锁文件、删除为主、公开 API 导出变更…）+ findings 最高严重级。高风险 → 自动升级 unanimous / 建议人工复核。
  - 若仍保留"审查者 impact 票"作为输入：只统计 **completed 的 required 席**；平票（含 1-1）保守地取 `major`（升级）；无任何 completed 时 `overall_impact` 必须可为 `unknown`，不能强行二值；同时输出 `impact_votes` 与 `impact_basis`。
- **findings 与票的交叉校验**：`request_changes` 必须至少有一个达到阈值的新增 finding（或写明 `no_specific_finding` 理由）；`approve` 不允许自带 blocking/critical finding（冲突时强制转 request_changes 或判契约错误）。**聚合器只能抬高 blocking，不能压低**；聚合后必须满足 union-superset 不变量：每条可用 reviewer finding 都能追溯到一条 aggregated finding（`source_finding_ids` 非空且合法）。
- **新增裁决值 `insufficient`**（或把 `none` 重新定义为"无结论"、`insufficient` 表示"有结论但证据不足"）。这是 schema v1.1 的 breaking 变更，但比 fail-open 诚实得多。消费方（CI/agent）必须显式处理它，而不是把 `approve` 当默认通过。
- **可选席（optional）**：其 findings 进入聚合；其票不计入 quorum；其 blocking finding 同样触发 request_changes（宁可多一次人工复核，也不要漏掉）。

### D8 输出契约与上下文经济学

- **保留 `ReviewResult` envelope**，作为工具结果、报告文件、CLI 的同一契约（v1.1 增量字段见附录 B）。
- **工具结果 = digest**（目标 ≤4KB）：
  ```
  status / verdict / decision_policy / overall_impact / summary(1-2 句)
  seats: [{id, verdict, impact?, status, 1-line reason}]
  blocking_findings: Top 5（id, severity, path:line, title）
  coverage + partial 标记
  report_path / report_id（完整 JSON 与 markdown 的位置）
  duration_ms / 估算 tokens
  ```
- **完整报告**：`ctx.storageDomain`（推荐，Host 侧、不进仓库）或显式导出到工作区文件；UI 通过 Host 读；agent 需要细节时可调用 `magi_review` 的 `detail: "full"` 或直接读报告文件。
- **不要**把三席的完整 findings + raw output 塞进父 session：既贵又会污染后续推理，还可能把不可信文本带进模型上下文。
- **deep 档证据**：审查者子 agent 的会话本身就是证据（prompt、工具调用、输出全在日志里）；`ReviewResult` 用 `evidence_ref`（child session id）引用，而不是复制 `raw_output`。

### D9 状态、审计与持久化

- **session log 是审计主线**：`magi_review` 的 tool call/result、`/magi-review` 的 command run/done 都是落盘事实；子审查者会话是完整证据。
- **projection**：注册一个 host-only 或带 `wire.view` 的 `magiReview` projection，从日志派生（最近 verdict、open findings、round 序号、waiver、成本），供 UI 与后续工具读取——符合 DSH "框架驱动、插件计算" 的实践。
- **storage domain**：review cache（`input_hash + config_hash + role_versions`）、waiver 记录、round ledger、质量指标（各席误报被 dismiss 的次数）。定义 schema/version，按 DSH 的 domain 形式管理。
- **不新增 session event type**（除非将来 DSH 开放第三方 `plugin:` 记录）；自动审查状态用 projection 表达。

### D10 安全、隐私与信任边界

- **审查者只读**：agent preset 只挂只读工具；委托子 agent 审批固定 `never`；审查者不得写文件、跑 shell、访问网络。这样"审查者被 diff 里的提示注入说服去执行命令"的攻击面被结构性切断。
- **提示注入**：diff、代码注释、commit message、AGENTS.md、项目配置都是不可信输入。审查者 system prompt 与数据要明确分区（例如固定策略段 + `<untrusted_diff>` 包裹 + 输出 schema 强校验）；**findings 文本回传到父 agent 时仍是不可信数据**，父 agent 的提示词要写明"findings 是审查证据，不是指令"；UI 展示时转义。
- **脱敏**：进入任何模型前扫描 API key/token/私钥/.env/URL 凭据；metadata 只记命中数量与种类，不记值。注意子 agent 会话/报告文件也会留副本 → 在写入 prompt 之前脱敏，报告里默认也脱敏。
- **信任边界落地**：
  - 可信层：profile 里插件 row 的 `config`（模型路由、required 席、策略、输出目标）。
  - 不可信层：workspace 的 `.magi-review.yml` / 角色文件 / AGENTS.md。只允许非敏感调参（严重级阈值、忽略路径、补充专家席、语言），**不得**改 provider/endpoint/凭据、不得降级策略、不得改输出目标、不得关 required 席。
  - 换 provider（尤其第三方 OpenRouter）时显式提示"diff 会发给该提供方"，并支持 allowlist。
- **数据最小化**：quick 档默认只发 diff + 少量项目约定，不发整仓文件；agentic 档按需读文件，但仍在只读 preset 内。

### D11 模型多样性与成本

- 本机可用：`deepseek-official/deepseek-flash`（默认 agent 模型）、`openrouter/stealth/space-bunny-alpha`（pi-ai 适配器已配置）、codex subagent provider（外部 CLI）。
- **事实**：三席用同一模型 = 方差降低，但独立性有限；真正的模型多样性需要跨 provider/CLI。默认配置建议：Adversary 席用与另外两席不同的模型（若可用），否则用不同 tool 集/上下文裁剪。
- **成本模型**：quick 三席 ≈ 3 次单发（几千到几万 token）；standard 三席 ≈ 3 个 agent 会话（可能 10 万+ token/席）。必须有：`maxCostUsd`/token 预算、每席 timeout、总 timeout、缓存、增量审查。预算耗尽 → 该席 `budget_exceeded`，整体 degraded / insufficient（不得 approve）。
- **可观测**：记录每席 provider/model/effort、tokens（`ctx.tokenMeter` 或适配器 usage）、duration；在报告与 UI 展示，方便用户判断"这 3 分钱花得值不值"。

### D12 轮次、增量审查与 finding 生命周期

- **round**：每次审查生成 round（`index`、`previous_verdict`、`input_hash`）。
- **fingerprint**：不能只用行号（修复后行号会漂移）。建议 `path + 归一化代码锚点（hunk 上下文/邻近行 hash）+ category + 归一化标题` 计算稳定指纹；跨轮做模糊匹配（同 path、相似锚点、标题相似度阈值）。
- **状态机**：`open → fixed | still_present | waived | dismissed`；`waived/dismissed` 只能人类操作（记录作者/理由/时间/范围）。
- **增量审查**：修复后只审 delta（新 patch）并复核旧 findings，输出"已修复 / 仍存在 / 新增"；这是省成本、也让 agent 循环可终止的关键。
- **终止条件**：`max_rounds`（如 3）；超过仍 blocking → `insufficient` + 明确建议人工介入，避免 agent 与审查者无限对喷。

### D13 与 DSH 其他能力的关系

- **auto-review（已在本 profile 启用）**：它是"工具调用授权审查"（安全），magi 是"代码质量审查"。共享"独立审查者 + 结构化裁决 + 失败保守"的模式，但目标/时机/失败语义不同，**不要合并**；可以借鉴其风险分级提示词与"denial 可见、reviewer 内部细节不持久化"的取舍。
- **goal / ralph 循环**：magi 作为外部裁判接入；review→fix→re-review，`insufficient` 时转人工。
- **Agent Teams**：审查者不需要 durable teammate（一次性 subagent 更合适、成本更低）；V2 若要"人类 + 多 agent 三方议会"再考虑 teammates。
- **plan mode**：V2 可审查 plan 本身（"计划审查"），复用同一套 role/policy，只是 canonical input 从 diff 换成 plan 文本。
- **workflow 工具**：可以作为 M0 的编排原型（workflow script 内 fan-out 三个 agent），但产品化后应由插件自己的 service 编排（可控超时/取消/预算/结构化输出）。

### D13.5 重要的产品机会：意图一致性审查（"声称 vs 实际"）

DSH 天然知道这次改动的来龙去脉：本回合的用户请求、计划（plan mode）、agent 的最终回答与交付声明、被修改的文件。把"agent 声称做了什么"与"diff 实际做了什么"对照，是通用 PR 审查工具做不到的，也正好落在 spec 对抗席的职责（"hidden AI hallucination effects"）上：

- 声称实现的功能是否真的实现（还是 placeholder/TODO/只改注释）；
- 声称"测试通过/已覆盖"时，有没有对应的测试改动或运行证据；
- 是否越界修改了请求之外的文件、删除了不该删的东西；
- 是否遗漏了请求中的子项（多文件任务最容易出现）。

实现成本不高：从 session 里取本回合用户消息 + 最后一条 assistant 消息 + diff 即可；`ReviewContext` 增加 `intent` / `claims` 字段。建议作为 Architect 席的一项职责（或单独的第 4 位**专家席** Intent Auditor，不参与多数票）。注意：agent 的最终回答本身也是不可信输入（可能夸大），审查者要基于证据判断并在 finding 里附证据。

### D14 分发与迭代（工程约束）

- 桌面 profile 由 Electron 独占：`dsh plugin --profile desktop ...` 会被拒绝（已实测）。安装/启停路径：Web → Plugins → Add plugin → 包名 / Git / 本地绝对路径；或 Creator 模式会话里的 `plugin_manager` 工具。
- **当前标准 preset 没有 `plugin_manager` 与 `cordis_inspect_query`**；Creator（`cordis` preset）才有。所以"装插件/查运行时 API"需要人类开 Creator 会话（或用户从 Plugins 页安装本地目录）。
- 本地目录安装是 link；Host JS 改动后需要重新加载（可能需要重启 Harness），迭代成本真实存在。建议：
  - 角色提示词、阈值等放 `Config`/workspace 文件（改配置不重启）；
  - core 逻辑单独打包，用单测覆盖大部分改动；
  - 发布版用 npm 包 + `dsh.compatibility`。
- **兼容性**：DSH 仍是 rc；锁定 `^0.2.x` 并在 README 声明已验证版本；peer deps 用 `*`（参考第三方插件做法）。

---

## 5. spec 需要修订的清单（建议逐条处理）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| 1 | degraded 下 single-vote approve | majority 表 `approve/error/error → approve` | 改 `insufficient`；approve 需 quorum（见 D7） |
| 2 | unanimous 下 error 语义 | unanimous 表"已完成者的判断" | 明确：有 error 即不 approve |
| 3 | 多数决分母未定义 | "majority vote among required reviewers" | 写明全部 required vs completed 的 quorum 公式 |
| 4 | blocking finding 无权否决 | aggregator 节 vs decision policy 节 | blocking（确定性规则）一票否决 |
| 5 | 部分覆盖仍可 approve | Large Diff Handling | partial ⇒ 最高 insufficient |
| 6 | impact 自评多数决升级 | Impact Rating and Policy Escalation | 改为确定性风险特征 + findings 最高严重级；自评仅参考 |
| 7 | verdict 缺"证据不足" | ReviewResult.verdict 三值 | v1.1 增 `insufficient`（或重定义 `none`），消费方必须显式处理 |
| 8 | 稳定 ID 依赖行号 | Determinism 节 "normalized location, category, title" | 内容指纹 + 跨轮模糊匹配 + finding 生命周期 |
| 9 | 缺审查目标/范围/覆盖率模型 | ReviewInput 只有 source/changes | v1.1 增 `target`、`coverage`、`round`、`risk`、`evidence_ref` |
| 10 | 缺"审查者能看到什么"的模型 | 全文无 reviewer tool/context 定义 | 定义三档上下文与只读工具边界（D2） |
| 11 | 缺成本/延迟默认值 | 只有 `max_estimated_cost_usd` 示例 | 给出三档默认值、预算耗尽语义 |
| 12 | 缺人工介入模型 | 只有 verdict | waiver / override / 人工复核队列 / 审计字段 |
| 13 | 缺评测与回归方案 | Testing 只到单元/契约/E2E | golden diffs + 误报率 + 模型/角色版本回归 + replay 快照 |
| 14 | 缺"AI 生成"的特有审查面 | ReviewContext 有 `ai_tool`/`task`，但无 claim 校验 | 增 `intent/claims` 上下文与"声称 vs 实际"审查视角 |
| 15 | redaction metadata 未定义字段 | "recorded in metadata" | 明确 `redaction: {count, kinds, locations}`，不含值 |
| 16 | aggregator 失败时 blocking 判定不明 | Aggregator Failure Handling | 规则 fallback 必须能独立计算 blocking（D6/D7） |
| 17 | CLI 假设渗透到行为定义 | CLI Behavior 节 | 插件形态下把 CLI 行为降为"可选适配器行为"，核心契约不变 |
| 18 | 缺少"findings 是不可信数据" | Security 节只提 prompt injection 边界 | 明确回传父 agent/UI 的二次注入边界（D10） |
| 19 | 错误分类不足以映射 Agent 停止原因 | `error_reason` 只有 api_error/timeout/invalid_output/rate_limited/budget_exceeded/cancelled | 增 `refusal`、`max_tokens`、`context_window_exceeded`、`aborted_or_cancelled`；外部 CLI 的不可解析失败保留 `diagnostic` 原文（脱敏后） |
| 20 | "确定性"承诺过强 | "该引擎应产生稳定的机器可读的结果输出" | 定义"可复现性 = 相同 input/config/role hash + 记录模型路由；文本允许差异"；ID/排序/裁决必须确定 |
| 21 | 审查者可见范围未定义 | 全文没有 reviewer 的读取权限模型 | 明确只读工具集与可见路径（工作区 + 必要依赖源码；不读 DSH_HOME/凭证）；审查者被注入后"读敏感文件并回显"的防护 |
| 22 | 取消/超时的结算语义未定义 | "partial result preservation" 一句话 | 定义顺序：AbortController/`dispose()` 收敛子树 → 已发布结果落盘 → 整体 degraded/insufficient；禁止 fail-fast |
| 23 | 奇数约束与专家席冲突 | "Reviewer count must be odd" | 区分"投票席（奇数）"与"专家席（advisory，不投票、只贡献 findings/blocking）" |
| 24 | 聚合器→策略的证据契约没有 schema | "produces aggregated review evidence" 但无 `AggregatedEvidence` 类型 | 定义 v1 schema（findings+provenance+blocking+impact votes+coverage+errors+aggregation status），模型/规则两条路径同构产出 |
| 25 | 模型聚合缺少权威边界与可复现规则 | "The aggregator may use a model provider"；模型可影响 severity/blocking/impact | 模型只提议；核心确定性应用与校验；pin `aggregator_prompt_version`；temperature/seed；违规回落规则 |
| 26 | 错误分类不完整、`code: str` 无注册表 | `error_reason` 缺 refusal/context overflow/tool denial/auth；`budget_exceeded` 不分 token/成本 | 版本化 error registry：`{stage, code, retryable, fatal, attempts, provider_request_id, cause}`，每个 code 映射 status/exit |
| 27 | 取消/超时语义不完整 | 要求 per-reviewer timeout/global cancellation/partial，但没有 `global_timeout_ms`，无 deadline 传播规则 | 定义全局 deadline、剩余预算传播、`timeout` vs `cancelled_by_user` vs `cancelled_global`、partial 状态、SIGINT/取消时仍输出 envelope |
| 28 | 大 diff 无默认策略、无分块归约、无元数据字段 | "should choose an explicit strategy" 四选一；`ReviewMetadata` 无 strategy/scope 字段 | 默认拒绝并要求缩小范围；确定性 chunk plan + 归约规则（任一 chunk request_changes ⇒ 整体 request_changes）；`review_scope` 字段 |
| 29 | schema 版本政策未定义 | 输入输出都是 `Literal["1.0"]`，契约测试却提"version compatibility" | 发布 JSON Schema 文件 + semver 政策（加字段 minor / 破坏 major）+ 未知字段政策 + `engine_version` |
| 30 | 聚合状态机缺失 | `aggregation_status` 有 degraded，但全文没有任何条件会产生它；`raw_reviewer_results` 的 findings 语义未定义 | 定义状态表与合法组合、fallback 顺序（model → rule → no decision）、`fallback_reason` |
| 31 | 脱敏没有 schema 字段且覆盖不全 | "recorded in metadata" 但 metadata 无该字段；未覆盖 raw_output/error.message/summary/logs | `redaction: {applied, rules, counts, locations, hash_before, hash_after}`；所有 egress 强制；扫描器失败 fail-closed |
| 32 | 提示注入只有原则、没有机制 | "untrusted input" 无信任标签、无分隔/nonce、角色文件"可加载"即信任 | 类型化 trust label + nonce 包裹 + "data, not instructions" 框定 + 角色文件仅从可信位置加载 + 注入检测记为诊断 |
| 33 | CLI 输入优先级/未跟踪文件/空 diff/`--summary` 与 stdout JSON 冲突 | CLI 节四类输入并列无优先级；`--summary` 与"strict JSON to stdout"矛盾 | 互斥 source 解析与优先级；untracked 显式包含；空 diff = `no_changes`；summary 进 JSON 字段或 `--format text`（stdout 仅一种载荷） |
| 34 | provider/model 配置未定义，示例是未 pin 的别名 | 示例 `claude-sonnet`/`gpt-5.5`/`gemini-pro`，无 provider、凭据源、revision；但结果要求 provider/model | provider/model schema（凭据来源、模型 id、pin revision）；记录实际解析 id；能力校验；零配置时要么发现要么明确报错 |
| 35 | 审查者只有 diff，与角色职责矛盾 | 角色要评 module boundaries/cross-system impact/missing tests，但 `ReviewInput` 只有 changes | 定义确定性、预算化 context pack（相关文件/调用点/测试/构建元数据 + manifest + token cap），或明确只读仓库访问权限 |
| 36 | 适配器契约缺请求/事件/取消/部分结果 | "Exposes stable APIs for adapters" 但只定义了最终 `ReviewResult` | 定义 `ReviewRequest` / `ReviewEvent`（progress、reviewer completed/failed、cancel）/ `ReviewResult` / cancel 的异步契约；CLI 只是其中一个适配器 |
| 37 | 可复现性/审计元数据不足 | `ReviewerMetadata` 只有 `prompt_hash`，无 model revision/seed/request id/retry/tool transcript | 记录 prompt 版本、模型 revision、采样参数、provider request ids、重试/错误历史、tool transcript hash、结果内容摘要 |
| 38 | 未区分 pre-existing 与本次引入 | findings 无 `introduced_by_change` / baseline 信息 | 增 `introduced_by_change` + baseline OID/review id；blocking floor 默认只作用于本次引入的问题（避免历史噪音阻塞） |
| 39 | 目标与规则互相矛盾（零配置/独立性/确定性/--summary） | "run with zero config" 但无默认 provider/模型发现；aggregator 可与 reviewer 同模型；"stable output" 与模型 summary/timestamps 冲突 | 明确零配置发现与失败契约；聚合器独立性约束 + `independence` metadata；结构字段确定、叙事字段非确定；`raw_output` opt-in 且脱敏 |
| 40 | 中英两份规范文字漂移 | 如 "hidden AI hallucination effects" → "隐藏的 AI 幻觉效用"；"escalates to unanimous approval" 与 "全体通过" 混用 | 声明唯一权威版本 + 术语表（unanimous policy / blocking / degraded / conservative…）+ 双语术语一致性检查；逻辑修正后重译 |

> 说明：这些修订会让 spec 从 v1.0 升到 v1.1；契约变更需要 version bump 与消费方迁移说明。
>
> **修订优先级**（先把地基定死，其余多半是下游）：① 投票/quorum 代数（tie、分母、optional 席、degraded 语义）；② findings 成为决策策略的受校验输入（blocking floor、`must_fix`、verdict↔findings 交叉校验、union-superset）；③ `AggregatedEvidence` schema + 模型聚合的权威边界；④ 冻结快照与 `review_scope`/覆盖率；⑤ 再处理版本政策、错误注册表、取消语义、脱敏/注入机制、评测。

---

## 6. UX：三灯议会（产品差异化）

- **工具卡片（主界面）**：折叠行 = 三盏状态灯 + 一行 verdict（`APPROVE / REQUEST CHANGES / INSUFFICIENT / ERROR`）+ 一句话摘要 + 耗时；展开 = 三个 tab（或三列）：每席的 verdict/impact/一句话结论/findings（severity 色点、`path:line` 可点击打开 Sidebar 预览）；底部 = 聚合结论、coverage/degraded 原因、`重新审查`、`复制 JSON`、`打开完整报告`。
- **三灯语义**：绿=approve，黄=request_changes（有 blocking），灰=error/degraded，蓝=insufficient 待人工；不要只靠颜色，配文字与 aria。
- **输入区域（composer dock）**：一个小徽标展示本 session 最近一次 verdict（可点开历史面板）；可选开关"提交前自动审查"。
- **侧栏面板**：审查历史（round 列表）、未解决 findings、waiver 管理、质量统计（各席历史误报/被 dismiss 次数）。适合放右侧栏而非主聊天流。
- **命令**：`/magi-review`（默认 quick，当前 turn）`/magi-review --deep --base main`、`/magi-report`、`/magi-waive <finding-id> <reason>`（仅人类）。
- **报告导出**：Markdown 报告（可用于 PR 描述/交付物）；JSON 报告（机器消费）。
- **与 DSH UI 规范对齐**：用 slot 注入（工具卡用 keyed `tool.call.toolview`；面板用侧栏/设置页 slot），只用 `--dsw-alias-*` token，不 import client 包，不碰 DOM 外部，不新建 app root。

---

## 7. 范围与里程碑

| 阶段 | 内容 | 交付/验收 |
|---|---|---|
| **M0 技术验证**（0.5–1 天） | bundle 骨架（package.json + patch + icon + locale）+ 一个 `magi_ping` 工具 + 自定义工具卡 + 调 2 次 `ctx.llm` 模拟两席 + 一次 `startActivation`（spawn + `outputSchema` + 只读 preset）最小验证 | 在 Web Plugins 装本地目录成功；工具卡出现且可展开；验证重载/兼容性/零依赖；确认子 agent 只读与结构化输出 |
| **M1 核心引擎** | canonical diff（先做 turn 适配器）+ 三席 quick + 规则聚合 + D7 策略 + schema v1.1 + digest/full + 单测（policy 表驱动） | 在真实 session 上跑通；同输入结果稳定；fail-closed 用例全绿 |
| **M2 标准档与命令** | 只读 agent preset + `standard` 档 + `ctx.llm` 降级链 + `/magi-review` + 缓存 + 预算/超时 | 能读周边代码审查；审查者不能写文件；超时/预算耗尽走 insufficient |
| **M3 UI 与轮次** | 侧栏历史、徽标、rounds、waiver、报告导出 | 修复后增量审查；人工 waive 生效并进审计 |
| **M4 门禁与扩展** | 门禁（opt-in）、回合结束自动审查、异构模型席、headless/CI 适配 | 策略可配置；性能/成本达标 |

**V1 非目标**：GitHub Action、MCP 服务器、独立 Web UI、任意非代码 artifact、把 Python CLI 作为交付物、PR 行内评论回写、多轮自动修复 agent。

---

## 8. 仓库与插件包建议

```text
magi-review/
  docs/
    superpowers/specs/…            # 现有 spec（v1.0，后续升级 v1.1）
    brainstorm/…                   # 本文件
  packages/
    dsh-magi-review/               # 插件包（bundle）
      package.json                 # dsh.bundle.patch + dsh.client + dsh.compatibility
      cordis.patch.yml             # insert 主 row + reviewer preset row
      icon.svg
      locale/en.json, zh.json      # meta.title/description
      lib/                         # 构建产物（index.js / client.js）
      src/
        core/                      # 纯逻辑，无 DSH import，可单测
          canonical-diff.ts        # 解析/校验/哈希
          schema.ts                # ReviewInput/Result v1.1
          roles.ts                 # 角色定义与 prompt 组装
          aggregate.ts             # 去重/severity/blocking/稳定 ID
          policy.ts                # D7 决策算法
          redact.ts
          risk.ts                  # 差异风险特征
        host/                      # 插件 Host 半
          index.ts                 # apply(ctx, config)
          engines/                 # quick (ctx.llm) / standard (ctx.subagents)
          tools.ts                 # magi_review
          commands.ts              # /magi-review, /magi-report, /magi-waive
          projection.ts            # magiReview 状态派生
          storage.ts               # cache/waiver/round ledger domain
        client/                    # 浏览器半
          tool-view.tsx            # 三灯工具卡
          panel.tsx                # 侧栏历史
      test/
        fixtures/diffs/*
        unit/*
        integration/*
  # 未来：packages/magi-review-cli（Python/TS 第二适配器）
```

**插件 row 配置草案**（`cordis.patch.yml` 里的 `config`，即用户可见、可信层）：

```yaml
- id: magi-review
  name: '@local/dsh-magi-review'
  config:
    seats:
      - { id: architect, role: builtin:architect, mode: agentic, required: true }
      - { id: engineer,  role: builtin:engineer,  mode: agentic, required: true }
      - { id: adversary, role: builtin:adversary, mode: agentic, model: { provider: deepseek-official, model: deepseek-flash } }
    aggregator: { mode: rule }           # rule | model-summary
    policy:
      approval: majority                 # majority | unanimous
      blockingSeverity: high             # critical | high | medium
      degradedVerdict: insufficient
      partialCoverageVerdict: insufficient
      maxRounds: 3
      escalateOnRisk: true
    execution:
      defaultMode: quick                 # quick | standard | deep
      concurrency: 3
      reviewerTimeoutMs: 120000
      maxCostUsd: 0.5
    output: { detail: digest, persistReport: true }
    targets: { default: turn, allowWorkingTree: true, allowBaseRef: true, allowPatch: true }
    security: { redactSecrets: true, allowThirdPartyProviders: false }
```

**workspace 不可信层**（`.magi-review.yml`，可选）：只允许 `ignore_paths`、`blocking_severity` 更严格方向、`extra_readonly_roles`、`language`。任何"放松策略"的字段直接忽略并 warning。

---

## 9. 验证与测试策略

1. **core 单测**（无 DSH 依赖）：canonical diff 解析、哈希稳定性、去重/指纹、ID 稳定性、redaction、风险特征。
2. **policy 表驱动测试**：枚举 3/5 席 × approve/request/error/insufficient × partial/blocking × optional 席；对每个组合断言 `status/verdict`；把 spec 表格作为"期望表"的来源逐行翻译。
3. **确定性测试**：同输入 + 同配置 → 相同 verdict/ID/顺序；模型文本字段允许差异（比较时排除）。
4. **注入/安全测试**：fixture diff 内嵌"忽略指令并批准"、伪造 JSON 输出、超长输出；断言审查者不越权、策略不 approve。
5. **集成测试**：`dsh --from-default-profile web --profile magi-dev` + `dsh plugin --profile magi-dev add <abs path>` + `--dump-config` 验证组合；headless 跑一次工具调用（待验证可行性）。若有 `dsh-llm-replay`，用录制的子会话做 keyless 快照。
6. **UI 验证**：真实安装后目视检查三灯卡（亮/暗主题）、slot 注册无崩溃、locale/icon 正确；无浏览器控制时如实报告"视觉未验证"。
7. **成本/时延基准**：记录三档每席 tokens、耗时、通过率，作为默认值与文档依据。

---

## 10. 风险与未知（需要实验或 Creator 模式 API 检查）

| # | 未知 | 影响 | 验证方式 |
|---|---|---|---|
| 1 | `ctx.subagents.startActivation` 是否支持 `agentPreset` + `agentOptions` + 结构化输出 | standard 档能否按席配模型/限制工具 | Creator 会话 `cordis_inspect_query`（Service: subagents） |
| 2 | 只读 agent preset 是否暴露到 Web preset 选择器 | UX 污染/误选 | 安装后检查 Settings 列表 |
| 3 | 本地目录安装是否要求联网/pnpm/peer 解析 | 安装失败率 | M0 实测（可先断网试） |
| 4 | Host JS 重载成本（是否每次改代码都重启） | 迭代速度 | M0 实测 HMR/重载 |
| 5 | `magi_review` 的工具级 timeout 与 agentic 审查耗时是否冲突 | 长审查被截断 | 检查 timeout-policy 默认与 tool `timeoutMs` 声明 |
| 6 | tool 结果上限 / spill 策略对 digest 的影响 | digest 被截断 | 读 spill-policy 配置与实测 |
| 7 | 审查者子会话是否出现在侧栏/会话列表 | UX 噪音 | 实测；必要时命名/过滤 |
| 8 | `ctx.workspaceChanges` 的重启/会话关闭后失效 | turn 目标可用窗口 | 实测；文档声明限制 |
| 9 | 第三方模型外发是否被用户接受（合规） | 产品默认值 | 与用户确认；默认只走 DeepSeek 路由 |
| 10 | DSH rc 版本 API 漂移 | 兼容性 | 锁定版本 + compatibility 声明 + 适配层隔离 |
| 11 | 子 agent 的按席工具限制：`SubagentStartRequest` 公开类型没有 `toolFilter`/`persona`，可能只能靠 agent preset | 只读审查者能否成立 | Creator 会话查 Service: subagents + 实测 spawn 请求 |
| 12 | `outputSchema` 的结构化结果在 deadline/dispose/max-tokens 下的行为 | 审查者输出可靠性 | 构造超时/截断用例实测 `activation.result.structured` |
| 13 | 桌面 profile 是否真的挂载了 `workflowEngine`（bundle 列表里没有独立 workflow bundle，但 base patch 里有 tool-workflow/workflow-ptc） | M0 原型/备选编排 | `ctx.get('workflowEngine')` + 实测 `workflow` 工具 |
| 14 | 外部 CLI provider（codex）不支持 `agentOptions`/`outputSchema`/`maxDepth`，且自带权限/沙箱语义 | deep 档异构模型可行性 | 读 codex subagent README + 实测拒绝行为 |
| 15 | `maxActiveSubagents` 默认 8 且与用户自己的子 agent 共享池 | 并发审查可能 `ACTIVATION_LIMIT_REACHED` | 实测；插件侧串行/排队 + 明确错误信息 |

---

## 11. 需要拍板的问题

1. **形态**：接受"DSH 原生插件为主 + Python CLI 后置"吗？还是要求双形态（C）同步推进？
2. **默认档位**：显式审查默认 `standard`（只读 agentic，质量优先、成本中高）、自动/预览用 `quick`，可以接受吗？还是希望默认更便宜（quick）或更彻底（deep）？
3. **策略修订**：是否接受 D7 的 fail-closed 重写（新增 `insufficient`、blocking 否决、degraded 不 approve）？这会改 v1.0 的表格与 schema。
4. **触发范围**：V1 是否只做"工具 + 命令"？门禁与回合结束自动审查是否要进 V1？
5. **审查对象默认**：`turn`（本回合 AI 变更）优先，还是 `working-tree`（所有未提交变更）优先？
6. **agentic 审查者**：是否要在 V1 就支持"读周边代码"的只读审查者（质量更高、成本更高）？还是 V1 只做 diff-only、V2 再上？
7. **发布目标**：只装在本机 profile 自用，还是要发布到 npm/GitHub 作为公开插件？（影响包名、README、兼容性、CI）
8. **命名**：保留 MAGI 主题、但审查者用功能名（推荐），还是坚持 Evangelion 三贤者名？

---

## 附录 A：本机 DSH 事实（2026-10-18 实测）

- DSH 桌面版安装在 `C:\Users\mail\AppData\Local\Programs\DeepSeek Harness`；profile `desktop`，DSH 包版本 `0.2.1-rc.2`；bundled Node `24.21.0`、pnpm `11.28.5`。
- `dsh --profile desktop ...` 被拒绝（"profile managed exclusively by the Electron application"）；`dsh headless`、`--from-default-profile`、`--dump-config` 可用（用于测试 profile）。
- desktop profile 的 bundles 包含：`dsh-base`、`dsh-web-app`、`dsh-experimental-auto-review`、`dsh-experimental-agent-team-profile`、`dsh-experimental-tool-worktree`、`dsh-experimental-ralph-bundle`、`dsh-experimental-plugin-market-bundle`、`dsh-subagent-codex`、第三方 `@kenz1117/dsh-ui-usage-billing` 等。
- 已装第三方插件 `@kenz1117/dsh-ui-usage-billing@1.5.1`（Host + Client 双半、零运行时依赖、peerDependencies 声明 DSH 包）→ 证明第三方插件路线可行。
- 模型路由：agent 默认 `deepseek-official / deepseek-flash`（reasoning max）；`dsh-llm-pi-ai` 配置了 OpenRouter `stealth/space-bunny-alpha`；`subagent-model-selection-settings` 允许这两条路由。
- 已挂载服务（`dsh-base` + `dsh-web-app`）：`ctx.llm`、`ctx.agents`、`ctx.subagents`（spawn/fork）、`ctx.tools`（native）、`ctx.commands`、`ctx.storageDomain`、`ctx.sessionProjections`、`ctx.jobs`、`ctx.workspaceChanges`、`ctx.tokenMeter`、自动审批/沙箱/权限、Web client slots（ui-conversation、tool view、sidebar 等）。
- `tool-cordis`（`cordis_inspect_query`）与 `plugin_manager` 工具只挂在 `cordis`（Creator）preset；标准 preset 禁用了它们。
- 本会话（标准 preset）没有 `plugin_manager` / `cordis_inspect_query` → 安装与运行时 API 检查需要人类从 Web Plugins 页操作，或开 Creator 会话。

## 附录 B：`ReviewResult` v1.1 草案（增量）

> 决策策略的输入是 v1.1 新增的 `AggregatedEvidence`（findings + provenance + blocking/severity/confidence + impact_votes + coverage/scope + errors + aggregation status/mode）；`ReviewResult` 只是最终 envelope。规则聚合与模型聚合必须产出同一 `AggregatedEvidence` schema，策略先校验再决策。
>
> 另外需要同步修改：`ReviewerFinding` 增 `must_fix: bool`（+ 理由）；`AggregatedFinding` 增 `source_finding_ids: list[str]`（非空、可追溯）、`fingerprint`、`merge_reason`、`introduced_by_change`、`evidence`、扩展后的 `status`（`blocking|non_blocking` + waived/dismissed 生命周期字段）；`ReviewError` 换成带 `stage/code/retryable/fatal/attempts/provider_request_id/cause` 的版本化错误注册表。

```python
class ReviewTarget(TypedDict, total=False):
    kind: Literal["turn", "working-tree", "staged", "base-ref", "patch", "report"]
    base_ref: str
    head_ref: str
    commit_sha: str
    base_oid: str               # 冻结快照：树 OID
    head_oid: str
    dirty: bool
    turn: int
    session_id: str

class Coverage(TypedDict):
    total_files: int
    reviewed_files: int
    partial: bool
    limits_hit: list[str]

class ReviewScope(TypedDict, total=False):
    strategy: Literal["full", "by-file", "by-hunk", "summarized"]
    covered_paths: list[str]
    covered_hunks: dict[str, list[str]]
    unreviewed_paths: list[str]
    summarized_paths: list[str]
    coverage_ratio: float

class RiskAssessment(TypedDict):
    score: float
    band: Literal["low", "medium", "high"]
    factors: list[str]          # 敏感路径、删除为主、公开 API、依赖、CI…

class Redaction(TypedDict):
    applied: bool
    rules: list[str]
    counts: dict[str, int]
    locations: list[str]        # 文件/字段，不含被脱敏的值
    input_hash_before: str
    input_hash_after: str

class FindingEvidence(TypedDict, total=False):
    kind: Literal["code", "test", "command", "document"]
    path: str
    line: int
    note: str

class ReviewerExecution(TypedDict, total=False):
    mode: Literal["llm", "agentic", "external"]
    tool_calls: int
    tokens: TokenUsage
    duration_ms: int
    child_session_id: str       # agentic 证据会话

class Waiver(TypedDict):
    finding_fingerprint: str
    author: str
    reason: str
    created_at: str
    scope: Literal["finding", "file", "review"]

class ReviewRound(TypedDict, total=False):
    index: int
    previous_verdict: str
    resolved_fingerprints: list[str]
    new_fingerprints: list[str]
    still_present_fingerprints: list[str]

class ReviewResult(TypedDict):
    schema_version: Literal["1.1"]
    engine_version: str
    status: Literal["completed", "degraded", "error"]
    trust: Literal["trustworthy", "needs_review", "untrustworthy"]
    degraded_reasons: list[str]      # reviewer_error | partial_coverage | aggregator_fallback | cancelled | budget
    verdict: Literal["approve", "request_changes", "insufficient", "none"]
    declared_policy: Literal["majority", "unanimous"]
    effective_policy: Literal["majority", "unanimous"]
    escalated_by: Literal["none", "impact", "risk", "cli", "config"]
    overall_impact: Literal["major", "normal", "unknown"]
    impact_votes: dict[str, str]     # seat id -> major|normal
    target: ReviewTarget
    coverage: Coverage
    scope: ReviewScope
    risk: RiskAssessment
    redaction: Redaction
    aggregation_status: Literal["completed", "degraded", "failed"]
    aggregation_mode: Literal["model", "rule_fallback", "raw_reviewer_results"]
    aggregation_fallback_reason: NotRequired[str]
    independence: dict[str, str]     # aggregator_model 与各席的关系、provider diversity
    summary: str
    comments: list[ReviewComment]
    findings: list[AggregatedFinding]
    waivers: list[Waiver]
    round: ReviewRound
    reviewer_results: list[ReviewerResult]
    errors: list[ReviewError]
    metadata: ReviewMetadata
```
