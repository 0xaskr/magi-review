# 实现说明（0.2.0）

依据 [DSH 原生设计 v1.1](superpowers/specs/2026-10-18-magi-review-dsh-native-design-zh.md)，以当前源码为实现事实。兼容基线 DSH 0.2.1-rc.5（未变）；该版本的 `tools.register` / `tools.guard`（含 `output.schema` / `render` / `presentationMeta` / `timeoutMs`）、`commands.register`、`subagents.startActivation` 规格、`agent/created`、`subagent/descriptor`、`llm` 的 `listProviders` / `listModels` / `stream`、session 的 `snapshotEvents` / `seq` 与 `modelSelection` 投影、client 的 `tool.call.toolview` 均已复核并与之匹配。0.2.0 的交互式命令还依赖 DSH `userQuestions.ask`；Git 侧使用只读的 `merge-base`、`cat-file commit`（读取原始第一父提交，避免浅克隆边界被误判为根）、`hash-object -t tree`（空树）与有界 `for-each-ref`/`log` 列表。配置和用法见 [README](../README.md)，威胁边界见 [安全说明](security.md)。

## 模块地图与数据流

| 模块 | 职责 |
|---|---|
| `lib/index.js` | 注册工具/命令；绑定调用来源；处理 `--help`/`--report`；无参数时调用 `prepareCommandReview` 进入范围问答；保存卡片投影；在 `agent/created` 时为 `origin:'subagent'` 子会话安装 reviewer guard。 |
| `lib/host/command.js` | 命令参数解析、help 文本、无参数范围问答（未提交/基线分支/单次提交/自定义要求 + 取消）；不调用模型。 |
| `lib/client.js` | 宿主 `tool.call.toolview` 中的 `magi_review` 卡片，匿名占位与最终揭示态。 |
| `cordis.patch.yml` / `lib/restrict.js` | 单一 `magi-review` Host row（不注册 reviewer preset）；按持久化 descriptor label 执行 deny-by-default 的阶段白名单 guard。 |
| `lib/host/config.js` | 默认值、可信配置校验、模型目录约束、pin 与同构判定。 |
| `lib/host/git.js` / `session-context.js` | 只读 Git 能力：working-tree/staged/base-ref/branch/commit/turn/patch 快照、有界本地分支/提交列表、哈希、覆盖率；最近用户意图与交付声称。 |
| `lib/host/orchestrator.js` | 参数与范围校验、`instructions`→`reviewInstructions`、来源、路由、脱敏、diff 预算、clerk、引擎、工作区护栏、存储；构造卡片与命令 Markdown。 |
| `lib/host/clerk.js` / `llm-json.js` | 会前范围说明与模型分配；流式文本聚合、JSON 调用/校验、目录及默认路由解析。 |
| `lib/host/prompts.js` / `protocol.js` | nonce 数据分区、阶段提示、JSON 字段白名单、seatRef/round 绑定与纪要约束。 |
| `lib/host/seat.js` | 一次 activation 的创建、结果等待、超时、取消、dispose；迟到 activation 也清理。 |
| `lib/host/council.js` / `quick.js` | 阶段调度、重试、匿名材料、讨论终止、密封收票、规则裁决、揭示、纪要和估算 usage。quick 复用引擎并跳过讨论/纪要。 |
| `lib/host/guard.js` / `store.js` / `errors.js` | 工作区指纹比较；不可变 JSON 报告及可重建索引；阶段错误转换。 |
| `lib/core/*` | diff、指纹、证据聚合、裁决、风险、匿名、脱敏、摘要、模板纪要等纯逻辑。 |

```mermaid
flowchart TD
  E[工具 / 命令] --> S[冻结快照 + 会话意图（含 reviewInstructions）+ 脱敏 + diff 预算]
  S --> C[clerk 范围说明 / 模型分配]
  C --> B[briefs 独立陈词（只读白名单）]
  B --> D[匿名 docket]
  D --> M{mode}
  M -->|council| X[discussion 每轮新建子 agent]
  M -->|quick 只带本席材料| V[ballots 密封表决]
  X --> V
  V --> P[聚合证据 + decide 规则裁决]
  P --> R[reveal 身份 / 模型 / 票]
  R --> N[council minutes 或模板回退]
  N --> G[工作区护栏 + 输出脱敏]
  G --> T[store 完整 JSON]
  T --> O[digest / 卡片 / 命令 Markdown]
```

quick 在 reveal 后直接进入护栏和存储；失败阶段的处理见下表。工具传 `args.__invokedAs='tool'` 和 `deps.invokedAs='tool'`；命令传 `deps.invokedAs='command'`。`runReview` 优先读 args 来源，再读 deps；来源不是公开参数，不由模型选择。

## 关键决策与理由

1. **纯 ESM、零 bare import。** `lib/` 同时是源码与交付文件，用运行时校验表达契约；只静态导入相对模块与 `node:` 内置模块。这样本地 bundle 位于 app.asar 外时，不依赖 DSH npm 包的解析链。Client 通过 `window.__ModuleLoader__` 获取宿主 React。
2. **每个阶段一次性子 agent。** DSH 的 `sendMessage` 在旧子 agent settle/dispose 后会冷恢复，默认父通知可能泄露票与立场。当前每席陈词、每轮讨论、最终表决均单独 `startActivation`，`delivery:'caller'`，收结果后 dispose。使用设计 §4.4 允许的降级路径，代价是重复上下文和更高延迟。
3. **表决用阶段 guard 禁用全部工具。** 子 agent 加入调用者自己的 mode，继承的工具面可能包含写/执行工具，实际边界在 `lib/restrict.js`。`index.js` 在工具 dispatch 时读取持久化 descriptor label，`magi-ballot-*` 或未绑定阶段时拒绝全部工具，包括 `structured_output`。票通过文本 JSON 提交，不能只靠 persona 声称“只读”。
4. **匿名 docket 从白名单重建。** `core/anonymity.js` 逐层挑选 findings/location/evidence 字段，并清洗已知身份；`council.js` 再净化配置中的真实席位、视角、provider/model。公开 digest 和卡片受 reveal 闸门约束，票收齐后才裁决；平台 catalog 可见性不在此边界内。
5. **deny-by-default guard 是工具边界的硬约束。** 不再有 MAGI preset 收窄注册工具；`restrict.js` 在 dispatch 前按阶段 label 白名单执行，父级后来注册的工具也默认拒绝。阶段白名单：`magi-brief-*` 允许 read/grep/glob/lsp/structured_output；`magi-discussion-*` 在同一列表上按平台加 bash 或 pwsh，`discussion.allowScripts:false` 时去掉 shell；`magi-ballot-*` 为空列表。Host 的 `agent/created` 钩子只对 `origin:'subagent'` 且有 descriptor 的子会话补装 guard；标签不属于 `magi-(brief|discussion|ballot)-*` 的子会话（其他插件启动的子 agent）不处理，带 parentSession lineage 但 `origin` 不是 `subagent` 的 fork 根会话也不处理。标签不可读或尚未绑定时 fail-closed。组合阶段模块加载失败仍会导致启动失败，guard 无法修复。
6. **文件存储。** 避免 storageDomain/zod 的运行时包导入。`store.js` 先写同目录临时文件，再以 hard link 原子发布不可变报告，已存在的 reportId 不覆盖；可变索引/cache 通过 rename 更新。进程内写队列串行，索引可扫描报告重建；跨进程 cache 更新仍未协调。
7. **Git 使用 `node:child_process.execFile`。** 用参数数组执行只读命令，避免依赖尚未稳定的 `ctx.subprocess` 调用形态及 shell 字符串拼接。差异读取关闭 ext-diff/textconv，记录 OID/patchHash 和未跟踪文件原字节摘要。讨论中的 shell 则仍走 DSH 工具与父会话权限。
8. **双输出通道。** 模型文本走小摘要；卡片走 `presentationMeta` 的白名单 JSON。DSH 深拷贝会破坏对象身份，入口按 reportId 缓存投影（最多 128 项），full 结果还可自行重建投影。UI 无中间 projection，因此运行中只显示匿名占位。
9. **命令交互与范围语义（0.2.0）。** 无参数调用先通过 DSH `userQuestions.ask` 选择四项范围（未提交、基线分支、单次提交、自定义要求），另有取消；取消或问答不可用时不调用模型。带参数或自然语言要求时直接执行，未指定范围默认 `working-tree`，不再默认 `auto`。`--base` 改为分支评审：比较基线分支与捕获 HEAD 的 merge-base 到 HEAD，不含未提交改动；旧的“引用与工作区比较”保留为 `--target base-ref --base <ref>`。`--commit` 比较提交与其第一父提交，根提交相对空树。`--staged`、`--target auto|turn|working-tree` 作为高级选项保留。范围选项互斥，重复参数、冲突范围、`--report`/`--help` 与评审参数组合均报错。
10. **自然语言要求不改变冻结范围。** 命令行中的非参数文本（或 `--` 之后的文字）写入 `intent.reviewInstructions`，随会话意图进入 clerk 与各席 brief 提示；范围始终由参数或交互选择决定，要求文本不能扩大或缩小已冻结的 diff。`--detail` 只从命令移除（命令固定输出报告），工具保留 `detail`，完整 JSON 通过 reportId 获取。
11. **显式 turn 失败不静默换范围。** 显式 `target=turn` 在会话没有回合快照（或读取失败）时返回 `TURN_UNAVAILABLE`/快照错误，不再退回工作区；只有 `auto` 保持旧的降级回退。这样调用者显式选择的语义不会被悄悄替换。

## 模型选择

reviewer 席位的默认路由来自 DSH 的子 agent 模型选择设置（`ctx.get('subagentModelSelection').current()`）。设置启用且 `allowedModels` 非空时，这些精确的 provider/model 路由构成 reviewer 池；未显式配对时，池的首条路由成为本次评审的实际 `models.defaultRoute`，书记官的席位分配提案与确定性回退都在该池内解析；池内路由当前都不可用时返回 `MODEL_ROUTE_UNAVAILABLE`。设置缺失或未启用时回退旧的 `models.defaultRoute` 解析（默认 `deepseek-official/deepseek-flash`），不会静默换模型。

`magi_review` 新增可选 `provider` + `model`（命令对应 `--provider` / `--model`，解析器强制成对）。它们必须精确匹配允许路由之一：设置未启用返回 `MODEL_SELECTION_DISABLED`，路由不在允许列表返回 `MODEL_ROUTE_NOT_ALLOWED`；显式配对覆盖该次调用的 `seats[].model` pin，所有 reviewer 席位临时 pin 到该路由，该路由当前不可用返回 `MODEL_ROUTE_UNAVAILABLE`。参数类型/配对错误统一返回 `INVALID_ARGS`。

书记官刻意不进入 reviewer 池，它使用父会话当前运行的模型：优先读取 DSH `modelSelection` 会话投影的 `lastUsed` / `pending`，投影未注册时回退为折叠 `model/selection` 与 `request/header` 事件。优先级为 `clerk.model` 显式 pin → 会话模型 → 默认路由解析。orchestrator 把书记官的席位分配与确定性回退收敛到 reviewer 池，而书记官自身的路由取自会话。

## 与设计的偏差、原因及补齐方向

| 设计目标 / 当前实现 | 为什么 | 未来如何补 |
|---|---|---|
| TS + src/构建目录 → 纯 JS ESM + lib/ | 零构建、零运行时包解析风险；已有协议运行时校验。 | 需要静态契约时先增强 JSDoc/独立类型检查，保持 bundle 无运行时依赖。 |
| MAGI 自带 reviewer preset 收窄工具面 → 子 agent 加入调用者 mode，由阶段 guard 限定工具 | 取消两套 reviewer preset 后，子会话不再作为 MAGI mode 出现在 DSH 新建任务的选择器；继承机制更简单，但结构保证变弱：写/执行工具可能出现在继承 schema 中，仅由运行期 guard 拦截。 | 平台提供子 agent 工具面隔离或稳定 preset 注入机制后，可恢复组合级限制。 |
| 目录内按成本/异构分配 → reviewer 路由优先取 DSH 子 agent 模型选择池；书记官跟随会话模型 | 用户已通过 DSH 设置表达子 agent 模型偏好，插件不应越过该策略；书记官是记录者，与会话同路由更自然。 | 设置支持按角色/工具细分路由后，再考虑 reviewer 与 clerk 的独立映射。 |
| 同席连续讨论/表决 → 每阶段新子 agent，文本 JSON 最多重试一次 | 冷恢复的父通知无法可靠维持秘密表决。 | 平台支持持久化 caller delivery 和稳定续聊结果通道后，再验证复用；保留一次性回退。 |
| 书记官选范围 → Host 先冻结范围，clerk 解释且不得扩张 | 显式参数、快照哈希和脱敏预算需要确定输入。 | 增加“候选范围提案 → 校验 → 冻结”的独立流程，确保模型不能扩大可信权限。 |
| 命令 `--base` 旧语义（引用与工作区）→ 0.2.0 分支评审（merge-base → 捕获 HEAD，不含未提交） | 对齐 Codex `/review` 的心智模型；避免把用户脏工作区混入分支评审。 | 旧语义保留为 `--target base-ref --base <ref>`；继续在帮助与迁移说明中强调差异。 |
| 无参数交互依赖 DSH `userQuestions.ask` → 非交互入口要求显式参数 | 子 agent、委派入口不能可靠弹出问答；静默替用户选择范围的风险更高。 | 平台提供稳定交互通道或来源标识后，再评估非交互默认；当前直接报错并提示参数。 |
| `--commit` 相对第一父 → 合并提交只与第一父比较，不另生成相对第二父的差异 | 包含合并结果相对第一父新增的内容，包括从第二父合入的变更；不使用 combined diff。 | 需要按每个父提交分别审查时可传 patch；未来可增加显式父提交选择。 |
| 命令 `--detail` 移除 → 工具保留 `detail` | 命令固定输出 Markdown 报告，避免参数组合膨胀；完整 JSON 可按 reportId 读取。 | 若确有命令侧需求，单列输出参数与截断预算。 |
| 按视角裁剪完整文件上下文 → 各席同一份按文件边界裁剪的 diff，视角由提示区分 | 保证共同证据基础，先解决大工作区超时和覆盖记录。 | 增加可审计的 context manifest、文件包/分批计划及覆盖合并。 |
| 原设计 brief/round/ballot/total 为 120/90/30/600 秒 → 240/180/60/1800 秒；diff 预算 16000 tokens | 既有真实运行暴露超时，M2d 已调整默认值。 | 建立 3/5/7 席成本与时延基线后再调参。 |
| 人工确认统一默认 300 秒 → orchestrator 未显式配置时 120 秒；仅命令询问 | 工具路径无法可靠获取人工回答，等待拖延评审。config.js 尚保留旧 300 秒默认。 | 统一归一化与编排默认值；平台具备稳定交互后重新评估工具询问。 |
| DSH 全局容量超限排队 → 本地按 concurrency 分批，启动失败按单席错误处理 | 没有接入共享子 agent 容量队列。 | 增加有总截止时间的容量重试/等待，不泄露各席状态。 |
| 不可达模型自动切换默认路由 → 分配时可回退；执行失败目前重试同一路由 | 目录可见不代表凭据/额度有效；`turn()` 未实现跨路由重选。 | 实现受 provider 策略约束的一次换路由重试，记录实际模型与 `model_fallback`，做真实异构验收。 |
| 表决失败沿用最后有效讨论立场 → 当前回退首轮 brief | DiscussionResponse 没有完整最终 verdict/findings 替换协议，无法可靠重建最终立场。 | 增加受绑定和校验的立场快照，失败时沿用最近一份，并测试新增发现不被遗漏。 |
| storageDomain/profile 隔离 → 文件 JSON，环境变量决定 namespace，通常为 default | 避免 bare import；入口没有可靠 profile 名来源。 | 通过稳定运行时 profile API 注入 store root；增加迁移/保留策略。 |
| 缓存命中直接复用 → store 有 cache API，但 orchestrator 不读写缓存 | 主流程尚未接入完整版本化缓存键。 | 接入 snapshot/模型/席位/policy/prompt 版本键及跨进程协调，再开放缓存命中声明。 |
| 完整 JSON 命令导出/目录导出 → `--report` 返回 ≤20 KiB Markdown，JSON 从磁盘读取 | 目前命令只接渲染函数，`exportMarkdownDir` 尚无写出逻辑。 | 明确定义导出格式与目标路径权限，再新增独立导出能力。 |
| 实时匿名进度 → 运行中匿名占位 | 工具结果只在完成时提供卡片数据，未注册中间 projection。 | 加只含阶段/匿名状态的查询或投影，测试不能泄票。 |
| 精确 usage/美元预算 → 字符数估算，缺少完整 provider usage/价格 | seat 适配层不透传可靠 token/价格；美元阈值只能消费已有数据。 | 透传真实 usage/价格，含 clerk/minutes/重试费用，增加硬预算和成本基准。 |
| 全过程平台级匿名 → 插件数据面匿名，平台子会话仍可被发现 | DSH catalog/session log 可见性不是 bundle 可控制的权限。 | 平台增加私有子会话/延迟公开；届时验证 catalog、侧栏和通知链。 |
| 所有入模数据脱敏 → Host 扫描自己组装的数据与返回结果 | 审查者通过 read/shell 直接读取的内容仍走 DSH，不经过 Host 扫描器。 | 平台增加工具结果脱敏/秘密路径策略；扩展规则与漏检测试。 |
| 首次第三方外发提示、工作区配置 provenance、匿名开关 → 尚未接入；主流程固定裁决后揭示 | 当前只消费可信 profile 配置；未构建设置 UI/工作区配置入口。 | 增加明确的数据流提示与 provenance；配置开关必须与实际隔离能力一致。 |
| 每阶段完整证据会话引用 → 最终公开结果主要保留 brief childSessionId | 讨论/表决适配返回 childId，但引擎未把它们全部持久化进审计索引。 | 裁决后保存全部阶段会话定位，依旧不在中途暴露。 |
| 同步 session API → 仍使用已废弃的 snapshotEvents 等，并有 deriveMessages 兜底；`modelSelection` 优先读投影，投影缺失时折叠事件 | 当前兼容版本与既有模块契约要求；长会话已补回溯边界。 | 迁移到异步事件读取 API，并覆盖长会话/重启恢复。 |

`anonymity.revealInReport`、`anonymity.auditLedger`、`execution.cache`、`models.fallbackOnError` 等配置的存在不代表完整设计能力已接通。5/7 席若未显式配置额外视角，自动补 general；目前也没有专门的席数成本告警。

## 失败降级矩阵与实现位置

| 触发点 | 当前处理与结果影响 | 实现位置 |
|---|---|---|
| 非法参数/配置、无差异 | 返回 `ok:false`；参数类型/配对错误为 `INVALID_ARGS`，无差异为 `NO_CHANGES`，不调用 reviewer。 | `orchestrator.js: validateArgs/runReview`，`config.js: validateConfig` |
| 模型选择设置关闭、路由不在允许列表、允许路由都不可用 | 显式 `provider`/`model` 分别返回 `MODEL_SELECTION_DISABLED` / `MODEL_ROUTE_NOT_ALLOWED`；池内无可用路由或显式路由当前不可用返回 `MODEL_ROUTE_UNAVAILABLE`；均不发起 reviewer 调用。 | `orchestrator.js: runReview`，`llm-json.js: subagentModelPool` |
| 显式 `target=turn` 无回合快照或读取失败 | 返回 `TURN_UNAVAILABLE` 或该快照错误，不退回工作区。 | `orchestrator.js: runReview`，`git.js: turnSnapshot` |
| `auto` 的 turn 回退不可用 | 降级到 `working-tree`，记录 `turn_unavailable`；空快照可能返回 `NO_CHANGES`；缺文件标 partial。 | `orchestrator.js: runReview`，`git.js: turnSnapshot/snapshotReview` |
| 命令无参数问答取消或入口不可用 | 取消返回“已取消”，不调用模型；入口无法问答时报错并提示显式参数，不静默选择范围。 | `command.js: prepareCommandReview`，`index.js: handler` |
| `branch`/`commit` 快照读取失败或 ref 无效 | 返回快照/Git 错误，不伪造 clean 结果；`branch` 需要已提交 HEAD，`commit` 需要可解析提交。 | `git.js: snapshotReview` |
| 输入脱敏失败 | `REDACTION_FAILED`，停止且不调用模型。 | `orchestrator.js: redact/runReview` |
| 书记官调用/JSON 无效 | 使用冻结范围和确定性模型分配，`clerk_fallback`，有效证据仍可裁决。 | `clerk.js: runClerk`，`orchestrator.js: runReview` |
| 单席陈词失败、非法响应、超时 | 最多两次尝试且受总截止时间约束；该席 error，其余继续；`reviewer_error:<seatRef>`，可能不足 quorum。 | `council.js: turn/briefs`，`seat.js: runSeatTurn`，`protocol.js` |
| 单席讨论失败 | 缺失回应不证明稳定；保留已有材料，记录 `discussion_missing:<seatRef>`，仍尝试最终表决。 | `council.js: discussion/previous/latest` |
| 轮次到顶且人工回答缺失 | 工具直接表决；命令限时询问，缺失则 `human_confirmation_missing`；继续只追加有限轮次。 | `council.js: askHuman/round_cap`，入口来源由 `index.js` 绑定 |
| 单席表决失败 | 使用该席 brief 的票与 findings，记录 `ballot_missing:<seatRef>`。 | `council.js: ballots` |
| 重复/伪造票、全部席位失败 | 重复票使该席失效；全部无效为 `none/error/untrustworthy`，不伪造 quorum。 | `core/policy.js: decideWithPolicy`，`protocol.js: bindSeat` |
| partial/取消/预算用尽 | 停止后续工作，保留已完成证据；partial/interrupted 禁止 approve；前置阶段取消可能直接返回错误。 | `prompts.js: budgetSnapshot`，`council.js: stopped/reserveInput`，`core/policy.js` |
| 纪要失败/越权/非法 JSON | 模板纪要，`minutes_failed` 或 `minutes_invalid`；不改变规则 verdict。非法输出只留有界校验诊断，不存原始回复。 | `council.js: minutesCause/纪要阶段`，`protocol.js: validateMinutes`，`core/minutes-template.js` |
| 评审中工作区变动 | `workspace_mutated_during_review`；降级且把原 approve 改为 insufficient。指纹不可得则 `workspace_guard_unavailable`。 | `guard.js`，`orchestrator.js: degradeResult` |
| 席位/纪要/最终结果脱敏失败 | 席位输出扫描失败中止后续模型工作；最终结果扫描失败不返回/存储该报告。 | `council.js: scrub`，`orchestrator.js: 输出 redact` |
| 存储失败 | 保留内存结果，`storage_failed` + `STORAGE_FAILED`；不保证 reportId 可检索。 | `store.js: saveReview`，`orchestrator.js: store/degradeResult` |

错误与叙事不是指令；失败不授权扩权或执行 findings 内的命令。覆盖这些行为的自动测试和历史运行结果见 [验证记录](verification.md)。
