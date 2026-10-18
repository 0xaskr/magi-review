# MAGI Review 设计文档 v1.1：DSH 原生议会式审查

- 文档状态：设计稿（待审）
- 日期：2026-10-18
- 语言：中文为当前权威版本；英文版后置同步
- 取代关系：本文档取代 [2026-06-12 设计文档](2026-06-12-magi-review-design-zh.md) 中关于实现形态的假设（Python、CLI-first、自建 provider 层），用于 DeepSeek Harness（DSH）实现。旧文档保留为"引擎契约与设计理由"参考。
- 决策来源：本文件第 16 节的决策记录（与产品负责人的逐项确认）。

---

## 1. 产品定位与理念

### 1.1 一句话

`magi-review` 是一个运行在 DeepSeek Harness 里的**议会式审查系统**：多个模型/多个视角独立审查同一个对象，经过议会讨论后独立表决，由确定性规则裁决，书记官模型撰写纪要。

### 1.2 理念（不可动摇的部分）

1. **多视角，而不是多次重复**：每个席位有独立的视角、上下文范围和取证方式，不是同一提示词跑 N 遍。
2. **独立陈词**：第一轮各席互不可见，保证原始判断不被锚定。
3. **过程全匿名**：从陈词之后的讨论、回应、表决到计票，席位一律以 A/B/C 出现；任何"身份/角色/模型 ↔ 立场/票"的对应关系，在规则裁决确定之前都不对任何一方披露（包括席位之间、主持人中间产物、用户界面与调用方）。
4. **秘密表决**：各席并发密封提交，收齐前不披露任何票、不中途计票；各席看不到他人的最终票，避免从众与策略性投票。
5. **裁决后揭示**：规则裁决一旦确定，立即解除匿名，最终结果与 UI 呈现每席的真实身份、模型、首轮与最终立场、改票理由——**匿名只保护过程，不保护结论后的可追溯性**。
6. **规则裁决**：通过与否由确定性规则从最终票与证据计算，任何模型（包括主席）都不能改变裁决。
7. **纪要非裁判**：书记官只写"议会记录"，不产出建议、不影响结果。
8. **可解释的 dissent**：少数派意见、改票理由、争议点必须原样保留并呈现。
9. **对象无关**：议会流程与审查对象解耦；代码变更是第一个对象（code-change），未来可审计划、文档、回答（artifact-agnostic）。

### 1.3 可降级的部分（允许，但必须标注）

- **模型多样性**：理想是异构（不同厂商/模型族）。环境不足时允许同构议会，但结果必须显式标注 `homogeneous`，不得暗示独立性。
- **讨论轮次**：默认最多 3 轮；终止条件满足即提前结束；3 轮未结束转人工确认（可配置）。
- **席位数**：默认 3，可配置 3/5/7（奇数，全部为投票席）。

### 1.4 非目标（V1）

- 不做门禁（commit/push/交付前拦截）与回合结束自动审查。
- 不做 GitHub Action、PR 行内评论回写、MCP 服务器。
- 不做独立 Web UI；只做 DSH 聊天内的工具卡与命令结果。
- 不实现 code-change 之外的 artifact kind（只保留接口）。
- 不做自动修复循环（review → fix → re-review 由调用方/agent 自行驱动）。

---

## 2. 术语

| 术语 | 含义 |
|---|---|
| **议会（council）** | 本次审查的席位集合与流程 |
| **席位（seat）** | 一个带视角、模型、工具集的审查者；奇数、全部为投票席 |
| **书记官（clerk）** | 会前定范围/分配模型、会后写纪要的角色；不投票、不裁判 |
| **陈词（brief）** | 席位在隔离状态下的首轮报告 |
| **议事材料（docket）** | 书记官/主持人把各席陈词匿名化后合成的讨论材料 |
| **表决（ballot）** | 讨论后各席的秘密最终投票（可改票，需理由） |
| **匿名票（sealed ballot）** | 过程内以 A/B/C 引用席位、收齐前不计票不披露的票；身份映射只存在于插件内部 |
| **揭示点（reveal）** | 规则裁决确定的瞬间：此后才解除匿名、把票与立场映射回真实席位/模型 |
| **裁决（verdict）** | 规则计算的通过与否：`approve / request_changes / insufficient / none` |
| **纪要（minutes）** | 书记官撰写的议会记录，非权威、无建议字段 |
| **artifact** | 被审查对象（V1 只有 code-change） |

---

## 3. 架构

### 3.1 交付形态

一个 DSH bundle 包，包含三部分：

```text
dsh-magi-review/
  package.json            # dsh.bundle.patch + dsh.client（V1 含三灯卡）
  cordis.patch.yml        # 主插件 row + 两个审查者 preset row
  icon.svg
  locale/{en,zh}.json     # meta.title / meta.description
  lib/index.js            # Host 半构建产物
  lib/client.js           # Client 半构建产物（三灯卡）
  src/
    core/                 # 纯逻辑，不 import DSH，可独立单测
    host/                 # apply(ctx, config)：工具/命令/议会编排/存储/投影
    client/               # 三灯卡组件
```

- Host 半为 `apply(ctx, config)` 形式，`inject` 声明必需服务，可选服务用 `ctx.inject([...])`。
- 不新增 session event type；审查事实落在 tool/command 事件、子 agent 会话与 storage domain 中。
- 零运行时 npm 依赖（仅 Node 内置 + DSH 服务），降低本地安装与迭代失败率。

### 3.2 依赖的 DSH 能力

| 用途 | DSH 机制 |
|---|---|
| 入口 | `ctx.tools.register`（`magi_review`）、`ctx.commands.register`（`/magi-review`） |
| 审查者执行 | `ctx.subagents.startActivation`（spawn provider，本地子 agent，可继续） |
| 审查者工具集 | agent preset（`@deepseek-ai/dsh-agent-preset`）两套：只读 / 可验证 |
| 快照与 diff | `ctx.workspaceChanges`（回合快照）+ `ctx.subprocess`（git） |
| 模型调用/路由 | `ctx.llm`（模型目录、provider、调用）；书记官与 quick 档使用 |
| 运行控制 | `AbortSignal`、subagent `dispose()`、工具级 `timeoutMs`、`ctx.jobs`（可选） |
| 存储 | `ctx.storageDomain`（审查记录、缓存、报告） |
| UI | Client `tool.call.toolview`（三灯卡）；命令结果走文本/Markdown |
| 审计 | 子 agent 会话（陈词/讨论/表决的全过程日志）+ tool/command 事件 |
| 权限 | 继承父会话策略；委托子 agent 审批固定 `never` |

### 3.3 数据流

```text
入口（工具 / 命令）
  -> 书记官：读会话上下文（任务、agent 声称、回合变更、git 状态）
       -> ReviewScopeProposal（审什么/范围/文件）+ 模型分配（三席各用什么）
       -> 自动确认（范围与理由入报告；调用方可用显式参数覆盖）
  -> Phase 1 陈词：N 个只读子 agent 隔离审查冻结快照
       -> SeatBrief[]
  -> 主持人（规则）：匿名化陈词 -> docket
  -> Phase 2 讨论（council 模式）：可验证子 agent（只读 + 脚本）
       3 轮上限 / 立场稳定即结束 / 3 轮未结束请人工确认
       -> 每轮 DiscussionRound；允许新 finding、允许改票并记录理由
  -> Phase 3 表决：各席秘密提交最终票（看不到他人票）
  -> 规则裁决：quorum + blocking 否决 + degraded/insufficient 语义
  -> 书记官：纯纪要（共识/争议/改票/未决，不含建议）
  -> 输出：工具返回 digest / 命令返回纪要 + 报告；完整 JSON 落 storage
```

---

## 4. 议会流程

### 4.1 状态机

```text
quick 模式:
  clerk -> briefs -> ballots -> verdict ──▶ reveal

council 模式:
  clerk -> briefs -> discussion(round 1..N) -> ballots -> verdict ──▶ reveal -> minutes
                        │
                        ├─ 每轮后判定"立场稳定" -> 提前进入 ballots
                        └─ 达到轮次上限仍未稳定 -> 人工确认
                              ├─ 继续讨论（追加轮次，可配置增量）
                              └─ 直接进入 ballots

匿名区间: briefs 之后的全部过程（讨论、回应、表决、计票、中间进度）一律 A/B/C 匿名；
          收齐所有票之前不计票；只有 reveal（裁决确定）之后才允许映射身份、署名纪要、展示归属。
```

### 4.2 会前：书记官（Clerk）

**职责**（一次模型调用）：

1. 读取会话上下文：本回合/最近若干回合的用户请求、agent 的最终回答与交付声明、变更文件、git 状态。
2. 产出 `ReviewScopeProposal`：artifact kind、target（turn / working-tree / base-ref / staged / patch）、基线、文件清单、范围理由、置信度。
3. 产出 `ModelAssignment`：每席的 provider/model 与分配理由（见 5.2）。

**确认语义**：自动确认并开审；范围、模型分配与理由写入结果。调用方可显式覆盖范围（工具/命令参数优先于书记官）。模型分配规则：配置中 `seats[].model` 显式指定的席按配置固定；未指定的席由书记官在约束下分配（见 5.2）。

**失败降级**：书记官失败或输出非法时，使用确定性默认范围（工作区 vs HEAD；工作区干净则最近一个顶层回合）与默认席模型，标记 `degraded_reasons: ["clerk_fallback"]`。

**书记官的模型**：默认跟随当前 DSH agent 默认模型，可配置（`clerk.model`）。书记官不投票、不参与讨论。

### 4.3 Phase 1：独立陈词

- 每个席位在**独立子 agent**中运行，互不可见；输入为同一份冻结快照 + 按视角裁剪的上下文包 + 不可信的意图上下文。
- 工具集：只读 preset（`read`/`grep`/`glob`/`lsp`），**不含 shell**。
- 输出严格遵循 `SeatBrief` schema：verdict、impact、findings（含 mustFix/置信度/证据）、一句话立场、取证说明。
- 失败：该席 `status=error` 并记录原因，其余席继续；不 fail-fast。

### 4.4 Phase 2：议会讨论（council 模式）

- 主持人由**规则**担任（不做模型主持）：把各席陈词匿名化为 A/B/C 的 docket，只共享结构化结论与证据，不共享私有推理链与工具轨迹。
- **席位实例化**：陈词阶段每个席位使用只读 preset 的独立子 agent；进入讨论时为该席新起一个可验证 preset 的子 agent，输入 = 它自己的首轮 brief + 匿名 docket + 视角约束。后续讨论轮次与该席表决在同一子 agent 内通过父→子消息继续，保证讨论证据连续；陈词子 agent 在产出 brief 后即可释放。这样"陈词阶段无 shell、讨论阶段才可执行脚本"由 preset 强制保证，而不是靠提示词。
- 各席在**可验证子 agent**中参与讨论：仅只读 + 可执行脚本（沿用 DSH shell 工具与沙箱，继承父会话策略，审批 `never`）。
- 每轮每席输出 `DiscussionResponse`：
  - 对其他席主张的同意/反对与理由；
  - 是否改变立场（verdict/findings），若改变给 `changeReason`；
  - 新发现（必须带证据）；
  - 想追问的对象与问题（未决问题记录，不强制二轮）。
- **过程全匿名（直到裁决）**：讨论、回应、表决与计票期间，席位一律以 A/B/C 出现；docket、中间回应、进度事件都不包含角色、模型或真实 id。主持人不得提前汇总或透露任何票。**只有规则裁决确定之后**（见 4.6），最终结果才把 A/B/C 映射回真实席位、模型与立场。

**终止条件（每轮结束由规则判定）**：
`立场稳定` = 最后一轮无任何席改变 verdict/findings，且无新 finding，且争议项数量不增加。满足即结束讨论、进入表决。

**轮次上限与人工确认**：
- 默认最多 3 轮。
- 达到上限仍未稳定：按配置 `discussion.onExhaustion`：
  - `ask_human`（默认）：通过 DSH 用户提问机制请人类选择"继续讨论（追加 N 轮）/ 直接表决"；
  - `proceed`：直接进入表决。
- 人工确认超时或不可用（headless）：默认直接表决，记录 `human_confirmation_missing: true`。
- 结果中记录实际轮次、终止原因、人工确认结果。

**改票**：允许双向改票（approve ↔ request_changes，findings 可增删），必须记录改票理由与依据的证据/席次；改票历史保留（首轮立场 vs 最终立场）。

### 4.5 Phase 3：秘密表决

- 各席以匿名席位 A/B/C 并发提交 `Ballot`：最终 verdict、最终 findings、impact、若改票的 `changeReason`。
- **密封计票**：收齐全部票之前，主持人不得计票、不得披露任何单票或中间分布；各席也看不到他人的最终票。
- 提交后不可撤回；某席提交失败则按失败矩阵使用其最后有效立场（记录 `ballot_missing`）。
- 表决阶段不再执行工具（脚本执行只发生在讨论阶段）。

### 4.6 规则裁决

由纯函数 `decide()` 从匿名票与聚合证据计算，见第 6 节；任何模型输出都不能修改裁决。

**揭示点（reveal）**：`decide()` 返回裁决的瞬间即解除匿名。此后才允许把 A/B/C 映射回真实席位、角色与模型，生成带署名的纪要，并把归属信息写入结果与 UI。揭示之前，任何中间输出（工具进度、流式事件、日志、错误信息）都不得泄露对应关系；内部审计账本在揭示前对模型与用户均不可见。

**匿名的对象**：定论之前，席位身份本身（角色、模型、映射）与任何立场/票信息都不可见；只允许展示**审查范围**（审哪些文件、哪个基线）与**匿名进度**（A/B/C 的状态点、当前阶段），不得展示"哪一席用哪个模型""哪一席倾向如何"。定论之后一次性揭示全部归属，包括模型分配。

### 4.7 会后：书记官纪要

- 一次模型调用（与书记官同一角色/模型配置），**发生在揭示点之后**，因此可以引用席位身份与模型。
- 输入：各席最终报告（已解除匿名）、讨论记录、规则裁决结果、风险/覆盖率事实。
- 输出 `CouncilMinutes`（纯纪要，**无 recommendation / 无建议字段**）：
  - 各席主张摘要与最终票；
  - 共识项、争议项（谁 vs 谁、争点、是否解决）；
  - 改票记录与改票理由；
  - 未决问题；
  - 证据强度描述（不含通过/不通过建议）；
  - dissent 原文保留。
- 约束：不得新增 finding、不得改 severity/blocking/verdict、不得隐藏 dissent；schema 强校验，违规判 `minutes_status: invalid` 并回落规则模板纪要。
- 失败不影响裁决：`degraded_reasons` 记 `minutes_failed`，status 降级，verdict 不变。

### 4.8 模式

| 模式 | 阶段 | 用途 |
|---|---|---|
| `quick` | clerk → briefs → ballots → verdict | 自动/预览/高频、低成本；无讨论、无纪要（用规则摘要替代） |
| `council` | clerk → briefs → discussion → ballots → verdict → minutes | 显式审查、重要变更；默认模式 |

> 早期草案中的 `standard`/`deep` 合并为 `council` + 配置项（席位数、轮次、预算、是否允许脚本）。

---

## 5. 席位与模型

### 5.1 席位定义

内置三个视角（默认 3 席）：

| 席 | 视角 | 上下文重点 | 典型产出 |
|---|---|---|---|
| Architect | 架构/设计一致性 | 改动模块、调用点、依赖、接口边界 | 结构性问题、过度复杂、跨系统影响 |
| Engineer | 实现正确性 | 完整改动文件、相关测试、类型/API | bug、边界、并发、性能、可测试性 |
| Adversary | 对抗/破坏 | diff + 安全敏感路径 + 配置/依赖改动 + 测试缺口 | 故障路径、安全滥用、注入、数据丢失、回滚风险 |

- 5/7 席时增加专业视角（安全、数据迁移、并发、公开 API、测试、性能等），**全部为投票席**。
- 席位总数必须为奇数；默认 3；任意模式可指定 3/5/7。
- 视角不得重复（配置校验警告；同名视角会导致"多席同质"）。

### 5.2 模型分配（书记官）

- 书记官在约束下自主分配，每席记录 `provider/model` 与 `assignmentReason`。
- 约束：
  1. 只能选择当前可用路由（`ctx.llm` 目录/注册 provider 中可用者）；
  2. 视角适配（如对抗席优先选更强/更独立的模型）；
  3. 异构优先：能分到不同模型族就异构；不能则同构并标注 `homogeneous: true`；
  4. 预算约束（`execution.maxCostUsd` / token 预算；无成本信息时按配置的 tier 启发式）。
- 配置覆盖：`seats[].model` 显式指定时该席固定使用配置的模型（用户 pin 优先）；未指定的席位由书记官自主分配。`clerk` 的模型由 `clerk.model` 配置，省略则跟随当前 DSH agent 默认模型。
- 调用失败回退：某席模型在运行时不可用（auth/限流/路由消失）→ 回退到配置的默认路由，重试一次，记录 `model_fallback` 与原因；仍失败则该席 error。
- 结果中记录：每席实际模型、是否回退、议会是否同构、书记官分配理由。

### 5.3 异构性声明

- `homogeneous: true` 时必须显式标注，UI 与报告均展示"同构议会：独立性有限"。
- 不把"多席"包装成"多模型"。

---

## 6. 裁决规则

### 6.1 输入

- `seats`：n 个投票席（n 为奇数，全部 required）。
- 每席最终材料：`status`（completed/error）、`ballot.verdict`、`findings`。
- 聚合后的 findings（含 provenance、severity、confidence、mustFix、introducedByChange）。
- 覆盖率/中断/降级事实。

### 6.2 blocking 判定（确定性规则）

```
blocking(finding) =
  finding.introducedByChange == true
  且 (
    severity == "critical"
    或 (severity == "high" 且 confidence >= "medium")
    或 (mustFix == true 且至少两席独立提出同一指纹的 finding)
  )
```

- 阈值可配置（`policy.blockingSeverity` 默认 `high`）。
- 聚合器（规则合并）只能抬高不能压低单席的 blocking 声明。
- 讨论阶段提出的新 finding 必须先进入最终 findings 才能参与 blocking。
- `confidence` 必须用于判定（不能是装饰字段）：低置信只报告、不阻断。

### 6.3 majority 裁决算法（默认）

```
A = completed 席中 approve 数
R = completed 席中 request_changes 数
q = floor(n/2) + 1          # 3 席 => 2, 5 席 => 3, 7 席 => 4

1. 任一 blocking finding                         => request_changes
2. R >= q 且 R > A                               => request_changes
3. A >= q 且 A > R 且无 blocking                 => approve
4. A == R > 0（平票）                            => request_changes
5. 有 completed 但以上都不满足                    => insufficient
6. 无 completed                                   => none（status = error）
7. partial coverage / 中断                        => 不得 approve；
                                                     有 blocking => request_changes，否则 insufficient
```

### 6.4 unanimous 裁决（可选配置 `policy.approval: unanimous`）

```
approve      = 全部 n 席 completed 且全部 approve 且无 blocking
request      = 任一 completed request_changes 或任一 blocking
insufficient = 其余（含"有 error 但无人反对"）
none         = 全部 error
```

- 默认 majority；unanimous 用于高风险场景（人工显式开启）。
- 策略字段：`declaredPolicy`、`effectivePolicy`、`escalatedBy`（none/config/cli/risk）。

### 6.5 风险与升级

- `risk` 由确定性特征计算：文件数/行数、敏感路径（auth、crypto、migrations、CI、部署、依赖锁文件）、删除为主、公开 API 导出变更、二进制文件等。
- 高风险不会自动改变 verdict，但会：建议 5/7 席、建议 unanimous（若配置 `escalateOnRisk`）、在 UI 与报告中显著标注。

### 6.6 status / trust / verdict 的关系

| 字段 | 取值 | 语义 |
|---|---|---|
| `status` | completed / degraded / error | 流程执行状态；任一席 error、部分覆盖、聚合 fallback、书记官失败均 degraded |
| `verdict` | approve / request_changes / insufficient / none | 规则裁决；degraded 时可为 approve 但必须满足 quorum（不允许"单票 approve"） |
| `trust` | trustworthy / needs_review / untrustworthy | completed → trustworthy；degraded 或 insufficient → needs_review；error / verdict=none → untrustworthy |

- `insufficient` 表示"有证据但不足以形成多数结论"，消费方不得当作通过；agent 场景应转人工或修复后重审。
- 部分覆盖（大 diff 切分）不得 approve。

### 6.7 dissent 与一致度

- 少数派最终意见（verdict 与理由）必须原样保留进 `dissent`。
- 计算并输出：`approveVotes`、`requestVotes`、`changedVotes`（首轮 vs 最终）、`agreement`（席间一致度，描述性指标）。

---

## 7. 审查对象与范围

### 7.1 Artifact 抽象（V1 仅实现 code-change）

```text
ReviewArtifact
  kind: "code-change" | "plan" | "document" | "answer"   # V1 仅 code-change
  snapshot: 冻结的规范输入（代码：canonical diff + base/head OID）
  intent:   任务/请求/验收标准（不可信，但参与意图一致性审查）
  context:  按席裁剪的上下文包（manifest + token cap）
  locator:  发现项定位模型（代码：path/line/range；其余 kind 由 adapter 定义）
```

### 7.2 code-change artifact

- 规范 diff（canonical）：新增/修改/删除/重命名、二进制、mode 变化、hunk、行映射、no-newline 标记、旧/新路径。
- 冻结快照：审查开始时记录 `baseOid`、`headOid`、patch hash、逐文件 blob hash、dirty/untracked 清单；审查期间不重取。
- 来源优先级（显式参数覆盖书记官）：
  - `turn`：本回合变更（`ctx.workspaceChanges` 快照，会话存活期有效）；
  - `working-tree`：工作区 vs HEAD（含 untracked，通过 git 显式收集）；
  - `staged`：暂存区；
  - `base-ref`：与指定 base 对比（默认不设置，由书记官或调用方指定）；
  - `patch`：显式 patch 文本。
- 默认由书记官决定（工作区 vs HEAD；干净则最近顶层回合）。

### 7.3 覆盖率

- 大 diff 不得静默截断。默认策略：按文件切分并记录计划；超限时要求调用方缩小范围，或按配置允许 partial。
- `coverage` 记录：总/已审文件数、切分策略、被摘要/未审路径；`partial=true` 时裁决不得 approve。
- 每个席位看到的上下文包受 token 预算约束；manifest 记录进报告。

### 7.4 意图一致性（差异化能力）

- 书记官的会前总结同时产出 `intent` 上下文：用户原始请求、agent 最终回答/交付声明、计划（若有）。
- Architect 席职责包含"声称 vs 实际"：功能是否真实现、声称的测试是否真有、是否越界改文件、是否漏做子项。
- 该上下文标记为不可信输入，审查者需以 diff/证据核实。

---

## 8. 契约（TypeScript 类型）

> 这些类型是 v1.1 契约；规则字段与叙事字段分离，叙事字段不参与裁决。

### 8.1 请求与范围

```ts
type ReviewMode = "quick" | "council";

// 过程内匿名引用："A" | "B" | "C" | ...；揭示点之前，任何对外契约只使用 seatRef。
type SeatRef = string;

interface ReviewRequest {
  artifact: ReviewArtifact;
  mode: ReviewMode;
  scope?: Partial<ReviewScopeProposal>;   // 调用方显式覆盖
  focus?: string[];                        // 重点提示（如 "security", "tests"）
  detail?: "digest" | "full";
  budget?: Budget;
  signal: AbortSignal;
}

interface ReviewScopeProposal {
  artifactKind: "code-change";             // V1
  target: ReviewTarget;
  files: string[];
  rationale: string;
  confidence: "high" | "medium" | "low";
  intent: { task?: string; claims?: string; plan?: string };
  modelAssignment: ModelAssignment[];
}

interface ReviewTarget {
  kind: "turn" | "working-tree" | "staged" | "base-ref" | "patch";
  baseRef?: string;
  baseOid?: string;
  headOid?: string;
  patchHash: string;
  turn?: number;
  sessionId?: string;
}

interface ModelAssignment {
  seatId: string;
  perspective: string;
  provider: string;
  model: string;
  assignmentReason: string;
  fallback?: boolean;
}
```

### 8.2 席位报告

```ts
type Severity = "critical" | "high" | "medium" | "low" | "info";
type Confidence = "high" | "medium" | "low";

interface FindingLocation {
  path: string;
  side: "old" | "new";
  line?: number;
  range?: { start: number; end: number };
  hunkId?: string;
}

interface FindingEvidence {
  kind: "code" | "test" | "script" | "document";
  path?: string;
  line?: number;
  command?: string;          // 讨论阶段脚本验证
  exitCode?: number;
  outputDigest?: string;     // 输出摘要 hash，不存全文
  note: string;
}

interface SeatFinding {
  id: string;                // 局内 id，报告内唯一
  fingerprint: string;       // 跨轮/跨席稳定指纹（path + 归一化上下文 + category + 归一化标题）
  location?: FindingLocation;
  severity: Severity;
  confidence: Confidence;
  category: string;          // correctness/security/architecture/...
  title: string;
  rationale: string;
  suggestion?: string;
  mustFix: boolean;
  introducedByChange: boolean;   // 本次变更引入 vs 既有问题
  evidence?: FindingEvidence[];
}

interface SeatBrief {
  seatRef: SeatRef;              // 匿名引用；揭示后经 ReviewResult.reveal 映射到真实席位/模型
  perspective: string;
  model: { provider: string; model: string };
  status: "completed" | "error";
  verdict?: "approve" | "request_changes";
  impact?: "major" | "normal";
  findings: SeatFinding[];
  summary: string;
  evidenceNote?: string;
  error?: ReviewError;
  usage?: { inputTokens?: number; outputTokens?: number; durationMs?: number };
  childSessionId?: string;       // 证据会话
}
```

### 8.3 讨论与表决

> 过程契约：以下类型只使用 `seatRef`，不携带真实席位、角色或模型；身份映射只在揭示点之后通过 `ReviewResult.reveal` 提供。

```ts
interface DiscussionResponse {
  seatRef: SeatRef;
  round: number;
  agreesWith: { seatRef: SeatRef; reason: string }[];
  disagreesWith: { seatRef: SeatRef; reason: string }[];
  positionChanged: boolean;
  changeReason?: string;
  newFindings: SeatFinding[];
  questions: { to: SeatRef; question: string }[];
}

interface DiscussionRound {
  index: number;
  docketHash: string;
  responses: DiscussionResponse[];
  termination: { ended: boolean; reason: "positions_stable" | "round_cap" | "human_decided" };
}

interface Ballot {
  seatRef: SeatRef;
  finalVerdict: "approve" | "request_changes";
  finalImpact?: "major" | "normal";
  finalFindings: SeatFinding[];
  changedFromBrief: boolean;
  changeReason?: string;
}
```

### 8.4 聚合证据（规则产出）

```ts
interface AggregatedFinding {
  id: string;
  fingerprint: string;
  sourceSeatRefs: SeatRef[];       // 过程内只记录匿名引用；揭示后由 reveal 映射
  sourceFindingIds: string[];      // 必须非空且可追溯（union-superset 不变量）
  location?: FindingLocation;
  severity: Severity;
  confidence: Confidence;
  category: string;
  title: string;
  rationale: string;
  suggestion?: string;
  mustFix: boolean;
  introducedByChange: boolean;
  status: "blocking" | "non_blocking";
  mergeReason: string;
}

interface AggregateEvidence {
  findings: AggregatedFinding[];
  seats: SeatBrief[];
  ballots: Ballot[];
  discussion: DiscussionRound[];
  dissent: { seatRef: SeatRef; verdict: string; reason: string }[];
  coverage: Coverage;
  risk: RiskAssessment;
  degradedReasons: string[];
}
```

### 8.5 结果

```ts
interface ReviewDigest {
  reviewId: string;
  mode: ReviewMode;
  status: "completed" | "degraded" | "error";
  trust: "trustworthy" | "needs_review" | "untrustworthy";
  verdict: "approve" | "request_changes" | "insufficient" | "none";
  overallImpact: "major" | "normal" | "unknown";
  summary: string;
  seats: { seatId: string; label: string; verdict?: string; changed?: boolean; status: string }[];
  counts: { findings: number; blocking: number };
  target: { kind: string; baseRef?: string; files: number; partial: boolean };
  homogeneous: boolean;
  rounds: number;
  durationMs: number;
  degradedReasons: string[];
  reportId: string;
}

interface RevealInfo {
  at: "verdict";                  // 揭示点：裁决确定
  seats: {
    seatRef: SeatRef;
    seatId: string;
    perspective: string;
    provider: string;
    model: string;
    briefVerdict?: string;        // 首轮立场
    finalVerdict?: string;        // 最终票
    changed: boolean;             // 是否改票
  }[];
}

interface ReviewResult {
  schemaVersion: "1.1";
  engineVersion: string;
  digest: ReviewDigest;
  scope: ReviewScopeProposal;
  coverage: Coverage;
  risk: RiskAssessment;
  reveal: RevealInfo;             // 只在裁决之后填充；过程契约一律使用 seatRef
  decision: {
    declaredPolicy: "majority" | "unanimous";
    effectivePolicy: "majority" | "unanimous";
    escalatedBy: "none" | "config" | "cli" | "risk";
    approveVotes: number;
    requestVotes: number;
    expectedQuorum: number;
    rationale: string;              // 规则生成的裁决理由（引用 findings）
  };
  findings: AggregatedFinding[];
  seatBriefs: SeatBrief[];
  discussion: DiscussionRound[];
  ballots: Ballot[];
  minutes?: CouncilMinutes;         // council 模式
  errors: ReviewError[];
  redaction: RedactionReport;
  metadata: {
    startedAt: string;
    finishedAt?: string;
    homogeneous: boolean;
    models: { seatId: string; provider: string; model: string; fallback: boolean }[];
    usage?: { inputTokens?: number; outputTokens?: number; estimatedCostUsd?: number };
    workspaceMutatedDuringReview?: boolean;
  };
}

interface CouncilMinutes {
  summary: string;
  seatSummaries: { seatId: string; label: string; view: string }[];
  consensus: { fingerprint: string; statement: string }[];
  disputes: { fingerprint?: string; seats: string[]; point: string; resolved: boolean }[];
  voteChanges: { seatId: string; from: string; to: string; reason: string }[];
  unresolvedQuestions: { from: string; to?: string; question: string }[];
  evidenceStrength: "strong" | "moderate" | "weak";
  dissent: { seatId: string; verdict: string; reason: string }[];
  minutesStatus: "ok" | "invalid";
}
```

### 8.6 错误

```ts
type ErrorStage = "input" | "config" | "clerk" | "reviewer" | "discussion" | "aggregate" | "policy" | "minutes" | "reporter";

interface ReviewError {
  stage: ErrorStage;
  code: string;                  // 版本化注册表：例如 REVIEWER_TIMEOUT、MODEL_ROUTE_UNAVAILABLE、INVALID_SEAT_OUTPUT
  message: string;
  seatId?: string;
  retryable?: boolean;
  fatal?: boolean;
  attempts?: number;
  providerRequestId?: string;
  cause?: string;
}
```

---

## 9. 执行与可靠性

### 9.1 并发、超时、取消、预算

- 陈词阶段：N 席并行（N ≤ 7），受 `execution.concurrency`（默认 3）与 DSH `maxActiveSubagents`（默认 8，与用户子 agent 共享）约束；超限时排队而非失败。
- 超时：每席陈词/讨论/表决独立超时（默认陈词 120s、每轮讨论 90s、表决 30s），总预算 `execution.totalTimeoutMs`（默认 600s）。
- 取消：工具调用收到 `AbortSignal` 或命令被取消 → 取消所有子 agent 并 `dispose()` 等待收敛；已完成席位的报告保留，输出 degraded/insufficient（或按调用方要求返回）。
- 预算：`execution.maxCostUsd`、`maxInputTokens`；超出 → 中止后续席位/讨论，已得证据照常裁决，`degraded_reasons: ["budget_exceeded"]`；不得 approve 若 quorum 不足。

### 9.2 失败与降级矩阵

| 失败点 | 处理 | 结果影响 |
|---|---|---|
| 书记官失败/非法输出 | 确定性默认范围 + 默认模型 | `clerk_fallback`；degraded |
| 单席陈词失败 | 其余席继续 | `reviewer_error`；degraded；可能 insufficient |
| 单席讨论失败 | 使用其陈词作为最终立场 | `discussion_missing:<seat>`；degraded |
| 单席表决失败 | 使用其最后有效立场 | `ballot_missing:<seat>`；degraded |
| 讨论轮次超限未定 | 人工确认或直接表决 | `human_confirmation_missing`（若超时） |
| 书记官纪要失败/越权 | 回落规则模板纪要 | `minutes_failed` / `minutes_invalid`；verdict 不变 |
| 工作区在审查期间被改动 | 标注并降级 | `workspace_mutated_during_review`；trust=needs_review |
| 全部席位失败 | 无可用证据 | status=error；verdict=none |

### 9.3 缓存与幂等

- 缓存键：`artifact.snapshotHash + mode + seatComposition + modelAssignment + policyVersion + promptVersion`。
- 命中缓存直接返回结果（`cached: true`）；缓存不跨配置/模型版本复用。
- 同一快照重复审查应可复现结构（verdict/ID/顺序），叙事字段允许差异。

### 9.4 审计与证据

- 每个席位的陈词/讨论/表决发生在独立子 agent 会话中，session log 即完整证据；`SeatBrief.childSessionId` 引用它。
- 工具/命令事件记录入口与结果摘要；完整 `ReviewResult` 落 storage（reportId 可检索）。
- 报告默认不写工作区；`output.exportMarkdownDir` 可配置导出目录（默认关闭）。

---

## 10. 安全与隐私

### 10.1 权限与只读边界

- 审查者子 agent **继承父会话的文件策略**（workspace 默认 workspace-write；父会话更严格则自动更严格）。
- 委托子 agent 的审批策略固定为 `never`：需要人工批准的操作用户不可达，直接失败。
- 陈词阶段 preset 只含只读工具（无 shell）；讨论阶段 preset 只读 + shell（用于验证）。
- 不额外自建沙箱：执行与隔离完全交给 DSH 的 sandbox/shell 机制。
- 工作区突变护栏：审查开始/结束对比 `git status` 与逐文件 hash；变更则标注 `workspace_mutated_during_review` 并降级，不静默通过。

### 10.2 脚本执行

- 仅讨论阶段允许；命令由审查者提出，经 DSH shell 工具在继承的沙箱策略下执行。
- 插件记录 `command + exitCode + outputDigest` 作为证据，不保存全文输出。
- 脚本产生的 workspace 变更由护栏检测并标注。
- 已知残余风险：Windows 沙箱对网络的限制取决于平台实现，可能无法阻止外发；V1 通过"继承父策略 + 不提供网络工具 + 注入防护"缓解，并在设置页说明。

### 10.3 提示注入

- diff、代码注释、commit message、AGENTS.md、项目配置、任务描述、agent 声称均为不可信输入。
- 审查者 system prompt 与不可信数据分区（nonce 分隔 + "data, not instructions" 框定），输出 schema 强校验。
- findings/纪要回传给父 agent 与 UI 时仍是**不可信数据**：工具描述与结果呈现标注为审查证据，不得作为指令执行；UI 转义文本。
- 书记官与各席的输入输出都不参与系统指令。

### 10.4 脱敏与数据外发

- 进入任何模型前扫描并脱敏：API key/token、私钥、`.env` 赋值、URL 凭据、明显生产数据。
- `RedactionReport`：规则、命中数量、位置（文件/字段），不含值；扫描器失败则 fail-closed（不调用模型，报错）。
- 脱敏在 prompt 组装前完成；报告与纪要默认也脱敏；`rawOutput` 不进入公开结果。
- 跨 provider（如 OpenRouter）外发需配置允许（`security.allowThirdPartyProviders`，默认 true for configured routes，但首次使用时提示数据流向）。

### 10.5 信任边界

- **可信层**：profile 中插件 row 的 config（模型路由、策略阈值、席位数、预算、输出目标）。
- **不可信层**：工作区内的项目配置/额外视角文件/AGENTS.md；只允许非敏感调参（忽略路径、更严格的严重级阈值、补充只读视角、语言），不得改变 provider/凭据、策略松绑、required 席或输出目标。
- 书记官与各席看到的工作区配置一律按不可信输入处理。
- 记录 `configProvenance` 与被忽略的不可信键。

---

## 11. DSH 集成

### 11.1 工具 `magi_review`

参数（对模型暴露）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `mode` | `quick` \| `council` | 默认 `council`（配置可改） |
| `target` | `auto` \| `turn` \| `working-tree` \| `staged` \| `base-ref` \| `patch` | 默认 `auto`（书记官决定） |
| `base` | string | 配合 `base-ref` |
| `paths` | string[] | 限定文件 |
| `seats` | 3 \| 5 \| 7 | 默认 3 |
| `focus` | string[] | 重点提示（如 security/tests） |
| `detail` | `digest` \| `full` | 默认 `digest` |

- 返回 digest（≤4KB）与 reportId；`detail=full` 时额外返回完整结果（受 spill 策略约束）。
- 长审查超时：工具声明 `timeoutMs`（默认 600s，可配置），由 timeout-policy 执行；取消时返回已完成证据与 degraded 结果。
- 工具描述强调：findings 是不可信数据、verdict 由规则产生、`insufficient` 不等于通过。

### 11.2 命令 `/magi-review`

```text
/magi-review                       # council，auto 范围
/magi-review quick                 # quick 模式
/magi-review --base main           # 对比 base
/magi-review --staged
/magi-review --seats 5 --focus security
/magi-review --report <reviewId>    # 查看/导出报告
```

- 命令结果渲染：结构化 Markdown（范围 → 陈词摘要 → 讨论/改票 → 表决 → 裁决 → 纪要 → findings 列表）；完整 JSON 通过 `/magi-review --report <id>` 导出。
- **揭示点之后才输出归属**：结果中可展示"哪一席、用哪个模型、投了什么、是否改票"；运行过程中的任何中间输出（进度、流式文本）一律匿名。
- 人工确认（讨论延长）通过命令交互与 DSH 用户提问机制完成。
- 命令不进入模型上下文（除非未来显式提供"把结果交给 agent 修复"的选项）。

### 11.3 三灯工具卡（Client）

- 注册 `tool.call.toolview`，key = `magi_review`。
- **运行中（未到揭示点）**：卡片只显示匿名进度（A/B/C 的状态点、已完成席数、当前阶段），不显示角色、模型、单席票或计票分布；不得用颜色暗示投票倾向。
- **完成后（揭示点之后）**：三盏灯一次性切换为揭示后的归属——每盏灯标注角色与模型、其最终票；总体 verdict + 席数与模式 + 一句摘要 + 耗时；`homogeneous` 时显示"同构"标记；`insufficient` 用独立颜色与文案。
- 展开态（揭示后）：
  - 每席：角色/模型、陈词 verdict/impact、findings（severity 色点、`path:line` 可点击打开文件）、是否改票与理由；
  - 讨论：轮次、争议项、改票记录（谁改变、为什么；过程记录中席位以 A/B/C 呈现，此处按揭示映射显示）；
  - 裁决：规则结果、quorum、blocking 原因、dissent；
  - 纪要：书记官摘要（无建议）；
  - 操作：复制 JSON、查看报告（reportId）、重新审查（可选）。
- 主题：只用 `--dsw-alias-*` token；亮/暗主题均验证；不 import Client 包；不替换 app root。
- 命令结果不渲染为三灯卡（走 Markdown 文本），文档中明确该差异。

### 11.4 存储与投影

- `storageDomain` 表（v1）：
  - `reviews`：`reviewId → ReviewResult`（可裁剪），带 schemaVersion；
  - `reviewCache`：缓存键 → digest/reportId；
  - `reviewIndex`：sessionId/reviewId → 摘要（供侧栏/命令查询）。
- V1 不注册 session projection（卡片数据来自工具结果）；后续加 projection 以支持徽标/侧栏。

### 11.5 配置（plugin row config 草案）

```yaml
- id: magi-review
  name: '@local/dsh-magi-review'
  config:
    seats:
      - { id: architect, perspective: builtin:architect, required: true }
      - { id: engineer,  perspective: builtin:engineer,  required: true }
      - { id: adversary, perspective: builtin:adversary, required: true }
    clerk:
      model: { provider: deepseek-official, model: deepseek-flash }   # 省略则跟随 agent 默认
    modes:
      default: council                 # quick | council
      quick: { seats: 3 }
      council: { seats: 3 }
    models:
      defaultRoute: { provider: deepseek-official, model: deepseek-flash }
      fallbackOnError: true
    discussion:
      maxRounds: 3
      onExhaustion: ask_human          # ask_human | proceed
      extendByRounds: 2
      humanConfirmationTimeoutMs: 300000
      allowScripts: true
    anonymity:
      mode: until_verdict              # 过程全匿名（A/B/C、密封票）；裁决后揭示
      revealInReport: true             # 最终结果包含揭示映射（席位/模型/首轮与最终立场）
      auditLedger: true                # 内部审计账本保留 seatRef→身份映射，揭示前不可见
    policy:
      approval: majority               # majority | unanimous
      blockingSeverity: high           # critical | high | medium
      escalateOnRisk: false
    execution:
      concurrency: 3
      briefTimeoutMs: 120000
      discussionRoundTimeoutMs: 90000
      ballotTimeoutMs: 30000
      totalTimeoutMs: 600000
      maxCostUsd: 0.5
      cache: true
    output:
      detail: digest
      exportMarkdownDir: null
    security:
      redactSecrets: true
      allowThirdPartyProviders: true
    tool:
      enabled: true
      name: magi_review
    command:
      enabled: true
      name: magi-review
```

### 11.6 审查者 preset（两套）

- `magi-reviewer-readonly`：persona + 只读工具（read/grep/glob/lsp）+ 输出 schema 要求（SeatBrief JSON）。
- `magi-reviewer-verify`：persona + 只读工具 + shell（讨论阶段用）+ 输出 schema 要求（DiscussionResponse / Ballot JSON）。
- 两套 preset 都禁止 write/edit/present 等工具；shell 仅在 verify preset 中出现。
- 子 agent 通过 `agentPreset` 选择；`agentOptions` 指定该席模型；`delivery: "caller"`（不向父会话发完成通知）。

---

## 12. 用户体验（摘要）

- 用户视角：`/magi-review` → 看到审查范围（审什么）→ 过程只显示匿名进度（A/B/C 状态、阶段），不显示角色/模型/票 → 裁决确定后一次性揭示身份、模型与归属 → 三灯卡/Markdown 展示每席意见、争议、改票、纪要 → 可复制 JSON / 查看报告 / 重审。
- agent 视角：`magi_review` 返回 digest；blocking findings 可作为修复指令；`insufficient` 提醒需要人工或缩小范围。
- 明确展示"同构议会"与"degraded/insufficient"，不把不确定包装成通过。

---

## 13. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0 技术验证** | bundle 骨架 + 一个 `magi_ping` 工具 + 三灯空卡 + 一次 spawn（preset + agentOptions + 结构化输出）+ 一次 `/magi-review` 命令骨架 | 本地目录安装成功；工具卡渲染；子 agent 只读；结构化输出可用 |
| **M1 议会核心** | core：artifact/diff/scope、clerk 规则、裁决算法、聚合、指纹；单测（策略表、去重、ID、脱敏） | 纯逻辑测试全绿；手工构造输入产出正确 verdict |
| **M2 council 全流程** | 陈词 + 讨论（3 轮/终止/人工确认/脚本验证）+ 表决 + 纪要；quick 模式 | 真实 session 跑通；同构/异构标注正确；失败降级符合矩阵 |
| **M3 入口与 UI** | `magi_review` 工具、`/magi-review` 命令、三灯卡完整展开态、报告导出 | 工具/命令均可用；卡片亮暗主题正常；命令 Markdown 完整 |
| **M4 加固** | 预算、缓存、workspace 突变护栏、错误注册表、安全测试、成本基准 | 预算中止、超时取消、注入 fixture 均符合预期 |

---

## 14. 测试与验证策略

1. **纯逻辑单测**：canonical diff、指纹稳定性（行号漂移/重命名）、去重、blocking 判定、裁决表（n=3/5/7 × approve/request/error/insufficient × partial × blocking）、脱敏。
2. **契约测试**：所有 `ReviewResult` 字段在 completed/degraded/error、quick/council、同构/异构下的稳定形状；非法组合被拒绝；`union-superset` 不变量。
3. **流程测试**：讨论终止条件（立场稳定/轮次上限/人工确认超时）、改票记录、书记官失败回落、单席失败降级。
4. **安全测试**：注入 fixture（diff 内嵌指令、伪造 JSON、超长输出）、脱敏 fixture、审查者越权尝试（写文件/改工作区）被检测或阻断、工作区突变护栏。
5. **集成测试**：`dsh --from-default-profile web --profile magi-dev` + `dsh plugin --profile magi-dev add <abs path>` + `--dump-config`；headless 下跑一次工具调用（待验证）。
6. **UI 验证**：安装后目视三灯卡折叠/展开、亮暗主题、文件跳转；无浏览器控制时如实报告"视觉未验证"。
7. **成本/时延基准**：3/5/7 席 × quick/council 的 token、耗时、通过率基线，写入 README 与默认值依据。
8. **模型分配回归**：固定可用路由集合，断言书记官分配满足约束与标注；无可用异构时标注 homogeneous。

---

## 15. 开放问题（实现前需运行时验证）

| # | 问题 | 影响 |
|---|---|---|
| 1 | `startActivation` 公开请求是否支持 `agentPreset` + `agentOptions` + 结构化输出 schema；`toolFilter` 是否可传 | 两套 preset 与按席模型能否成立 |
| 2 | 本地子 agent 的继续消息 API（讨论轮次/表决复用同一子 agent） | 讨论成本与证据连续性 |
| 3 | 结构化输出在超时/取消/`dispose()` 下的行为 | 表决与陈词的失败处理 |
| 4 | 工具 `timeoutMs` 声明与 agentic 审查时长是否冲突 | 长审查是否被截断 |
| 5 | Windows 沙箱是否限制网络；脚本执行的隔离边界 | 注入外发风险 |
| 6 | 命令结果是否支持自定义渲染（决定命令是否只能文本） | UX 方案 |
| 7 | `ctx.llm` 模型目录是否提供成本/tier 信息 | 书记官预算感知 |
| 8 | todo/子会话在侧栏/会话列表的展示方式 | 审查过程可见性 |
| 9 | `storageDomain` 的表/版本 API 细节 | 报告与缓存持久化 |
| 10 | `workspaceChanges` 在会话关闭/重启后的可用性 | turn 目标的适用窗口 |
| 11 | 运行时人类提问机制（讨论延长确认）在工具调用中的可用性 | 人工确认流程 |
| 12 | DSH rc 版本的 API 漂移与 compatibility 声明策略 | 安装与升级 |

---

## 16. 决策记录

| # | 决策 | 结论 |
|---|---|---|
| A | 模型多样性 | 软要求：异构优先，同构可运行但显式标注 |
| B | 讨论与投票关系 | 独立陈词 → 讨论 → 独立表决（秘密投票） |
| C | 结论形成 | 有主席模型合成，但通过与否由规则决定；主席只写纯纪要、无建议 |
| D | 审查对象边界 | artifact-agnostic 接口；V1 仅 code-change |
| E | 席位数量 | 固定奇数，默认 3；任意模式可指定 3/5/7；全部投票席 |
| F | 主席时机 | 表决后合成，不参与讨论与投票 |
| G | 匿名范围 | 从陈词之后的全部过程（讨论、回应、表决、计票、中间输出）**纯匿名票**；席位一律 A/B/C，收齐前不计票不披露；**规则裁决确定后立即揭示**身份/模型/首轮与最终立场/改票 |
| H | 讨论轮次 | 默认最多 3 轮；"立场稳定"即结束；3 轮未结束人工确认继续/直接表决（是否强制可配置） |
| I | 改票 | 双向改票 + 记录改票理由 |
| J | 讨论工具 | 允许执行脚本核实争议；权限继承父会话、审批 never、使用 DSH 沙箱 |
| K | 审查者文件权限 | 继承父会话策略（不自建隔离层） |
| L | quick 模式 | 纯独立投票（无讨论/纪要/脚本） |
| M | 全席位规模 | 任意模式可指定 3/5/7 |
| N | V1 触发 | 仅 `/magi-review` 命令 + `magi_review` 工具；不做门禁/自动 |
| O | V1 界面 | 命令 + 工具 + 三灯工具卡 |
| P | 默认模型分配 | 书记官在规则约束下自主分配，理由入报告，失败回退并标注 |
| Q | 会前角色 | 书记官确定范围 + 分配模型；自动确认，参数可覆盖 |
| R | 秘书与主席 | 同一书记官角色，会前/会后两次调用 |
| S | 范围默认值 | 由书记官确定（不硬编码默认） |
| T | 发布目标 | 先本地目录安装自用，稳定后 npm |
| U | 命名 | `/magi-review`、`magi_review`；席名 Architect/Engineer/Adversary；MAGI 作主题 |
| V | 报告形态 | 完整 JSON 落 storage；工具返回 digest；命令返回纪要 + reportId；Markdown 导出可选 |
| W | 讨论延长确认超时 | 默认"直接表决"并标注 |
| X | 成本护栏 | 预算上限；5/7 席告警；超预算中止并 degraded |
| Y | 书记官模型 | 跟随 agent 默认模型，可配置 |
| Z | 失败降级 | 单席失败用其余席；书记官失败回默认范围；全失败 error/insufficient |
| AA | 工作区突变 | 审查期间变更 → 标注 + 降级 |
| AB | 匿名揭示时机 | 只在最终结果定论后取消匿名；定论之前全匿名，任何中间输出不得泄露身份与票的对应 |

---

## 17. 与 v1.0 的差异摘要

| 维度 | v1.0（2026-06-12） | v1.1（本文档） |
|---|---|---|
| 实现语言 | Python | TypeScript（DSH 原生） |
| 形态 | 核心库 + CLI 优先 | DSH 插件（Host + Client） |
| 模型层 | 自建 provider 封装 | `ctx.llm` + DSH 路由；审查者用 subagent |
| 审查者 | 单次模型调用（隐含） | 独立子 agent：陈词只读 / 讨论可验证 |
| 流程 | 三席独立评审 → 聚合 → 裁决 | 书记官 → 陈词 → 讨论（3 轮/终止/人工确认）→ 表决 → 规则裁决 → 纪要 |
| 聚合器 | 可用模型、可参与影响评级 | 规则聚合；模型只写纪要，不参与裁决 |
| 裁决值 | approve / request_changes / none | + insufficient；blocking 一票否决；degraded 不允许无序批准 |
| 稳定 ID | 位置 + 标题 | 内容指纹 + 跨轮模糊匹配 |
| 配置 | YAML + CLI 参数 | 插件 Config（profile 可信层）+ workspace 不可信层 |
| 安全 | 原则性要求 | 权限继承、审批 never、脚本边界、脱敏、注入分区、工作区突变护栏 |
| 结果 | stdout JSON | 工具 digest / 命令 Markdown / storage 完整 JSON / 三灯卡 |
