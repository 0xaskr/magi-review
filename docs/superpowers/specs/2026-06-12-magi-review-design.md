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
  -> synthesize ReviewResult
  -> report text/json
```

### Layers

1. **Adapter Layer**
   - Handles source-specific input and output integration.
   - The first adapter is CLI.
   - Future adapters include MCP server, GitHub Action, and agent tool wrappers.
   - Adapters may collect platform-specific metadata, but they must not implement review semantics.

2. **Core Layer**
   - Owns config loading, canonical diff normalization, orchestration, normalization, synthesis, and result contracts.
   - Exposes stable APIs for adapters.
   - Does not know whether it is called by CLI, MCP, CI, or an agent runtime.

3. **Model Provider Layer**
   - Wraps Anthropic, OpenAI, Gemini, local models, or other providers behind one provider interface.
   - Reviewer roles depend on the provider interface, not provider SDKs.
   - Provider-specific metadata is preserved in diagnostics but normalized before synthesis.

4. **Reporting Layer**
   - Emits human-readable terminal output.
   - Emits strict JSON for machine consumers.
   - In `--json` mode, stdout is reserved for JSON only; logs, warnings, progress, and diagnostics go to stderr.

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

The adversarial reviewer should not also act as final judge. Final judgment belongs to a separate synthesizer/arbiter stage.

## Synthesizer / Arbiter

The synthesizer receives normalized reviewer results and produces the final `ReviewResult`.

Responsibilities:

- merge duplicate findings
- preserve reviewer provenance
- resolve conflicts conservatively
- assign final severity and blocking status
- produce a top-level verdict
- explain degraded or incomplete review quality

The synthesizer may use a model provider, but its output must be normalized into the same stable result schema as any fallback path.

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

```ts
type ReviewInput = {
  schemaVersion: "1.0";
  source: "git-diff" | "patch" | "stdin" | "pr-diff";
  repository?: {
    root?: string;
    branch?: string;
    baseRef?: string;
    headRef?: string;
    commitSha?: string;
  };
  changes: Change[];
  context?: ReviewContext;
  inputHash: string;
};

type Change = {
  path: string;
  oldPath?: string;
  language?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  isBinary?: boolean;
  modeChange?: {
    oldMode?: string;
    newMode?: string;
  };
  hunks: Hunk[];
};

type Hunk = {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
  noNewlineAtEndOfFile?: boolean;
};

type ReviewContext = {
  task?: string;
  aiTool?: "claude" | "codex" | "gemini" | "opencode" | "unknown";
  instructions?: string;
};
```

## Finding Location Model

Findings need enough location data for CLI output and future PR comments.

```ts
type FindingLocation = {
  path: string;
  oldPath?: string;
  side: "old" | "new";
  line?: number;
  range?: {
    startLine: number;
    endLine: number;
  };
  hunkId?: string;
  commitSha?: string;
};
```

A finding may omit location only when it is genuinely repository-level or change-level.

## Reviewer Result Schema

```ts
type ReviewerResult = {
  reviewerId: string;
  role: string;
  required: boolean;
  model: string;
  provider: string;
  status: "completed" | "degraded" | "failed";
  degradationReason?:
    | "api_error"
    | "timeout"
    | "invalid_output"
    | "rate_limited"
    | "budget_exceeded"
    | "cancelled";
  verdict: "approve" | "comment" | "request_changes" | "inconclusive";
  findings: ReviewerFinding[];
  rawOutput?: string;
  metadata: ReviewerMetadata;
};

type ReviewerFinding = {
  id: string;
  location?: FindingLocation;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category:
    | "correctness"
    | "security"
    | "architecture"
    | "maintainability"
    | "testing"
    | "performance"
    | "adversarial";
  confidence: "high" | "medium" | "low";
  title: string;
  rationale: string;
  suggestion?: string;
};

type ReviewerMetadata = {
  startedAt: string;
  finishedAt?: string;
  promptHash: string;
  configHash: string;
  inputHash: string;
  tokenUsage?: {
    input?: number;
    output?: number;
  };
};
```

## Review Result Envelope

Every output path uses the same JSON envelope: success, degraded success, synthesizer fallback, and failure.

```ts
type ReviewResult = {
  schemaVersion: "1.0";
  status: "completed" | "degraded" | "failed";
  quality: "complete" | "degraded";
  verdict: "approve" | "comment" | "request_changes" | "inconclusive";
  synthesisStatus: "completed" | "degraded" | "failed";
  synthesisMode: "model" | "rule_fallback" | "raw_reviewer_results";
  summary: string;
  findings: SynthesizedFinding[];
  reviewerResults: ReviewerResult[];
  errors: ReviewError[];
  metadata: ReviewMetadata;
};

type SynthesizedFinding = {
  id: string;
  sourceReviewerIds: string[];
  location?: FindingLocation;
  severity: "critical" | "high" | "medium" | "low" | "info";
  category: string;
  confidence: "high" | "medium" | "low";
  title: string;
  rationale: string;
  suggestion?: string;
  status: "blocking" | "non_blocking";
};

type ReviewError = {
  source: "input" | "config" | "reviewer" | "synthesizer" | "reporter";
  code: string;
  message: string;
  reviewerId?: string;
};

type ReviewMetadata = {
  startedAt: string;
  finishedAt?: string;
  inputHash: string;
  configHash: string;
  roleVersions: Record<string, string>;
  providerModels: Record<string, string>;
};
```

## Verdict Rules

The engine should avoid fail-open behavior.

- If all required reviewers complete and no blocking findings exist, verdict may be `approve`.
- If any required reviewer fails or degrades, the final verdict must not be `approve`.
- If a required reviewer is missing and no blocking finding exists, use `comment` or `inconclusive` depending on configured strictness.
- If any reviewer reports a confirmed critical or high blocking issue, default to `request_changes` unless the synthesizer explicitly downgrades it with rationale.
- If the synthesizer fails, use conservative rule fallback.
- If no usable reviewer result exists, return `failed` or `inconclusive` in the stable envelope.

## Degraded Operation

Single reviewer/API failure must not immediately fail the entire review.

For each failed reviewer:

- set reviewer `status` to `failed` or `degraded`
- record `degradationReason`
- preserve error metadata in `errors`
- continue with remaining reviewers

The top-level result must reflect degraded quality. Degraded quality must be visible to both humans and machine consumers.

## Synthesizer Failure Handling

The synthesizer is retried according to config:

- `synthesizer.maxRetries`
- `synthesizer.retryBackoffMs`
- `synthesizer.timeoutMs`

If it still fails:

- keep the stable `ReviewResult` envelope
- set `synthesisStatus: "failed"`
- set `synthesisMode: "raw_reviewer_results"` or `"rule_fallback"`
- include raw reviewer conclusions inside `reviewerResults`
- derive a conservative top-level verdict using rule fallback
- mark `quality: "degraded"`

Fallback must never emit free-form raw text as the primary JSON output.

## Configuration

The tool should run with zero config.

Example commands:

```text
magi-review
magi-review --staged
magi-review --base main
magi-review --json
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
synthesizer:
  model: claude-opus
  maxRetries: 2
  retryBackoffMs: 1000
  timeoutMs: 60000
execution:
  concurrency: 2
  reviewerTimeoutMs: 120000
  maxInputTokens: 120000
  maxEstimatedCostUsd: 5
output:
  format: text
```

Configuration rules:

- reviewer count must be odd
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

Diffs, code comments, commit messages, config text, and task descriptions are untrusted input. Reviewer and synthesizer prompts must clearly separate system instructions from reviewed content.

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

`Promise.all`-style fail-fast behavior is not acceptable for reviewer execution because one failed reviewer must not discard other in-flight results.

## Large Diff Handling

Large diffs must not be silently truncated.

When input exceeds configured limits, the engine should choose an explicit strategy:

- fail with a clear error
- split by file or hunk and review chunks
- summarize lower-risk context while preserving changed hunks
- ask the caller to narrow scope

The selected strategy must be recorded in metadata. If only part of the diff is reviewed, the result must be degraded and cannot be `approve`.

## Determinism and Deduplication

The engine should produce stable machine-readable output.

- reviewer results are ordered by configured reviewer order
- findings have stable IDs derived from normalized location, category, title, and reviewer id
- synthesized findings have stable IDs derived from merged finding identity
- duplicate findings are merged by normalized location, category, and semantic title
- output arrays use deterministic ordering by severity, path, line, and id

This avoids flaky tests and repeated comments in future PR integrations.

## CLI Behavior

CLI defaults:

- no arguments: review current working tree diff
- `--staged`: review staged changes
- `--base <ref>`: review diff against a base ref
- `--json`: write strict JSON to stdout
- stdin patch: review stdin content when data is provided

CLI must avoid hanging when stdin is not actually provided. JSON mode must not write warnings or progress to stdout.

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
- synthesizer
  - duplicate finding merge
  - conflicting reviewer verdicts
  - failed synthesis retry
  - conservative fallback
- reporter
  - strict stdout JSON
  - stderr warnings
  - deterministic ordering

### Contract Tests

- stable `ReviewResult` envelope for success
- stable `ReviewResult` envelope for degraded reviewer failure
- stable `ReviewResult` envelope for synthesizer fallback
- schema version compatibility
- machine parsing of `--json`

### End-to-End Tests

- `magi-review`
- `magi-review --staged`
- `magi-review --base main`
- `magi-review --json`
- stdin patch input
- single reviewer failure with degraded conservative verdict
- synthesizer failure with rule fallback

## Open Extension Points

The first version should preserve these extension points without fully implementing every adapter:

- MCP server adapter
- GitHub Action adapter
- custom reviewer role files
- additional model providers
- artifact review beyond code diffs

These extension points must reuse core contracts instead of creating separate review semantics.
