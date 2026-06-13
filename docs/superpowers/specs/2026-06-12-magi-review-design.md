# Magi Review Design

## Product Positioning

`magi-review` is a multi-model, multi-agent review engine for AI-generated code changes. It is designed to be embedded into different agent workflows, including Claude, Codex, Gemini, opencode, CI, and future GitHub integrations.

The first version focuses on code review for AI-generated diffs, patches, staged changes, and stdin-provided unified diffs. Review of plain text answers and generic artifacts is explicitly secondary and should not dilute the first-version code-review scope.

The product identity is the review engine. The CLI is the first adapter, not the core product boundary.

## Goals

- Review AI-generated code changes from multiple independent perspectives.
- Provide machine-readable JSON as the primary interface.
- Support local CLI usage first while preserving clean boundaries for future MCP, GitHub Action, and agent-tool adapters.
- Keep reviewer roles configurable, extensible, and loadable.
- Prefer safe degraded output over single-point failure, while avoiding fail-open approvals.

## Non-goals

- Building a web UI in the first version.
- Supporting arbitrary non-code artifacts before code review is reliable.
- Coupling review logic to GitHub, MCP, or any single agent runtime.
- Treating model output as trusted structured data without normalization.

## Architecture

The first version uses a core library plus CLI-first architecture.

```text
CLI / future adapter
  -> collect source-specific input
  -> core normalizes diff/context
  -> build ReviewInput
  -> load ReviewConfig
  -> run reviewer agents
  -> normalize ReviewerResult[]
  -> aggregate review evidence
  -> apply decision policy
  -> build ReviewResult
  -> report json
```

### Layers

1. **Adapter Layer**
   - Handles source-specific input and output integration.
   - The first adapter is CLI.
   - Future adapters include MCP server, GitHub Action, and agent tool wrappers.
   - Adapters may collect platform-specific metadata, but they must not implement review semantics.

2. **Core Layer**
   - Owns config loading, canonical diff normalization, orchestration, normalization, aggregation, and result contracts.
   - Exposes stable APIs for adapters.
   - Does not know whether it is called by CLI, MCP, CI, or an agent runtime.

3. **Model Provider Layer**
   - Wraps Anthropic, OpenAI, Gemini, local models, or other providers behind one provider interface.
   - Reviewer roles depend on the provider interface, not provider SDKs.
   - Provider-specific metadata is preserved in diagnostics but normalized before aggregation.

4. **Reporting Layer**
   - Outputs strict JSON to stdout by default.
   - Optional `--summary` flag outputs a human-readable summary.
   - Logs, warnings, progress, and diagnostics always go to stderr.

## Default Reviewer Roles

Reviewer count must be odd. The default configuration includes three required reviewers.

### Breadth-First Architect

Focuses on broad architectural impact:

- module boundaries
- design consistency
- coupling and abstraction changes
- cross-system impact
- whether the change introduces unnecessary complexity

### Depth-First Engineer

Focuses on implementation-level correctness:

- bugs and edge cases
- type and API correctness
- concurrency and ordering hazards
- performance regressions
- testability and maintainability

### Adversarial Reviewer

Focuses on breaking the change:

- failure paths
- security and abuse cases
- prompt-injection-sensitive behavior
- data loss and rollback hazards
- missing tests for non-happy paths
- hidden AI hallucination effects

The adversarial reviewer should not also act as final judge. The final verdict is determined by the decision policy based on evidence produced by the aggregator.

## Aggregator

The aggregator receives normalized reviewer results and produces aggregated review evidence for the decision policy. It does not decide the final top-level verdict.

Responsibilities:

- merge duplicate findings
- preserve reviewer provenance
- aggregate reviewer comments
- normalize reviewer errors
- resolve finding-level conflicts conservatively
- assign aggregated severity and blocking status to findings
- produce a factual summary for the decision policy
- explain degraded or incomplete review evidence

The aggregator may use a model provider, but its output must be normalized into the same stable evidence schema as any fallback path. If the aggregator fails, rule fallback must still preserve reviewer results and provide conservative evidence for the decision policy.

## Decision Policy

The decision policy consumes aggregated evidence and determines the final `ReviewResult.verdict`. Decision logic is implemented by the core script/policy layer, not by reviewer roles or the aggregator.

### Impact Rating and Policy Escalation

Each reviewer provides an impact rating alongside its verdict: `major` or `normal`. The aggregator collects impact ratings from all usable reviewers and determines the overall impact by majority vote:

- If a majority of reviewers rate the change as `major`, the overall impact is `major` and the decision policy automatically escalates to unanimous approval.
- If a majority of reviewers rate the change as `normal`, the overall impact is `normal` and the default majority policy applies.

The CLI flag `--decision-policy unanimous` can explicitly force unanimous mode regardless of reviewer impact ratings.

### Policy Rules

The default policy is majority vote among required reviewers. When the overall impact rating is `major`, the CLI explicitly specifies unanimous mode, or configuration requires unanimous approval, the policy escalates to unanimous.

Decision policies must preserve these invariants:

- reviewer count must be odd
- when `status = degraded` or `status = error`, consumers should combine `status` with `verdict` to decide trust

### Verdict Mapping Under Majority Policy (default, 3 reviewers)

| Reviewer A | Reviewer B | Reviewer C | Overall status | Overall verdict | Notes |
|---|---|---|---|---|---|
| approve | approve | approve | `completed` | `approve` | Unanimous approval |
| approve | approve | request_changes | `completed` | `approve` | Majority approves |
| approve | approve | error | `degraded` | `approve` | Majority approves but error degrades result |
| approve | request_changes | request_changes | `completed` | `request_changes` | Majority requests changes |
| approve | request_changes | error | `degraded` | `request_changes` | Has request_changes and error |
| approve | error | error | `degraded` | `approve` | Only approval with no objection, result degraded |
| request_changes | request_changes | request_changes | `completed` | `request_changes` | Unanimous request changes |
| request_changes | request_changes | error | `degraded` | `request_changes` | Majority requests changes |
| request_changes | error | error | `degraded` | `request_changes` | Has request_changes |
| error | error | error | `error` | `none` | All errored, no usable judgment |

### Verdict Mapping Under Unanimous Policy (major impact mode)

| Reviewer A | Reviewer B | Reviewer C | Overall status | Overall verdict | Notes |
|---|---|---|---|---|---|
| approve | approve | approve | `completed` | `approve` | Unanimous approval |
| approve | approve | request_changes | `completed` | `request_changes` | Not unanimous |
| approve | request_changes | request_changes | `completed` | `request_changes` | Not unanimous |
| any with error (not all) | — | — | `degraded` | completed reviewers' judgment | Error degrades result |
| error | error | error | `error` | `none` | All errored, no usable judgment |

## Implementation Language

All production code, tests, and first-party tooling are implemented in Python. Schema examples in this document are illustrative contracts; implementation should represent them with Python types such as dataclasses, Pydantic models, TypedDicts, or equivalent project-standard Python constructs.

## Canonical Diff Contract

All input sources must be normalized before review. The canonical diff model must support:

- source type: `git-diff`, `patch`, `stdin`, `pr-diff`
- added, modified, deleted, renamed files
- old and new paths
- binary files
- file mode changes
- old/new line mapping
- hunk ranges
- deleted lines and added lines
- `no newline at end of file` markers
- optional commit and repository metadata

Adapters may collect source-specific input, but core owns canonical normalization and validation.

## Review Input Schema

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

## Finding Location Model

Findings need enough location data for CLI output and future PR comments.

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

A finding may omit location only when it is genuinely repository-level or change-level.

## Reviewer Result Schema

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

## Review Result Envelope

Every output path uses the same JSON envelope: success, degraded success, aggregator fallback, and failure.

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

## Verdict Rules

The engine should avoid fail-open behavior. Review judgment and execution status are fully separated:

**Individual Reviewer:**

- `status`: `completed | error` — execution status, whether the reviewer finished successfully
- `verdict`: `approve | request_changes` — review judgment, only valid when `status = completed`
- `impact`: `major | normal` — impact rating, only valid when `status = completed`

**Overall Review:**

- `status`: `completed | degraded | error` — pipeline status
- `verdict`: `approve | request_changes | none` — final verdict from the decision policy

Overall `status` semantics:

- `completed`: all required reviewers finished successfully.
- `degraded`: at least one required reviewer returned `error`, but other reviewers have usable results.
- `error`: pipeline cannot produce enough usable evidence (all reviewers errored, or input/core failure).

Overall `verdict` semantics:

- `approve`: the decision policy has enough approval.
- `request_changes`: the decision policy determines the change must be modified.
- `none`: not enough completed reviewers to form a judgment (`status = error`).

When `status = degraded`, `verdict` still reflects the actual judgment of completed reviewers; consumers should combine `status` with `verdict` to decide whether to trust the result. When `status = error`, `verdict` is `none`.

## Degraded Operation

Single reviewer/API failure must not immediately fail the entire review.

For each failed reviewer:

- set reviewer `status` to `error`
- record `error_reason`
- preserve error metadata in `errors`
- continue with remaining reviewers

The top-level `status` must reflect execution degradation. If at least one reviewer returns `error`, the overall `status` is `degraded`. `verdict` still reflects the actual judgment of completed reviewers; consumers should combine `status` with `verdict` to decide trust.

## Aggregator Failure Handling

The aggregator is retried according to config:

- `aggregator.max_retries`
- `aggregator.retry_backoff_ms`
- `aggregator.timeout_ms`

If it still fails:

- keep the stable `ReviewResult` envelope
- set `aggregation_status: "failed"`
- set `aggregation_mode: "raw_reviewer_results"` or `"rule_fallback"`
- include raw reviewer conclusions inside `reviewer_results`
- preserve aggregated evidence from rule fallback when available
- let the decision policy derive a verdict based on completed reviewers' judgments

Fallback must never emit free-form raw text as the primary JSON output. When the aggregator fails, overall `status` is `degraded` or `error`, and `verdict` reflects completed reviewers' judgments.

## Configuration

The tool should run with zero config.

Example commands:

```text
magi-review
magi-review --staged
magi-review --base main
magi-review --summary
```

Example configuration:

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

Configuration rules:

- reviewer count must be odd
- decision policy defaults to `majority`
- `unanimous` approval can be required by CLI flag, trusted config, or high-impact review mode
- built-in roles can be overridden only through explicit configuration
- external role files are loadable
- CLI flags override local configuration for non-sensitive behavior
- sensitive provider settings follow trust-boundary rules

## Configuration Trust Boundary

Repository-controlled config is untrusted when reviewing pull requests or external patches.

The first version should prevent untrusted config from silently changing:

- provider endpoints
- API credential source
- required reviewer flags
- role prompt strength
- model class used for security-sensitive roles
- output destination

Trusted config may come from user home config, CI secrets, explicit CLI flags, or a protected base branch. PR-provided config can tune non-sensitive project preferences, but must not weaken review policy by default.

## Security and Privacy

### Secret Redaction

Before sending diff or context to model providers, the core should scan for likely secrets and sensitive values. Redaction should apply to:

- API keys and tokens
- private keys
- `.env`-style assignments
- credentials in URLs
- obvious customer or production secrets

Redaction should be recorded in metadata without exposing the redacted value.

### Prompt Injection Boundary

Diffs, code comments, commit messages, config text, and task descriptions are untrusted input. Reviewer and aggregator prompts must clearly separate system instructions from reviewed content.

Reviewed content must not be allowed to override reviewer role instructions, output schema, or verdict rules.

## Execution Controls

Reviewer execution is parallel but bounded.

Required controls:

- concurrency limit
- per-reviewer timeout
- provider retry/backoff
- cancellation after global timeout
- token budget
- estimated cost budget
- partial result preservation

`asyncio.gather`-style fail-fast behavior is not acceptable for reviewer execution because one failed reviewer must not discard other in-flight results.

## Large Diff Handling

Large diffs must not be silently truncated.

When input exceeds configured limits, the engine should choose an explicit strategy:

- fail with a clear error
- split by file or hunk and review chunks
- summarize lower-risk context while preserving changed hunks
- ask the caller to narrow scope

The selected strategy must be recorded in metadata. If only part of the diff is reviewed, overall `status` must be `degraded` and `verdict` reflects completed reviewers' judgments.

## Determinism and Deduplication

The engine should produce stable machine-readable output.

- reviewer results are ordered by configured reviewer order
- findings have stable IDs derived from normalized location, category, title, and reviewer id
- aggregated findings have stable IDs derived from merged finding identity
- duplicate findings are merged by normalized location, category, and semantic title
- output arrays use deterministic ordering by severity, path, line, and id

This avoids flaky tests and repeated comments in future PR integrations.

## CLI Behavior

CLI defaults:

- no arguments: review current working tree diff
- `--staged`: review staged changes
- `--base <ref>`: review diff against a base ref
- `--summary`: output human-readable summary
- stdin patch: review stdin content when data is provided

CLI decision controls:

- default decision policy: majority
- explicit unanimous mode for high-impact reviews: `--decision-policy unanimous`

Default output is strict JSON to stdout. Logs, warnings, and progress always go to stderr. CLI must avoid hanging when stdin is not actually provided.

## Testing Strategy

### Unit Tests

- canonical diff parser
  - added files
  - modified files
  - deleted files
  - renamed files
  - binary files
  - mode changes
  - multiple hunks
  - no-newline markers
- config loader
  - default config
  - local overrides
  - odd reviewer validation
  - trust-boundary enforcement
- orchestrator
  - bounded concurrency
  - partial reviewer failure
  - timeouts
  - cancellation
  - cost budget exceeded
- normalizer
  - valid model JSON
  - malformed model output
  - missing required fields
  - provider-specific diagnostics
- aggregator
  - duplicate finding merge
  - reviewer provenance preservation
  - comment aggregation
  - error normalization
  - conservative fallback
- decision policy
  - majority approval
  - majority request changes
  - unanimous approval requirement
  - reviewer `status = error` causes overall `status = degraded`
  - pipeline failure or no usable evidence causes overall `status = error`
- reporter
  - strict stdout JSON
  - stderr warnings
  - deterministic ordering

### Contract Tests

- stable `ReviewResult` envelope for success
- stable `ReviewResult` envelope for degraded reviewer failure
- stable `ReviewResult` envelope for aggregator fallback
- all `verdict` values (`approve`, `request_changes`, `none`) and `status` values (`completed`, `degraded`, `error`) combinations
- schema version compatibility
- machine parsing of default JSON output

### End-to-End Tests

- `magi-review`
- `magi-review --staged`
- `magi-review --base main`
- `magi-review --summary`
- stdin patch input
- single reviewer failure with degraded conservative verdict
- aggregator failure with rule fallback

## Open Extension Points

The first version should preserve these extension points without fully implementing every adapter:

- MCP server adapter
- GitHub Action adapter
- custom reviewer role files
- additional model providers
- artifact review beyond code diffs

These extension points must reuse core contracts instead of creating separate review semantics.
