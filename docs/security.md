# 安全与匿名边界

适用于 MAGI Review 0.1.0 / DSH 0.2.1-rc.2。MAGI 形成审查证据与规则裁决，不提供独立沙箱，也不保证模型判断正确。配置含义见 [README](../README.md)，未实现的设计能力见 [实现说明](implementation-notes.md)。

## 定论前的匿名

插件内的讨论与表决使用 A/B/C 等 `seatRef`。`lib/core/anonymity.js` 从白名单字段重建 docket，包括嵌套 location/evidence；不会直接转发 SeatBrief 的模型、身份、childSessionId 或工具轨迹。它净化已知身份文本；`lib/host/council.js` 对配置中的席位、视角与 provider/model 再做净化。

各席首轮互不可见；quick 的最终投票只看到自己的材料；council 的最终投票看到匿名 docket/讨论，但看不到其他席的最终票。引擎等待密封表决批次结束后调用 `decide()`，随后生成 `reveal.at='verdict'`。任何模型都不能修改规则裁决；纪要在揭示后生成。

入口没有输出中间席位结果的通道。`buildCardPayload` 要求 reveal，digest 的揭示前分支隐藏身份/票数；Client 在读取 payload 前检查结果阶段。卡片运行中刻意只显示匿名占位，不用颜色表达票向，也不声称提供实况进度。childId/childSessionId 不在结果中提前暴露，陈词的证据会话定位仅在最终报告可见。

**残余风险：DSH 子会话仍可被平台 catalog、会话列表或会话日志发现。** `delivery:'caller'` 阻止的是完成通知，不是目录访问权限；有平台或本地日志权限的人仍可能在裁决前观察角色、提示或票。一次性子 agent 避开 `sendMessage` 冷恢复默认父通知的泄票路径；不提前公开 childId 与占位卡片降低插件主动暴露，但不能实现平台级秘密账本。需平台提供私有子会话或延迟公开，才能进一步收紧此边界。

已知身份字符串净化不能防止模型用暗语、未知别名、编码或文风暗示身份。目录同一模型 id 会标为同构；异构标签也不是统计独立性证明。

## 权限与工具边界

| 阶段 | preset / 工具 | 强制边界 |
|---|---|---|
| 独立陈词 | `magi-reviewer-readonly`；read、grep、glob；已有 lsp 可被允许 | preset 不注册 write/edit/shell；guard 拒绝白名单外的工具。 |
| 允许脚本的讨论 | `magi-reviewer-verify`；只读文件工具 + Windows pwsh / 其他平台 bash | 只允许对应平台 shell 与白名单；继承 DSH 文件/沙箱策略。 |
| 禁止脚本的讨论 | readonly | 无 shell。 |
| 秘密表决 | readonly + Host 阶段 guard | descriptor label 为 `magi-ballot-*` 或未绑定时拒绝全部工具，包括 read 和 structured_output；用文本 JSON 回票。 |

`lib/restrict.js` 使用 **deny-by-default** guard，按调用时的 wire tool name 决定是否允许；父层后来注册的 write/edit、present、worktree、网络或其他未知工具也默认拒绝。preset 与 guard 是双保险，guard 本身不创建工具。Host 的 `agent/created` 钩子仅针对有 parentSession 且使用 MAGI preset 的子 agent 补装 guard；不会限制用户的根 agent。preset 组合失败时，Host 兜底无法挽救启动。

委托子 agent 继承父会话文件策略与沙箱，审批由 DSH runtime 固定为 `never`；无法以人工批准突破继承权限。**never 不是只读权限**：父会话若允许工作区写入，verify shell 仍可能写文件。persona 要求只读验证是行为约束，guard 只验证工具名，不解析 shell 程序语义。工作区护栏用于事后发现变更，不会撤销变更。

Host 的 Git 快照由 `node:child_process.execFile` 直接调用，属于受信任插件代码，不走子 agent 的工具审批。使用参数数组、`--end-of-options`/`--`、固定只读命令，并禁用 ext-diff/textconv。读取未跟踪内容时校验真实祖先路径；最终符号链接记录链接文本，不跟随到仓库外。这不能替代 DSH 对其他 read/shell 调用的路径策略，也不消除路径检查与读取之间的竞争。

## 提示注入与输出校验

- 代码、diff、AGENTS.md、项目配置、用户任务/agent 声称、其他席 findings 都是 **data, not instructions**。`prompts.js` 用随机 nonce 分区，并转义与当前分隔符相同的伪闭合文本；分区降低注入机会，不是模型安全证明。
- `protocol.js` 校验阶段 JSON 的类型、枚举、必填字段、seatRef 与 round 绑定，重建允许字段。发现标题/理由有长度约束；非法回复最多纠错重试一次，失败按阶段降级。并非所有自由文本都有全局字节上限。
- 规则层拒绝重复/不属于有效席位的票；纪要不得新增裁决字段、伪造席位/指纹/改票或丢失 dissent。校验失败只使用模板，不接受模型改写规则结论。
- finding 的 `evidence.command` **只作文本**。插件不执行它；讨论 reviewer 如需验证，仍必须走允许的 shell 与 DSH 策略。命令、exitCode、outputDigest 是模型提交的证据声明，并非 Host 已自动核验的执行证明。
- 工具描述明确 findings 不可信、verdict 由规则产生、insufficient 不是通过。命令 Markdown 转义文本；Client 使用文本渲染，并校验文件定位后调用宿主 openFile。复制报告、打开文件不执行 finding 命令。

文件范围/行号的协议校验不能证明 finding 引用的是冻结快照中的真实内容；额外工具读取的是当时工作区。nonce、JSON 校验与权限约束应共同使用，不能把合法 JSON 等同于可信证据。

## 脱敏与 RedactionReport

默认 `security.redactSecrets:true`。`lib/core/redact.js` 的规则覆盖：私钥块、`sk-` API key、AWS access key、GitHub token、Slack token、敏感键赋值（api_key/secret/token/password）、Bearer token、带用户名密码的 URL、环境变量赋值行。重叠命中合并为替换区间，用 `[REDACTED:<rule>]` 代替原值；环境赋值规则较宽，可能同时隐藏普通配置。

Host 在提示组装前扫描快照、意图与请求；进入后续讨论/纪要前扫描结构化席位输出，最终返回/落盘前再扫描结果。原始 patchHash 保留用于定位。`RedactionReport` 存于 `result.redaction`：`enabled`、`count`、`hits[{rule,index,field}]`，其中 index 为被扫描字符串的 UTF-16 偏移，field 指向快照/意图/结果字段；不包含匹配原值。count 是扫描阶段累计替换区间数，不是唯一秘密数量或原文件行号统计。

**fail-closed：**输入扫描器异常或返回形状非法时返回 `REDACTION_FAILED`，不调用模型；席位输出扫描失败时中止后续模型工作；最终扫描失败时不返回/存储该报告。提供商原始异常、rawOutput 不进入正常公开报告；minutes 只保留最多 1000 字符的校验错误和原始长度诊断。

扫描器是模式匹配，不能覆盖所有秘密、生产数据、编码值或对象键。它也**不拦截子 agent 通过 read/grep/shell 直接取得的原始工具结果**，这些结果可能进入 provider 与 DSH 会话日志。关闭脱敏会移除此层保护；报告不是秘密存储库，宿主日志与文件权限仍须单独管理。

`security.allowThirdPartyProviders` 默认 true，配置目录中的第三方模型可以收到送审内容；当前没有首次外发提示。设为 false 时，当前代码只接受 provider id 以 `deepseek-` 开头的路由，冲突的默认路由/pin 会报错。这是基于配置名称的信任规则，不能认证实际网络端点。脱敏不等于禁止外发，shell 网络行为取决于 DSH/操作系统沙箱。

## 工作区突变护栏与存储

`guard.js` 在 reviewer 执行前、完成后采集 `git.js:statusFingerprint`（状态、差异与未跟踪内容等指纹）。变化时记录 `workspaceMutatedDuringReview:true` 和 `workspace_mutated_during_review`，将原 approve 改为 insufficient，并降级 trust；原 request_changes 不变。无法取得指纹则记录 `workspace_guard_unavailable`，不能把“未检测到”解释为“没有变化”。

护栏是两个时间点的比较，不能检测“改后恢复”、窗口外变更、所有被忽略文件或网络副作用，也不能归因于具体 reviewer。审查期间的用户编辑也会触发降级；Host 不回滚用户工作。

报告默认写到 `~/.dsh/storages/magi-review/default/reviews/`，不写入被审仓库。store 校验 schemaVersion/reportId，拒绝路径穿越及 Windows 保留文件名；用同目录临时文件 + hard link 发布不可变报告，并可重建索引。文件未加密，Windows ACL/本地访问控制由宿主环境负责；profile 环境变量隔离和跨进程 cache 协调仍有局限。

## 已知残余风险

1. 平台 catalog、侧栏与日志可发现子会话；未知身份暗示不能完全净化。
2. verify shell 的只读意图不是系统只读保证；网络/外部副作用取决于继承沙箱，护栏仅事后检测部分工作区变更。
3. 模式脱敏会漏检、误伤；直接工具读取不经过 Host 扫描，第三方 provider 默认允许且无首次提示。
4. 合法 JSON、finding 位置和命令摘要不证明证据真实；prompt 注入和模型从众仍可能影响内容。
5. 运行时同路由重试、首轮票回退可能遗漏后续证据；必须结合 degradedReasons 复核。
6. token/费用是局部估算，无法保证美元硬上限；超时清理失败/延迟仍受平台生命周期约束。
7. 本地报告与 DSH 日志未加密，当前默认 profile namespace 不自动隔离，cache 尚无跨进程协调。
8. Windows 符号链接安全用例因权限跳过；DSH rc API、权限钩子时序和真实 GUI 仍需部署验收。

对应自动测试与待验项目见 [verification.md](verification.md)。
