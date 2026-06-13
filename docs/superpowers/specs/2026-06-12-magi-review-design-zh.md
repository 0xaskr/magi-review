# Magi Review 设计文档

## 产品定位 (Product Positioning)

`magi-review` 是一个适用于 AI 生成代码变更的多模型、多智能体代码审查引擎。旨在嵌入到不同的智能体工作流中，包括 Claude、Codex、Gemini、opencode、CI 以及未来的 GitHub 集成。

首个版本聚焦于审查 AI 生成的代码差异 (diffs)、补丁 (patches)、暂存的变更 (staged changes)，以及通过 stdin 提供的统一差异 (unified diffs)。对纯文本回答和通用构件的审查明确被列为次要目标，不应稀释首个版本的代码审查核心焦点。

该产品的核心定位是代码审查引擎。CLI 只是它的首个适配器，而不是核心的产品边界。

## 目标 (Goals)

- 从多个独立的视角审查 AI 生成的代码变更。
- 提供机器可读的 JSON 作为主要接口。
- 优先支持本地 CLI 使用，同时为未来的 MCP、GitHub Action 和智能体工具适配器保留清晰的边界。
- 保持审查者角色的可配置、可扩展和可加载性。
- 倾向于安全的降级输出，而不是单点故障，同时避免“故障开放 (fail-open)”式的错误批准。

## 非目标 (Non-goals)

- 在首个版本中构建 Web UI。
- 在代码审查功能可靠之前，支持任意非代码构件。
- 将审查逻辑与 GitHub、MCP 或任何单一智能体运行时耦合。
- 将模型输出作为可信的结构化数据对待而不进行标准化。

## 架构 (Architecture)

首个版本采用核心库加上 CLI 优先的架构。

```text
CLI / 未来的适配器
  -> 收集特定来源的输入
  -> 核心层对 diff/上下文 进行标准化
  -> 构建 ReviewInput
  -> 加载 ReviewConfig
  -> 运行审查者智能体
  -> 标准化 ReviewerResult[]
  -> 汇总审查证据
  -> 应用决策策略
  -> 构建 ReviewResult
  -> 报告 json
```

### 分层 (Layers)

1. **适配器层 (Adapter Layer)**
   - 处理特定来源的输入和输出集成。
   - 首个适配器是 CLI。
   - 未来的适配器包括 MCP 服务器、GitHub Action 和智能体工具包装器。
   - 适配器可以收集特定平台的元数据，但绝不能实现审查语义。

2. **核心层 (Core Layer)**
   - 负责配置加载、规范的 diff 标准化、编排、标准化、汇总以及结果契约。
   - 为适配器暴露稳定的 API。
   - 不需要知道它是被 CLI、MCP、CI 还是智能体运行时调用。

3. **模型提供商层 (Model Provider Layer)**
   - 将 Anthropic、OpenAI、Gemini、本地模型或其他提供商封装在一个统一的提供商接口后。
   - 审查者角色依赖于该提供商接口，而非提供商的 SDK。
   - 特定提供商的元数据在诊断信息中保留，但在汇总之前会被标准化。

4. **报告层 (Reporting Layer)**
   - 默认向 stdout 输出严格的 JSON。
   - 可选 `--summary` 参数输出人类可读的摘要。
   - 日志、警告、进度和诊断信息始终发送到 stderr。

## 默认审查者角色 (Default Reviewer Roles)

审查者的数量必须是奇数。默认配置包括三个必需的审查者。

### 广度优先架构师 (Breadth-First Architect)

关注广泛的架构影响：

- 模块边界
- 设计一致性
- 耦合和抽象的变更
- 跨系统影响
- 变更是否引入了不必要的复杂性

### 深度优先工程师 (Depth-First Engineer)

关注实现层面的正确性：

- Bug 和边缘情况
- 类型和 API 的正确性
- 并发和排序风险
- 性能退化
- 可测试性和可维护性

### 对抗性审查者 (Adversarial Reviewer)

关注寻找破坏变更的方法：

- 故障路径
- 安全和滥用情况
- 对提示注入敏感的行为
- 数据丢失和回滚风险
- 缺乏针对非快乐路径（异常路径）的测试
- 隐藏的 AI 幻觉效用

对抗性审查者不能同时充当最终的裁判。最终裁决由决策策略根据汇总器产出的审查证据来决定。

## 汇总器 (Aggregator)

汇总器接收标准化后的审查者结果，并为决策策略产出汇总后的审查证据。它不负责决定最终的顶层裁决。

职责：

- 合并重复的发现 (findings)
- 保留审查者的来源信息
- 汇总审查者评论 (comments)
- 标准化审查者错误
- 保守地解决发现项层面的冲突
- 为汇总后的发现项指定严重程度和阻塞状态
- 为决策策略生成事实性摘要
- 解释审查证据的降级或不完整之处

汇总器可以使用模型提供商，但其输出必须被标准化为与任何后备路径相同的稳定证据模式 (schema)。如果汇总器失败，规则后备必须仍然保留审查者结果，并为决策策略提供保守证据。

## 决策策略 (Decision Policy)

决策策略消费汇总后的证据，并决定最终的 `ReviewResult.verdict`。决策逻辑由核心脚本/策略层实现，而不是由审查者角色或汇总器实现。

### 影响评级与策略升级

每个审查者在给出裁决的同时，也会给出一个影响评级：`major`（重大）或 `normal`（普通）。汇总器收集所有可用审查者的影响评级后，按多数决判断整体影响等级：

- 如果多数审查者评为 `major`，整体影响为 `major`，决策策略自动升级为全体通过。
- 如果多数审查者评为 `normal`，整体影响为 `normal`，使用默认的多数决策略。

CLI 参数 `--decision-policy unanimous` 可以显式强制全体通过，不依赖审查者的影响评级。

### 策略规则

默认策略是必需审查者之间的多数决。当整体影响评级为 `major`、CLI 显式指定全体通过、或配置项要求全体通过时，策略升级为全体通过。

决策策略必须保持以下不变量：

- 审查者数量必须是奇数
- `status = degraded` 或 `status = error` 时，消费者应结合 `status` 决定是否信任 `verdict`

### 多数决策略下的裁决映射（默认，3 个审查者）

| 审查者 A | 审查者 B | 审查者 C | 整体 status | 整体 verdict | 说明 |
|---|---|---|---|---|---|
| approve | approve | approve | `completed` | `approve` | 全票通过 |
| approve | approve | request_changes | `completed` | `approve` | 多数批准 |
| approve | approve | error | `degraded` | `approve` | 多数批准但有审查者出错，结果降级 |
| approve | request_changes | request_changes | `completed` | `request_changes` | 多数要求修改 |
| approve | request_changes | error | `degraded` | `request_changes` | 有要求修改且有出错 |
| approve | error | error | `degraded` | `approve` | 仅一票批准且无人反对，结果降级 |
| request_changes | request_changes | request_changes | `completed` | `request_changes` | 全票要求修改 |
| request_changes | request_changes | error | `degraded` | `request_changes` | 多数要求修改 |
| request_changes | error | error | `degraded` | `request_changes` | 有要求修改 |
| error | error | error | `error` | `none` | 全部出错，无可用判断 |

### 全体通过策略下的裁决映射（重大影响模式）

| 审查者 A | 审查者 B | 审查者 C | 整体 status | 整体 verdict | 说明 |
|---|---|---|---|---|---|
| approve | approve | approve | `completed` | `approve` | 全票通过 |
| approve | approve | request_changes | `completed` | `request_changes` | 未能全票通过 |
| approve | request_changes | request_changes | `completed` | `request_changes` | 未能全票通过 |
| 任意含 error（非全部） | — | — | `degraded` | 已完成者的判断 | 有出错则结果降级 |
| error | error | error | `error` | `none` | 全部出错，无可用判断 |

## 实现语言 (Implementation Language)

所有生产代码、测试和第一方工具都使用 Python 开发。本文中的 schema 示例是说明性的契约；实现时应使用 Python 类型表示，例如 dataclasses、Pydantic models、TypedDicts，或项目标准的等价 Python 构造。

## 规范的 Diff 契约 (Canonical Diff Contract)

所有输入源必须在审查之前进行标准化。规范的 diff 模型必须支持：

- 来源类型：`git-diff`, `patch`, `stdin`, `pr-diff`
- 新增、修改、删除、重命名的文件
- 旧路径和新路径
- 二进制文件
- 文件权限模式的变更
- 旧/新行映射
- 差异块 (hunk) 范围
- 删除的行和增加的行
- `no newline at end of file` (文件末尾无换行符) 标记
- 可选的提交和仓库元数据

适配器可以收集特定来源的输入，但核心层负责规范的标准化和验证。

## 审查输入 Schema (Review Input Schema)

```python
class RepositoryMetadata(TypedDict, total=False):
    root: str
    branch: str
    base_ref: str
    head_ref: str
    commit_sha: str


class ModeChange(TypedDict, total=False):
    old_mode: str
    new_mode: str


class Hunk(TypedDict):
    id: str
    old_start: int
    old_lines: int
    new_start: int
    new_lines: int
    patch: str
    no_newline_at_end_of_file: NotRequired[bool]


class Change(TypedDict):
    path: str
    old_path: NotRequired[str]
    language: NotRequired[str]
    status: Literal["added", "modified", "deleted", "renamed"]
    is_binary: NotRequired[bool]
    mode_change: NotRequired[ModeChange]
    hunks: list[Hunk]


class ReviewContext(TypedDict, total=False):
    task: str
    ai_tool: Literal["claude", "codex", "gemini", "opencode", "unknown"]
    instructions: str


class ReviewInput(TypedDict):
    schema_version: Literal["1.0"]
    source: Literal["git-diff", "patch", "stdin", "pr-diff"]
    repository: NotRequired[RepositoryMetadata]
    changes: list[Change]
    context: NotRequired[ReviewContext]
    input_hash: str
```

## 发现项位置模型 (Finding Location Model)

发现项 (Findings) 需要足够的位置数据以便于 CLI 输出和未来的 PR 评论。

```python
class FindingRange(TypedDict):
    start_line: int
    end_line: int


class FindingLocation(TypedDict):
    path: str
    old_path: NotRequired[str]
    side: Literal["old", "new"]
    line: NotRequired[int]
    range: NotRequired[FindingRange]
    hunk_id: NotRequired[str]
    commit_sha: NotRequired[str]
```

发现项只有在确实涉及整个仓库或整个变更级别时，才可以省略位置信息。

## 审查者结果 Schema (Reviewer Result Schema)

```python
class ReviewerComment(TypedDict):
    id: str
    location: NotRequired[FindingLocation]
    category: Literal[
        "correctness",
        "security",
        "architecture",
        "maintainability",
        "testing",
        "performance",
        "adversarial",
        "diagnostic",
    ]
    message: str
    source_finding_ids: NotRequired[list[str]]


class ReviewerFinding(TypedDict):
    id: str
    location: NotRequired[FindingLocation]
    severity: Literal["critical", "high", "medium", "low", "info"]
    category: Literal[
        "correctness",
        "security",
        "architecture",
        "maintainability",
        "testing",
        "performance",
        "adversarial",
    ]
    confidence: Literal["high", "medium", "low"]
    title: str
    rationale: str
    suggestion: NotRequired[str]


class TokenUsage(TypedDict, total=False):
    input: int
    output: int


class ReviewerMetadata(TypedDict):
    started_at: str
    finished_at: NotRequired[str]
    prompt_hash: str
    config_hash: str
    input_hash: str
    token_usage: NotRequired[TokenUsage]


class ReviewError(TypedDict):
    source: Literal["input", "config", "reviewer", "aggregator", "reporter"]
    code: str
    message: str
    reviewer_id: NotRequired[str]


class ReviewerResult(TypedDict):
    reviewer_id: str
    role: str
    required: bool
    model: str
    provider: str
    status: Literal["completed", "error"]
    error_reason: NotRequired[
        Literal[
            "api_error",
            "timeout",
            "invalid_output",
            "rate_limited",
            "budget_exceeded",
            "cancelled",
        ]
    ]
    verdict: NotRequired[Literal["approve", "request_changes"]]
    impact: NotRequired[Literal["major", "normal"]]
    comments: list[ReviewerComment]
    findings: list[ReviewerFinding]
    error: NotRequired[ReviewError]
    raw_output: NotRequired[str]
    metadata: ReviewerMetadata
```

## 审查结果包装 (Review Result Envelope)

每种输出路径使用相同的 JSON 包装体：成功、降级的成功、汇总器后备 (fallback) 以及失败。

```python
class ReviewComment(TypedDict):
    id: str
    source_reviewer_ids: list[str]
    location: NotRequired[FindingLocation]
    category: str
    message: str
    source_finding_ids: NotRequired[list[str]]


class AggregatedFinding(TypedDict):
    id: str
    source_reviewer_ids: list[str]
    location: NotRequired[FindingLocation]
    severity: Literal["critical", "high", "medium", "low", "info"]
    category: str
    confidence: Literal["high", "medium", "low"]
    title: str
    rationale: str
    suggestion: NotRequired[str]
    status: Literal["blocking", "non_blocking"]


class ReviewMetadata(TypedDict):
    started_at: str
    finished_at: NotRequired[str]
    input_hash: str
    config_hash: str
    role_versions: dict[str, str]
    provider_models: dict[str, str]


class ReviewResult(TypedDict):
    schema_version: Literal["1.0"]
    status: Literal["completed", "degraded", "error"]
    verdict: Literal["approve", "request_changes", "none"]
    decision_policy: Literal["majority", "unanimous"]
    overall_impact: Literal["major", "normal"]
    aggregation_status: Literal["completed", "degraded", "failed"]
    aggregation_mode: Literal["model", "rule_fallback", "raw_reviewer_results"]
    summary: str
    comments: list[ReviewComment]
    findings: list[AggregatedFinding]
    reviewer_results: list[ReviewerResult]
    errors: list[ReviewError]
    metadata: ReviewMetadata
```

## 结论规则 (Verdict Rules)

引擎应避免”故障开放 (fail-open)”行为。审查判断和执行状态完全分离：

**单个审查者：**

- `status`: `completed | error`——执行状态，审查者是否成功完成
- `verdict`: `approve | request_changes`——审查判断，仅当 `status = completed` 时有效
- `impact`: `major | normal`——影响评级，仅当 `status = completed` 时有效

**整体 Review：**

- `status`: `completed | degraded | error`——流程状态
- `verdict`: `approve | request_changes | none`——决策策略的最终裁决

整体 `status` 含义：

- `completed`：所有必需审查者成功完成。
- `degraded`：至少一个必需审查者返回 `error`，但仍有其他审查者的可用结果。
- `error`：流程无法产出足够的可用证据（所有审查者出错，或输入/核心流程失败）。

整体 `verdict` 含义：

- `approve`：决策策略获得足够批准。
- `request_changes`：决策策略认定变更必须先修改。
- `none`：没有足够的已完成审查者来形成判断（`status = error` 时）。

当 `status = degraded` 时，`verdict` 仍然反映已完成审查者的实际判断，消费者应结合 `status` 来决定是否信任该结果。当 `status = error` 时，`verdict` 为 `none`。

## 降级运行 (Degraded Operation)

单一审查者/API 故障不能立即导致整个审查过程失败。

对于每个失败的审查者：

- 将审查者 `status` 设置为 `error`
- 记录 `error_reason`
- 在 `errors` 中保留错误元数据
- 继续进行剩余审查者的任务

顶层 `status` 必须反映执行降级。如果至少一个审查者返回 `error`，整体 `status` 为 `degraded`。`verdict` 仍然反映已完成审查者的实际判断，消费者应结合 `status` 决定是否信任。

## 汇总器故障处理 (Aggregator Failure Handling)

汇总器会根据配置进行重试：

- `aggregator.max_retries`
- `aggregator.retry_backoff_ms`
- `aggregator.timeout_ms`

如果它仍然失败：

- 保持稳定的 `ReviewResult` 包装体
- 设置 `aggregation_status: "failed"`
- 设置 `aggregation_mode: "raw_reviewer_results"` 或 `"rule_fallback"`
- 将原始的审查者结论包含在 `reviewer_results` 中
- 在可用时保留规则后备产生的汇总证据
- 让决策策略根据已完成审查者的判断推导出裁决

后备模式绝对不能输出自由格式的原始文本作为主要的 JSON 输出。汇总器失败时，整体 `status` 为 `degraded` 或 `error`，`verdict` 反映已完成审查者的判断。

## 配置 (Configuration)

该工具应可以在零配置下运行。

命令示例：

```text
magi-review
magi-review --staged
magi-review --base main
magi-review --summary
```

配置示例：

```yaml
reviewers:
  - id: breadth-first-architect
    role: built-in:breadth-first-architect
    required: true
    model: claude-sonnet
  - id: depth-first-engineer
    role: built-in:depth-first-engineer
    required: true
    model: gpt-5.5
  - id: adversarial-reviewer
    role: built-in:adversarial-reviewer
    required: true
    model: gemini-pro
aggregator:
  model: claude-opus
  max_retries: 2
  retry_backoff_ms: 1000
  timeout_ms: 60000
decision:
  policy: majority
execution:
  concurrency: 2
  reviewer_timeout_ms: 120000
  max_input_tokens: 120000
  max_estimated_cost_usd: 5
output:
  summary: false
```

配置规则：

- 审查者数量必须是奇数
- 决策策略默认使用 `majority`
- 可以通过 CLI 标志、受信任配置或重大影响审查模式要求 `unanimous` 批准
- 内置角色只能通过显式配置来覆盖
- 外部角色文件是可加载的
- CLI 标志覆盖针对非敏感行为的本地配置
- 敏感的提供商设置遵循信任边界规则

## 配置信任边界 (Configuration Trust Boundary)

在审查拉取请求 (PR) 或外部补丁时，仓库控制的配置是不被信任的。

首个版本应防止不被信任的配置静默更改：

- 提供商 Endpoint
- API 凭证来源
- 必需的审查者标志
- 角色提示词的强度
- 用于安全敏感角色的模型类
- 输出目的地

受信任的配置可以来自用户 home 目录配置、CI 的 Secrets、显式的 CLI 标志或受保护的基础分支。PR 提供的配置可以微调非敏感的项目配置期望，但默认不能削弱审查策略。

## 安全与隐私 (Security and Privacy)

### 密钥脱敏 (Secret Redaction)

在将 diff 或上下文发送给模型提供商之前，核心应该扫描潜在的密钥和敏感值。进行脱敏 (Redaction) 应该适用于：

- API keys 和 tokens
- 私钥
- 类似 `.env` 的环境变量赋值
- URL 中的凭据
- 明显的客户或生产环境机密数据

脱敏操作应该被记录在元数据中，但在任何时候都绝不暴露被脱敏的值。

### 提示注入边界 (Prompt Injection Boundary)

diffs、代码注释、commit message、配置文本以及任务描述都属于不受信任的输入。审查者和汇总器的 prompt 指令必须明确区分系统指令 (system instructions) 和被审查的内容。

被审查的内容不能被允许覆盖 (override) 审查者的角色指令、输出 schema 或是结论规则。

## 执行控制 (Execution Controls)

审查者是并行执行的，但是是受限制的。

必需的控制项：

- 并发限制
- 单个审查者的超时限制
- 提供商重试/退避 (retry/backoff) 机制
- 在全局超时后取消
- Token 预算限制
- 估算成本预算
- 部分结果的保留 (partial result preservation)

`asyncio.gather` 风格的快速失败 (fail-fast) 行为是不被允许的，因为一个失败的审查者不应该让其他正在执行中的审查结果被抛弃。

## 大体积 Diff 处理 (Large Diff Handling)

大量变更不应该被静默截断。

当输入超过了配置的限制，引擎应该选择一个显式的策略：

- 以清晰的错误信息宣告失败
- 按文件或者差异块 (hunk) 切分后执行审查
- 在保留发生变更的 hunks 前提下，尝试对低风险的上下文进行摘要
- 要求调用方缩小范围

所选策略必须记录在元数据里。如果仅审查了部分 Diff，整体 `status` 必须是 `degraded`，`verdict` 反映已完成审查者的判断。

## 确定性与去重 (Determinism and Deduplication)

该引擎应产生稳定的机器可读的结果输出。

- 审查者的结果是根据配置中审查者的排序顺序来进行排序。
- 发现项 (Findings) 会生成稳定的 IDs，该 ID 由标准化的位置信息、类别、标题以及审查者 id 计算派生而来。
- 汇总后的发现项也有稳定的 ID，由合并的发现项标识派生而来。
- 对于由于标准化位置信息一样、类别一样以及同样带有相同语义标题造成的重复 Findings 都会作去重合并。
- 输出数组通过严重级别、路径、行号和 ID 保证具有确定性的稳定排序。

这可以避免未来在 PR 集成上引发“片状的测试(flaky tests)”或一直重复发送相同的评论。

## CLI 行为 (CLI Behavior)

CLI 的默认行为：

- 没有参数：审查当前工作目录的变更
- `--staged`: 审查暂存区的变更
- `--base <ref>`: 审查对比目标基础引用分支(base ref)的差异
- `--summary`: 输出人类可读的摘要
- stdin patch input：当提供数据时审查标准输入的内容

CLI 决策控制：

- 默认决策策略：多数决 (`majority`)
- 重大影响审查可以显式启用全体通过模式：`--decision-policy unanimous`

默认输出为严格 JSON 到 stdout。日志、警告、进度始终写入 stderr。当没有提供标准的 stdin 传入内容时，CLI 必须避免假死挂起的情形。

## 测试策略 (Testing Strategy)

### 单元测试 (Unit Tests)

- 规范的 diff 解析器 (canonical diff parser)
  - 添加的文件
  - 修改的文件
  - 删除的文件
  - 重命名的文件
  - 二进制文件
  - 权限 (mode) 变更
  - 多个 hunks
  - 没有换行(newline)标记
- 配置加载器
  - 默认配置
  - 本地覆盖配置
  - 验证奇数审查者的要求
  - 信任边界策略的强制执行
- 编排器 (orchestrator)
  - 受限制的并发
  - 审查者部分失败
  - 超时
  - 取消
  - 成本超预出
- 标准化器 (normalizer)
  - 有效规范的模型 JSON
  - 格式错误的模型输出
  - 缺失必填字段
  - 提供商特定的报错诊断信息
- 汇总器 (aggregator)
  - 合并重复的发现
  - 保留审查者来源信息
  - 汇总评论
  - 标准化错误
  - 保守性质的后备措施
- 决策策略 (decision policy)
  - 多数批准
  - 多数要求修改
  - 全体通过要求
  - 审查者 `status = error` 导致整体 `status = degraded`
  - 流程失败或没有可用证据导致整体 `status = error`
- 报告器 (reporter)
  - 严格确保 stdout 中的纯 JSON
  - 验证写入 stderr 中的警告
  - 内容确定性的顺序

### 契约测试 (Contract Tests)

- 发生成功时维持的稳定 `ReviewResult` 包装结构
- 由于审查者失败带来降级情况下依然稳定的 `ReviewResult` 包装结构
- 汇总器规则兜底发生时稳定的 `ReviewResult` 包装结构
- 覆盖所有 `verdict`（`approve`、`request_changes`、`none`）和 `status`（`completed`、`degraded`、`error`）组合
- Schema 对于版本的兼容性
- 机器端能正确解析默认 JSON 输出

### 端到端测试 (End-to-End Tests)

- `magi-review`
- `magi-review --staged`
- `magi-review --base main`
- `magi-review --summary`
- 管道符式 stdin patch 传入输入测试
- 带有单个审查者失败情况的处于降级情况并有着保守判定结果的测试
- 涵盖能够测试汇总器失败后执行兜底下操作的验证

## 开放的扩展点 (Open Extension Points)

首个版应当把这些能够扩展开放的地方规划清楚并保留在代码架构中，且暂时不要求每一样适配都要做到全开发实现：

- MCP 服务器端适配 (adapter)
- GitHub Action 端适配
- 自定义的审查角色文件
- 添加其它的模型提供商
- 代码差异 (code diffs) 之外的其他不同制品的审查

这些所有扩展点必须完全复用内核已有的契约配置设计等来执行，以替换其去单另创设新的独立行为和机制的规则实现。
