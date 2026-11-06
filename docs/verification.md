# 验证记录

记录日期：2026-10-18（最终更新 2026-11-06，北京时间）。当前实现版本 0.2.0，DSH 兼容基线 0.2.1-rc.5（未变）。0.1.0 / DSH 0.2.1-rc.2 与 0.1.1 / DSH 0.2.1-rc.5 的记录保留为历史，结果按各自原始基线理解；0.2.0 的新验证见「0.2.0（2026-11-06）」一节。

本记录区分三类证据：**自动化测试**（可重复）、**真实 DSH 运行**（本机 desktop profile，真实模型与沙箱）、**Host 侧渲染模拟**（真实结果数据 + Client 模块 VM 执行）。GUI 目视验收仍属未完成项，见文末清单。

## 0.2.0（2026-11-06）

本版为命令交互迁移（Codex `/review` 风格）：无参数问答选择范围、`--base` 改为分支评审（merge-base → 捕获 HEAD）、新增 `--commit`/`--help` 与自然语言要求、命令移除 `--detail`；工具新增 `branch`/`commit` 目标与 `instructions` 字段，显式 `target=turn` 无快照返回 `TURN_UNAVAILABLE`。

| 项目 | 状态 |
|---|---|
| 自动化测试 | `node --test test/core/*.test.js test/host/*.test.js test/unit/*.test.js`：**461 项通过，0 失败、0 跳过**。Linux，Node.js 24。 |
| 重点覆盖 | 菜单四条路径、取消/跳过/ASK_CANCELLED、无问答服务、范围互斥、自然语言与字面尾部、分支分叉/脏工作区排除、单次/root/merge/shallow 提交、SHA-1/SHA-256、书记官协议与报告范围、失效回合快照。 |
| 语法与发布包 | 改动入口 `node --check`、`git diff --check` 通过；`npm pack --dry-run --ignore-scripts` 确认 43 个发布文件，含新增 command 模块、Host/Client、patch、locale 与 icon。 |
| 接口检查 | Inspect 核对 commands、userQuestions.ask、workingDirectory；DSH Client 的取消错误码 ASK_CANCELLED 已覆盖。工具参数 schema 从 749 增至 1088 字符，按字符/3 粗估约增加 113 token（非模型 tokenizer 实测，非完整系统提示）。 |
| 真实 DSH 命令交互与 GUI 目视（四项选择、取消、分支/提交列表、Markdown 渲染） | 未执行；自动测试使用受控问答与模型替身，不声称 GUI 或真实多席评审已验收。 |
| GitHub 安装 | 发布后通过插件管理器更新；实时应用结果以管理器返回值为准。 |

## 0.1.1（2026-11-02，历史记录）

本版记录覆盖 reviewer preset 移除（reviewer 子 agent 继承调用者 mode，改由 `lib/restrict.js` 按阶段 descriptor label 的 deny-by-default guard 限制工具）与新增模型选择（DSH 子 agent 模型选择池、显式 `provider`/`model`、书记官会话模型）。

| 项目 | 结果 |
|---|---|
| 自动化测试 | `node --test "test/core/*.test.js" "test/host/*.test.js"` 加 `node --test "test/unit/*.test.js"` 合计 **397 项，0 失败**；覆盖 core/host/unit 三个测试目录。 |
| 语法检查 | 改动模块通过 `node --check`。 |
| 新增覆盖 | `test/host/restrict.test.js` 覆盖三阶段白名单、lazy guard、未绑定 label fail-closed、MAGI 之外 label 放行；`test/host/{llm-json,session-context,orchestrator}.test.js` 覆盖模型池、显式路由校验与 `INVALID_ARGS`。 |
| 未执行 | **未执行真实多席评审、GUI 三灯卡手工验收，以及 DSH 0.2.1-rc.5 下的安装/重启复验。** |

## 1. 自动化测试（0.1.0 / DSH 0.2.1-rc.2 历史记录）

环境：Windows，Node.js v24.19.0。仓库根目录执行：

```powershell
node --test "test/core/*.test.js" "test/host/*.test.js" "test/unit/*.test.js"
node --check lib/index.js
node --check lib/client.js
Get-ChildItem lib -Recurse -Filter *.js | Select-String -Pattern "magi_ping"
```

| 范围 | 结果 |
|---|---|
| core + host + unit | **383 项：381 通过，2 跳过，0 失败**（约 8 秒） |
| 跳过项 | `test/host/git.test.js` 的两项符号链接用例：Windows 上创建目录符号链接需要开发者模式/管理员权限，`fs.symlink` 返回 EPERM，按设计 skip |
| 语法检查 | `lib/index.js`、`lib/client.js` 及 13 个核心/宿主模块全部 `node --check` 通过 |
| 调试面 | `lib/` 内无 `magi_ping` 残留；`magi_review` 工具与 `magi-review` 命令为正式入口（工具清单与 `test/unit/index.test.js` 双重确认） |

覆盖范围：

| 关注点 | 测试 |
|---|---|
| canonical diff、重命名/二进制/行号、指纹稳定、聚合 union-superset | `test/core/{canonical-diff,fingerprint,aggregate}.test.js` |
| 3/5/7 席多数/全票矩阵、重复票/重复席位、quorum、blocking、partial/insufficient、degraded approve | `test/core/policy.test.js` |
| 匿名 docket 嵌套字段与身份文本净化、揭示前匿名 digest、模板纪要与 dissent | `test/core/{anonymity,digest,minutes-template}.test.js` |
| 秘密规则、JSON 提取/校验、nonce 分区、越权纪要字段 | `test/core/{redact,json}.test.js`，`test/host/{prompts,protocol}.test.js` |
| 配置校验、pin/provider 策略、同构判定、长会话意图与回合边界 | `test/host/{config,session-context,llm-json,clerk}.test.js` |
| working-tree/staged/base-ref/patch/turn、未跟踪原字节哈希、工作区突变、路径逃逸 | `test/host/{git,guard}.test.js`（符号链接两项 skip） |
| 一次性 activation、caller delivery、超时/取消/迟到清理、讨论终止、人工确认（工具路径跳过） | `test/host/{seat,council,quick}.test.js` |
| 脱敏 fail-closed、partial 禁止通过、readonly/表决 guard、存储失败降级 | `test/host/orchestrator.test.js` |
| 不可变报告、并发发布、索引重建、schema/reportId 路径校验 | `test/host/store.test.js` |
| 纪要输入压缩与重试、短输出/截断触发 compact 重试、模板回退诊断 | `test/host/council.test.js`（M2f 后 356 项基线，最终 383 项） |
| 工具/命令注册、参数解析、来源绑定、报告查询、非法输入 | `test/unit/index.test.js`（25 项） |

## 2. 真实 DSH 运行（desktop profile，真实模型；0.1.0 / DSH 0.2.1-rc.2 历史记录）

全部为本机真实 `magi_review` 调用（3 席，显式 `target=patch`，reviewer 子 agent 由 DSH 真实启动）。报告位于 `~/.dsh/storages/magi-review/default/reviews/<reportId>.json`。

| 时间（2026-10-18 UTC） | 模式 | 输入 | verdict / status / trust | 轮次 / 耗时 | 纪要 | reportId |
|---|---|---|---|---|---|---|
| 15:20:48 | quick | `src/auth.js`（守卫绕过审计） | request_changes / completed / trustworthy | 0 / 102 秒 | 无（quick） | `0d5d7510-96ce-4dc1-bb47-959253e0ac87` |
| 15:22:40 | council | `src/cache.js`（TTL map 改写） | request_changes / degraded / needs_review | 3 / 558 秒 | `invalid`（当时模型输出被 3000 token 上限截断）→ 模板回退 | `4741cc06-a1e4-4db5-a8df-7f717306f9fe` |
| 15:56:29 | council | `src/limits.js`（第一版复测） | request_changes / degraded / needs_review | 3 / 262 秒 | `invalid`（同上，诊断 `cause:"Expected an object", rawLength:223`） | `e9b40446-1de7-4dd1-9f7d-c048cbd83556` |
| 16:01:41 | quick | `src/util.js`（类型守卫） | request_changes / completed / trustworthy | 0 / 约 100 秒 | 无（quick） | `12b077e0-dad4-40df-8f63-e498aeed6c0b` |
| 16:10:57 | council | `src/limits.js`（最终版本） | request_changes / degraded / needs_review | 3 / 313 秒 | **`ok`**（summary 845 字符，无 `MINUTES_INVALID`） | `27afcae3-2a14-46d2-93f9-796dc5621cab` |

最终 council 运行（`27afcae3`）关键事实：

- 3 席全部 completed，全部 `request_changes`；2 个 blocking finding（stale timer 删除新建 bucket 的限流绕过）；17 个 findings 聚合。
- degradedReasons 仅 `human_confirmation_missing`：讨论 3 轮未稳定，工具调用路径按设计**不阻塞等待人工**，直接进入表决并记录降级原因；命令路径仍会询问。
- `minutesStatus: ok`，不再回退模板；`errors: []`；`metadata.usage` 含 estimatedInputTokens≈351849、estimatedOutputTokens≈37733、seatsUsed 3、rounds 3。
- 同构判定 `homogeneous:false`：Architect/Engineer 用 `deepseek-flash`，对抗席由书记官分配到 `deepseek-v4-pro`（模型 id 不同即异构）。
- `scope.intent.turn=1`、任务文本非空；`coverage.partial:false`（单文件 patch）。

历史记录中两次 `minutes_invalid` 的根因：纪要被 3000 output token 上限截断（模型侧输出包含大量与 3 轮讨论相关的 JSON），解析失败。M2f 已把第一次上限提到 6000、压缩纪要输入（135170 → 19423 字符，compact 6686 字符），并对截断/短输出做 compact 重试；最终一轮验证为 `ok`。

## 3. 三灯卡 Host 侧渲染模拟（0.1.0 / DSH 0.2.1-rc.2 历史记录）

无法从 Host 侧截图 GUI，因此用真实报告 `27afcae3` 的 `buildCardPayload(result)` 输出送入 `lib/client.js` 的 VM 执行（React stub），验证 Client 模块的归一化与渲染逻辑：

- `normalizePayload` 可解析真实 payload：`available:true`、verdict `request_changes`、3 席、17 findings。
- 折叠态文本 184 字符，包含 `MAGI · REQUEST_CHANGES (0/3) · 2 blocking · council · 5m 13s`、每席最终票与 degraded 标签。
- 展开态渲染 29283 字符，包含席位、Findings、裁决、讨论、纪要各区块。
- 运行态（phase=start）仅输出 32 字符的 “A B C MAGI · 审查进行中 / 匿名进度 · 等待最终结果”，不含身份、模型、票数或倾向。

该模拟证明卡片数据链路和渲染代码可执行，但不替代浏览器中的主题、布局与交互目视验收。

## 4. 手工验收清单

已由自动化/真实运行覆盖（0.1.0 / DSH 0.2.1-rc.2 历史记录）：

- [x] desktop profile 已安装 bundle；`magi_review` 工具与 `/magi-review` 命令为唯一入口，旧调试工具 `magi_ping` 不可调用（工具清单 + 单元测试）。
- [x] 工具调用路径不再等待人工确认（`human_confirmation_missing` 立即降级，最终 council 运行 313 秒内完成 3 轮）。
- [x] 纪要成功生成（`minutesStatus:ok`），失败时模板回退与诊断仍保留（单元测试）。
- [x] 裁决、揭示、dissent、改票、blocking、覆盖率与同构标记出现在报告与工具摘要中（真实报告）。
- [x] 卡片运行态匿名、揭示后归属数据的归一化与渲染逻辑（VM 模拟）。

仍需人工在 GUI 目视确认：

- [ ] 三灯卡折叠/展开的实际视觉效果、亮/暗主题、窄窗口排版。
- [ ] 工具卡片的展开/折叠交互、`path:line` 文件跳转、复制 reportId/JSON。
- [ ] `/magi-review quick --staged`、`/magi-review council`、`/magi-review --report <id>` 命令在聊天中的 Markdown 渲染。
- [ ] 讨论轮次上限时命令路径的“继续讨论/直接表决”询问交互与超时文案。
- [ ] 匿名性残余风险：DSH 子会话仍可通过 catalog/会话列表被发现（平台限制，见 `docs/security.md`）。

0.1.1 新增待验项（全部未勾选）：

- [ ] DSH 新建任务的 mode 选择器不再出现 MAGI reviewer preset，`cordis.patch.yml` 只有 `magi-review` 一个 Host row。
- [ ] reviewer 子 agent 继承调用者当前 mode 的工具面；调用者 mode 不提供文件读取工具时按 patch 评审。
- [ ] 三个阶段 guard 的运行期行为：陈词/讨论只放行白名单，讨论按平台放行 bash/pwsh（`discussion.allowScripts:false` 时无 shell），表决拒绝全部工具。
- [ ] DSH 子 agent 模型选择设置启用时 reviewer 池生效、池首条路由成为默认路由；设置关闭时回退 `models.defaultRoute`。
- [ ] 书记官使用父会话当前运行的模型；显式 `provider`/`model` 与 `--provider/--model` 的配对及 `MODEL_SELECTION_DISABLED` / `MODEL_ROUTE_NOT_ALLOWED` / `INVALID_ARGS` 行为。

0.2.0 新增待验项（全部未勾选）：

- [ ] 无参数 `/magi-review` 出现四项范围选择与取消；取消不调用模型。
- [ ] 分支选择来自本地有界列表，也可输入分支/引用；范围为 merge-base → 当前 HEAD，不包含未提交改动。
- [ ] 提交选择来自本地有界列表，也可输入 SHA/引用；范围为该提交相对第一父提交，根提交相对空树。
- [ ] 带参数或自然语言要求直接执行；未指定范围默认 `working-tree`；要求写入 `intent.reviewInstructions` 且不改变冻结范围。
- [ ] `--base` 为 `branch` 语义；`--target base-ref --base <ref>` 保留旧“引用与工作区比较”语义。
- [ ] `--detail` 在命令上报明确错误但工具保留；`--report`/`--help` 只能单独使用；`--help` 不调用模型。
- [ ] 显式 `--target turn` 无快照返回 `TURN_UNAVAILABLE`；`auto` 仍会回退工作区。
- [ ] 当前入口无法显示问答时给出显式参数提示，且不发起评审。

## 5. 未验证项

1. **Windows 符号链接**：2 项用例因 EPERM skip；隔离性未在本机验证。
2. **真实异构 provider 故障回退**：跨路由（deepseek-official / deepseek-account / openrouter）分配已实现并容错，但未触发真实 auth/限流/路由消失后的自动换路由；当前策略是分配时排除不可用路由，运行失败按失败矩阵降级。
3. **成本基准**：`metadata.usage` 中的 input/output token 是字符数估算；只有书记官/纪要的 LLM 调用会计入真实 usage，子 agent 侧未采集账单数据。
4. **GUI 与平台行为**：见第 4 节未完成清单。
5. **0.1.1 的运行期边界（历史）**：`subagent/descriptor` label 的实际时序、guard 在真实子会话中的拦截、DSH 子 agent 模型选择池与 rc.5 安装/重启均未复验；397 项自动测试不替代这些部署验收。
6. **0.2.0 的命令交互与范围**：交互式范围问答、分支/提交有界列表、`--base` 分支语义、自然语言要求、`--detail` 错误、`TURN_UNAVAILABLE` 均有自动化覆盖，但尚未做真实 DSH 命令问答与 GUI 目视验收；本版不将模拟问答和模型替身视为真实多席评审。
