import { listReviewBranches, listReviewCommits } from './git.js';

const valueFlags = { '--base': 'base', '--commit': 'commit', '--target': 'target', '--seats': 'seats',
  '--focus': 'focus', '--report': 'report', '--provider': 'provider', '--model': 'model' };
const commandTargets = ['auto', 'working-tree', 'turn', 'staged', 'base-ref', 'branch', 'commit'];
const cancelLabel = '取消评审';

/** Quoting groups text only; neither shell evaluation nor file reads are involved. */
function tokensOf(input) {
  const tokens = [], pattern = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"'][^\s]*))(?=\s|$)/gy;
  let offset = 0;
  while (offset < input.length && input.slice(offset).trim()) {
    pattern.lastIndex = offset;
    const match = pattern.exec(input);
    if (!match) throw new Error('命令引号未闭合或参数之间缺少空格');
    tokens.push({ text: match[1] ?? match[2] ?? match[3], quoted: match[3] === undefined });
    offset = pattern.lastIndex;
    if (match[3] === '--') {
      if (input.slice(offset).trim()) tokens.push({ text: input.slice(offset).trim(), quoted: true });
      break;
    }
  }
  return tokens;
}

export function parseCommandArgs(rawInput = '') {
  const tokens = tokensOf(rawInput), args = {}, prose = [];
  let literal = false;
  const set = (key, value) => {
    if (Object.hasOwn(args, key)) throw new Error(`参数重复或冲突：${key}`);
    args[key] = value;
  };
  for (let i = 0; i < tokens.length; i++) {
    const { text: token, quoted } = tokens[i];
    if (!quoted && !literal && token === '--') { literal = true; continue; }
    if (!quoted && !literal && ['quick', 'council'].includes(token) && prose.length === 0) {
      set('mode', token); continue;
    }
    if (!quoted && !literal && token.startsWith('-')) {
      if (['--help', '-h'].includes(token)) { set('help', true); continue; }
      if (token === '--uncommitted' || token === '--staged') {
        set('target', token === '--staged' ? 'staged' : 'working-tree'); continue;
      }
      if (token === '--detail') throw new Error('--detail 已从命令移除：命令始终显示评审报告；完整 JSON 请通过 reportId 获取。');
      if (token === '--patch') throw new Error('命令不读取 patch 文件；请使用 magi_review 工具的 target=patch 与 patch 文本参数。');
      if (!Object.hasOwn(valueFlags, token)) throw new Error(`未知参数：${token}；使用 --help 查看用法。`);
      const value = tokens[++i];
      if (!value?.text.trim() || (!value.quoted && value.text.startsWith('-'))) throw new Error(`${token} 缺少参数`);
      const key = valueFlags[token];
      set(key, key === 'seats' ? Number(value.text) : key === 'focus'
        ? value.text.split(',').map(s => s.trim()).filter(Boolean) : value.text);
    } else prose.push(token);
  }
  if (prose.join(' ').trim()) args.instructions = prose.join(' ').trim();
  if (args.help || args.report !== undefined) {
    if (Object.keys(args).length !== 1) throw new Error('--help、--report 必须单独使用，不能与评审参数或要求组合。');
    return args;
  }
  if (args.target !== undefined && !commandTargets.includes(args.target)) throw new Error('命令不支持该 --target；使用 --help 查看支持的范围。');
  if (args.base !== undefined) {
    if (args.commit !== undefined || args.target !== undefined && !['branch', 'base-ref'].includes(args.target)) {
      throw new Error('--base 与其他评审范围互斥。');
    }
    args.target ??= 'branch';
  }
  if (args.commit !== undefined) {
    if (args.target !== undefined && args.target !== 'commit') throw new Error('--commit 与其他评审范围互斥。');
    args.target = 'commit';
  }
  if (['base-ref', 'branch'].includes(args.target) && !args.base) throw new Error('该范围需要 --base <分支或引用>。');
  if (args.target === 'commit' && !args.commit) throw new Error('该范围需要 --commit <提交>。');
  if (args.seats !== undefined && ![3, 5, 7].includes(args.seats)) throw new Error('--seats 只能为 3、5 或 7。');
  if ((args.provider === undefined) !== (args.model === undefined)) throw new Error('--provider 与 --model 必须成对提供');
  return args;
}

export function commandHelp(name = 'magi-review') {
  return [
    `/${name}：选择范围后启动 MAGI 评审。`, '',
    `/${name}                         打开范围选择`,
    `/${name} --uncommitted           审查暂存、未暂存及未跟踪改动`,
    `/${name} --base main             审查共同祖先到当前 HEAD 的已提交改动`,
    `/${name} --commit HEAD           仅审查该提交相对第一父提交的改动`,
    `/${name} "重点检查权限绕过和回归"   审查未提交改动，附加自然语言要求`,
    `/${name} --base main "重点检查兼容性"`,
    `/${name} --report <id>           查看已有报告，不重新评审`, '',
    '范围选项互斥；--base 不包含未提交改动，--commit 的根提交相对空树。',
    '附加要求不会改变已选择的范围。无改动时明确提示，不自动扩大范围。', '',
    '高级选项：',
    '  quick | council              简化评审 / 完整议会（默认取插件配置）',
    '  --staged                     仅暂存区',
    '  --target auto|turn|working-tree  自动范围 / 本回合 / 未提交改动',
    '  --target base-ref --base <ref> 兼容旧的“引用与工作区比较”语义',
    '  --focus security,tests       逗号分隔的审查重点',
    '  --seats 3|5|7                席位数',
    '  --provider <id> --model <id> 本次 reviewer 使用同一允许路由',
    '  --                           后续文字全部作为审查要求',
    '  --help | -h                  显示帮助，不调用模型', '',
    '默认 reviewer 跟随 DSH 子智能体模型设置；书记官沿用会话模型。',
    '--report 与 --help 各自单独使用；命令不提供 --detail 或 patch 文件输入。',
  ].join('\n');
}

function service(ctx, name) { try { return ctx?.get?.(name); } catch { return undefined; } }

/** The command owns the interaction; no model call happens until a choice is returned. */
export async function prepareCommandReview({ ctx, agent, args, signal, deps = {} }) {
  if (Object.keys(args).length) return { ...args, target: args.target ?? 'working-tree' };
  const questions = service(ctx, 'userQuestions');
  if (!agent || typeof questions?.ask !== 'function') {
    throw new Error('当前入口无法显示范围选择。请使用 --uncommitted、--base <分支> 或 --commit <提交>，或 --help。');
  }
  const ask = async question => {
    signal?.throwIfAborted();
    const response = await questions.ask({ agent, signal, questions: [question] });
    signal?.throwIfAborted();
    const answer = response?.answers?.find(item => item.id === question.id);
    const value = answer?.custom?.trim() || answer?.selected?.[0];
    return !value || value === cancelLabel ? null : value;
  };
  const choices = [
    { label: '审查未提交的改动', description: '包含暂存、未暂存和未跟踪文件。' },
    { label: '与基线分支比较', description: '选择分支，审查共同祖先到当前 HEAD 的已提交改动。' },
    { label: '审查某次提交', description: '选择一条提交，只审查该次引入的改动。' },
    { label: '自定义审查要求', description: '输入审查重点，应用于未提交改动。' },
    { label: cancelLabel, description: '结束选择，不启动评审。' },
  ];
  const choice = await ask({ id: 'magi-scope', header: 'MAGI 评审', question: '你想审查哪些改动？', options: choices });
  if (choice === null) return null;
  if (choice === choices[0].label) return { target: 'working-tree' };
  if (choice === choices[3].label) {
    const instructions = await ask({ id: 'magi-instructions', header: '审查要求',
      question: '请输入审查重点（范围为未提交改动；留空或取消则不启动）。',
      options: [{ label: cancelLabel }] });
    return instructions === null ? null : { target: 'working-tree', instructions };
  }
  if (![choices[1].label, choices[2].label].includes(choice)) throw new Error('未识别的评审范围；请重新选择，或使用 --help。');
  const cwd = service(ctx, 'workingDirectory')?.get(agent.session) ?? agent.session?.header?.cwd ?? process.cwd();
  if (choice === choices[1].label) {
    const branches = await (deps.listReviewBranches ?? listReviewBranches)({ cwd, signal, limit: 12 });
    const base = await ask({ id: 'magi-base', header: '基线分支', question: '选择基线分支，也可输入完整分支或引用。',
      options: [...branches.map(branch => ({ label: branch.ref, ...(branch.current ? { description: '当前分支' } : {}) })), { label: cancelLabel }] });
    return base === null ? null : { target: 'branch', base };
  }
  const commits = await (deps.listReviewCommits ?? listReviewCommits)({ cwd, signal, limit: 12 });
  const labels = new Map(commits.map(commit => [`${commit.oid.slice(0, 10)} · ${commit.subject.replace(/[\r\n\t]/g, ' ').slice(0, 100)}`, commit.oid]));
  const commit = await ask({ id: 'magi-commit', header: '选择提交', question: '选择最近的提交，也可输入提交 SHA 或 Git 引用。',
    options: [...labels.keys()].map(label => ({ label })).concat({ label: cancelLabel }) });
  return commit === null ? null : { target: 'commit', commit: labels.get(commit) ?? commit };
}
