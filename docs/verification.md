# 验证记录

记录日期：2026-10-18（最终更新 2026-10-19 00:20，北京时间）。实现版本 0.1.0，DSH 兼容基线 0.2.1-rc.2。

本记录区分三类证据：**自动化测试**（可重复）、**真实 DSH 运行**（本机 desktop profile，真实模型与沙箱）、**Host 侧渲染模拟**（真实结果数据 + Client 模块 VM 执行）。GUI 目视验收仍属未完成项，见文末清单。

## 1. 自动化测试

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

## 2. 真实 DSH 运行（desktop profile，真实模型）

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

## 3. 三灯卡 Host 侧渲染模拟

无法从 Host 侧截图 GUI，因此用真实报告 `27afcae3` 的 `buildCardPayload(result)` 输出送入 `lib/client.js` 的 VM 执行（React stub），验证 Client 模块的归一化与渲染逻辑：

- `normalizePayload` 可解析真实 payload：`available:true`、verdict `request_changes`、3 席、17 findings。
- 折叠态文本 184 字符，包含 `MAGI · REQUEST_CHANGES (0/3) · 2 blocking · council · 5m 13s`、每席最终票与 degraded 标签。
- 展开态渲染 29283 字符，包含席位、Findings、裁决、讨论、纪要各区块。
- 运行态（phase=start）仅输出 32 字符的 “A B C MAGI · 审查进行中 / 匿名进度 · 等待最终结果”，不含身份、模型、票数或倾向。

该模拟证明卡片数据链路和渲染代码可执行，但不替代浏览器中的主题、布局与交互目视验收。

## 4. 手工验收清单

已由自动化/真实运行覆盖：

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

## 5. 未验证项

1. **Windows 符号链接**：2 项用例因 EPERM skip；隔离性未在本机验证。
2. **真实异构 provider 故障回退**：跨路由（deepseek-official / deepseek-account / openrouter）分配已实现并容错，但未触发真实 auth/限流/路由消失后的自动换路由；当前策略是分配时排除不可用路由，运行失败按失败矩阵降级。
3. **成本基准**：`metadata.usage` 中的 input/output token 是字符数估算；只有书记官/纪要的 LLM 调用会计入真实 usage，子 agent 侧未采集账单数据。
4. **GUI 与平台行为**：见第 4 节未完成清单。
