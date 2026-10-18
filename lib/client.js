window.__ModuleLoader__.load({
  id: '@local/dsh-magi-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const colors = {
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 };
    const cardStyle = {
      color: colors.primary, background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
      padding: '10px 12px', fontSize: 13, lineHeight: 1.5,
      minWidth: 0, overflowWrap: 'anywhere',
    };
    const mutedStyle = { color: colors.secondary, fontSize: 12 };
    const wrapStyle = { ...rowStyle, flexWrap: 'wrap' };
    const buttonStyle = {
      color: colors.primary, background: 'var(--dsw-alias-bg-layer-2)',
      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5,
      font: 'inherit', padding: '3px 8px', cursor: 'pointer',
      outlineColor: colors.brand,
    };

    const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const record = value => isRecord(value) ? value : {};
    const list = value => Array.isArray(value) ? value : [];
    const records = value => list(value).filter(isRecord);
    const str = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;
    const strings = value => list(value).map(item => str(item)).filter(Boolean);
    const count = (value, fallback = null) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
    const vote = value => choice(value, ['approve', 'request_changes', 'insufficient', 'none'], 'unknown');
    const oneLine = value => str(value).replace(/\s+/g, ' ');
    const shortText = value => {
      const text = oneLine(value);
      return text.length > 220 ? `${text.slice(0, 220)}…` : text;
    };
    const shown = value => value === null ? '?' : value;
    const byRef = (a, b) => a.seatRef < b.seatRef ? -1 : a.seatRef > b.seatRef ? 1 : 0;

    function contentText(block) {
      return records(block?.content).filter(part => part.type === 'text')
        .map(part => str(part.text)).join('\n');
    }

    function isPayload(value) {
      return isRecord(value) && ['schemaVersion', 'reviewId', 'verdict', 'seats', 'reportId', 'counts', 'status']
        .some(key => Object.prototype.hasOwnProperty.call(value, key));
    }

    function parsePayload(text) {
      // Only the explicit card prefix is accepted, never ordinary tool prose/JSON.
      const candidates = str(text).split(/(?:^|\n)\s*MAGI_CARD:\s*/).slice(1).reverse();
      for (const candidate of candidates) {
        if (!candidate.startsWith('{')) continue;
        // Find the end of this JSON object, allowing pretty JSON and later prose.
        let depth = 0, quoted = false, escaped = false;
        for (let index = 0; index < candidate.length; index++) {
          const char = candidate[index];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === '{') depth++;
          else if (char === '}' && --depth === 0) {
            try {
              const value = JSON.parse(candidate.slice(0, index + 1));
              if (isPayload(value)) return value;
            } catch { /* A malformed or unrelated text block is not card data. */ }
            break;
          }
        }
      }
      return null;
    }

    function normalizeChanges(value) {
      return records(value).map(change => ({
        seatRef: str(change.seatRef, str(change.seatId, '?')),
        from: vote(change.from), to: vote(change.to), reason: str(change.reason, '未提供理由'),
      }));
    }

    function normalizeDisputes(value) {
      return records(value).map(item => ({
        point: str(item.point, '争点未提供'), seats: strings(item.seats),
        resolved: item.resolved === true,
      }));
    }

    function normalizePayload(meta, text) {
      const source = isPayload(meta) ? meta : parsePayload(text);
      const input = record(source);
      const seats = records(input.seats).map((seat, index) => ({
        seatRef: str(seat.seatRef, `?${index + 1}`), seatId: str(seat.seatId),
        label: str(seat.label, str(seat.seatId, '未命名席位')),
        perspective: str(seat.perspective), provider: str(seat.provider), model: str(seat.model, '模型未提供'),
        briefVerdict: vote(seat.briefVerdict), finalVerdict: vote(seat.finalVerdict),
        impact: str(seat.impact, 'unknown'), changed: seat.changed === true,
        changeReason: str(seat.changeReason, '未提供理由'),
        status: choice(seat.status, ['completed', 'error'], 'unknown'),
        findingsCount: count(seat.findingsCount), blockingCount: count(seat.blockingCount),
        summary: str(seat.summary),
      })).sort(byRef);
      const findings = records(input.findings).map((finding, index) => {
        const location = record(finding.location);
        const line = count(location.line, count(record(location.range).start));
        return {
          id: str(finding.id, `finding-${index}`), severity: str(finding.severity, 'unknown'),
          confidence: str(finding.confidence, 'unknown'), title: str(finding.title, '未命名发现'),
          rationale: str(finding.rationale, '未提供理由'), mustFix: finding.mustFix === true,
          status: choice(finding.status, ['blocking', 'non_blocking'], 'unknown'),
          sourceSeatRefs: [...new Set(strings(finding.sourceSeatRefs))].sort(),
          location: { path: str(location.path), side: str(location.side), line: line > 0 ? line : undefined },
        };
      });
      const decision = record(input.decision);
      const counts = record(input.counts);
      const discussion = record(input.discussion);
      const minutes = record(input.minutes);
      const target = record(input.target);
      const votes = verdict => seats.filter(seat => seat.status === 'completed' && seat.finalVerdict === verdict).length;
      const rounds = count(input.rounds, count(discussion.rounds));
      return {
        source, available: source !== null, reviewId: str(input.reviewId),
        mode: choice(input.mode, ['quick', 'council'], 'unknown'),
        status: choice(input.status, ['completed', 'degraded', 'error'], 'unknown'),
        trust: choice(input.trust, ['trustworthy', 'needs_review', 'untrustworthy'], 'unknown'),
        verdict: choice(input.verdict, ['approve', 'request_changes', 'insufficient', 'none'], 'none'),
        overallImpact: str(input.overallImpact, 'unknown'), homogeneous: input.homogeneous === true,
        degradedReasons: strings(input.degradedReasons), durationMs: count(input.durationMs), rounds,
        target: { kind: str(target.kind, 'unknown'), files: count(target.files),
          partial: target.partial === true, baseRef: str(target.baseRef) },
        counts: {
          findings: count(counts.findings, Array.isArray(input.findings) ? findings.length : null),
          blocking: count(counts.blocking, Array.isArray(input.findings)
            ? findings.filter(finding => finding.status === 'blocking').length : null),
        },
        seats, findings,
        decision: {
          declaredPolicy: str(decision.declaredPolicy, 'unknown'),
          effectivePolicy: str(decision.effectivePolicy, 'unknown'),
          approveVotes: count(decision.approveVotes, seats.length ? votes('approve') : null),
          requestVotes: count(decision.requestVotes, seats.length ? votes('request_changes') : null),
          expectedQuorum: count(decision.expectedQuorum), rationale: str(decision.rationale, '裁决理由未提供'),
        },
        dissent: records(input.dissent).map(item => ({
          seatRef: str(item.seatRef, '?'), verdict: vote(item.verdict), reason: str(item.reason, '未提供理由'),
        })),
        discussion: {
          rounds: count(discussion.rounds, rounds),
          voteChanges: normalizeChanges(discussion.voteChanges ?? minutes.voteChanges),
          disputes: normalizeDisputes(discussion.disputes ?? minutes.disputes),
          unresolvedQuestions: records(discussion.unresolvedQuestions ?? minutes.unresolvedQuestions)
            .map(item => str(item.question)).filter(Boolean),
        },
        minutes: isRecord(input.minutes) ? {
          summary: str(minutes.summary, '纪要摘要未提供'),
          consensus: records(minutes.consensus).map(item => str(item.statement)).filter(Boolean),
          evidenceStrength: str(minutes.evidenceStrength, 'unknown'),
          minutesStatus: choice(minutes.minutesStatus, ['ok', 'invalid'], 'unknown'),
        } : null,
        reportId: str(input.reportId),
      };
    }

    function voteColor(verdict) {
      if (verdict === 'approve') return colors.success;
      if (verdict === 'request_changes') return colors.warn;
      if (verdict === 'insufficient' || verdict === 'unknown') return colors.brand;
      return verdict === 'error' ? colors.error : colors.idle;
    }

    const seatVote = seat => seat.status === 'error' ? 'error' : seat.finalVerdict;
    const seatColor = seat => seat.status === 'error' ? colors.idle : voteColor(seat.finalVerdict);
    function severityColor(severity) {
      if (severity === 'critical' || severity === 'high') return colors.error;
      if (severity === 'medium') return colors.warn;
      return severity === 'low' ? colors.brand : colors.idle;
    }

    function duration(ms) {
      if (ms === null) return '耗时未知';
      if (ms < 1000) return `${ms}ms`;
      if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
      const seconds = Math.floor(ms / 1000);
      return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    }

    function badge(text, color = colors.secondary) {
      return h('span', { style: { color, background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 4, padding: '0 5px', fontSize: 12 } }, text);
    }

    function section(title, ...children) {
      return h('section', { style: { borderTop: '1px solid var(--dsw-alias-border-l1)', marginTop: 10, paddingTop: 8 } },
        h('h4', { style: { margin: '0 0 6px', fontSize: 13 } }, title), ...children);
    }

    function seatName(data, ref) {
      const seat = data.seats.find(item => item.seatRef === ref || item.seatId === ref);
      return seat ? `${seat.seatRef} · ${seat.label}` : ref;
    }

    function RunningCard({ phase }) {
      return h('div', { style: cardStyle, role: 'status', 'aria-live': 'polite' },
        h('div', { style: { ...rowStyle, color: colors.secondary } },
          ...['A', 'B', 'C'].map(ref => h('span', { key: ref, style: rowStyle }, dot(colors.idle), ref)),
          h('span', null, phase === 'preparing' ? 'MAGI · 正在准备审查' : 'MAGI · 审查进行中')),
        h('div', { style: mutedStyle }, '匿名进度 · 等待最终结果'));
    }

    function SeatRows({ data }) {
      return section('席位',
        ...data.seats.map((seat, index) => h('div', { key: `${seat.seatRef}-${index}`, style: { marginTop: 8 } },
          h('div', { style: wrapStyle }, dot(seatColor(seat)),
            h('strong', null, `${seat.seatRef} · ${seat.label}`),
            h('span', { style: mutedStyle }, [seat.provider, seat.model].filter(Boolean).join('/')),
            h('span', { style: { color: seatColor(seat) } }, seatVote(seat))),
          h('div', { style: mutedStyle },
            `陈词 ${seat.briefVerdict} · impact ${seat.impact} · ${shown(seat.findingsCount)} findings · ${shown(seat.blockingCount)} blocking`,
            seat.perspective ? ` · ${seat.perspective}` : ''),
          seat.changed ? h('div', null,
            `改票：${seat.briefVerdict} → ${seat.finalVerdict}（${seat.changeReason}）`) : null,
          seat.summary ? h('div', { style: mutedStyle, title: seat.summary }, shortText(seat.summary)) : null)),
        !data.seats.length ? h('div', { style: mutedStyle }, '席位数据未提供') : null);
    }

    function FileLocation({ location, openFile }) {
      const [failed, setFailed] = React.useState(false);
      const text = location.path ? `${location.path}${location.line ? `:${location.line}` : ''}` : '位置未提供';
      async function open() {
        try { await openFile(location.path, { line: location.line }); }
        catch { setFailed(true); }
      }
      return h('span', null,
        location.path && typeof openFile === 'function'
          ? h('button', { type: 'button', onClick: open, title: text,
            style: { ...buttonStyle, color: colors.brand, textAlign: 'left', overflowWrap: 'anywhere' } }, text)
          : h('span', { style: { ...mutedStyle, userSelect: 'text' } }, text),
        location.side === 'old' ? h('span', { style: mutedStyle }, ' · old') : null,
        failed ? h('span', { role: 'status', style: mutedStyle }, ' 打开失败，可复制路径') : null);
    }

    function Findings({ data, openFile }) {
      const visible = data.findings.slice(0, 30);
      const more = Math.max(data.findings.length, data.counts.findings ?? 0) - visible.length;
      return section(`Findings · ${shown(data.counts.findings)}`,
        ...visible.map((finding, index) => h('div', { key: `${finding.id}-${index}`,
          style: { padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('div', { style: wrapStyle }, dot(severityColor(finding.severity)),
          h('span', { style: mutedStyle }, finding.severity),
          h(FileLocation, { location: finding.location, openFile }), h('strong', null, finding.title)),
        h('div', { title: finding.rationale, style: { marginTop: 4 } }, shortText(finding.rationale)),
        h('div', { style: { ...wrapStyle, marginTop: 4 } },
          badge(finding.status, finding.status === 'blocking' ? colors.warn : colors.secondary),
          finding.mustFix ? badge('mustFix', colors.warn) : null,
          badge(`置信度 ${finding.confidence}`), badge(`来源 ${finding.sourceSeatRefs.join('/') || '?'}`)))),
        !visible.length ? h('div', { style: mutedStyle },
          data.counts.findings === 0 ? '无 findings' : '发现明细未提供，请查看完整报告') : null,
        more > 0 ? h('div', { style: { ...mutedStyle, marginTop: 6 } }, `+${more} more · 查看完整报告`) : null);
    }

    function Decision({ data }) {
      const decision = data.decision;
      const blocking = data.findings.find(finding => finding.status === 'blocking');
      const blockingReason = data.counts.blocking === 0 ? '无 blocking'
        : shortText(blocking?.rationale ?? decision.rationale);
      return section('裁决',
        h('div', { style: wrapStyle },
          h('strong', { style: { color: data.status === 'error' ? colors.error : voteColor(data.verdict) } }, data.verdict.toUpperCase()),
          h('span', null, `approve ${shown(decision.approveVotes)} · request_changes ${shown(decision.requestVotes)}`)),
        h('div', null, `quorum ${shown(decision.expectedQuorum)}/${data.seats.length || '?'} · effectivePolicy ${decision.effectivePolicy}`),
        h('div', { style: mutedStyle }, `declaredPolicy ${decision.declaredPolicy} · ${data.status} · ${data.trust} · impact ${data.overallImpact}`),
        h('div', { title: decision.rationale }, shortText(decision.rationale)),
        h('div', null, `blocking：${blockingReason}`),
        h('div', { style: mutedStyle },
          `范围 ${data.target.kind} · ${shown(data.target.files)} files${data.target.baseRef ? ` · ${data.target.baseRef}` : ''}${data.target.partial ? ' · 部分覆盖' : ''}`),
        ...data.degradedReasons.map((reason, index) => h('div', { key: index, style: { color: colors.warn } }, `降级：${reason}`)),
        h('div', { style: { marginTop: 6 } }, 'Dissent'),
        ...data.dissent.map((item, index) => h('div', { key: index },
          `${seatName(data, item.seatRef)} · ${item.verdict}：${item.reason}`)),
        !data.dissent.length ? h('div', { style: mutedStyle }, '无异议记录') : null);
    }

    function Discussion({ data }) {
      const discussion = data.discussion;
      return section(`讨论 / 纪要 · ${shown(discussion.rounds)} 轮`,
        ...discussion.voteChanges.map((change, index) => h('div', { key: `change-${index}` },
          `${seatName(data, change.seatRef)}：${change.from} → ${change.to}（${change.reason}）`)),
        ...discussion.disputes.map((dispute, index) => h('div', { key: `dispute-${index}`, style: { marginTop: 4 } },
          `争议：${dispute.point} · ${dispute.seats.map(ref => seatName(data, ref)).join(' / ') || '席位未知'} · ${dispute.resolved ? '已解决' : '未解决'}`)),
        ...discussion.unresolvedQuestions.map((question, index) => h('div', { key: `question-${index}` }, `未决问题：${question}`)),
        !discussion.voteChanges.length && !discussion.disputes.length && !discussion.unresolvedQuestions.length
          ? h('div', { style: mutedStyle }, data.mode === 'quick' ? 'quick 模式无讨论' : '无讨论明细') : null,
        data.minutes ? h('div', { style: { marginTop: 6 } },
          data.minutes.minutesStatus === 'invalid' ? badge('纪要校验失败', colors.warn) : null,
          h('div', null, data.minutes.summary),
          ...data.minutes.consensus.map((statement, index) => h('div', { key: index, style: mutedStyle }, `共识：${statement}`)),
          h('div', { style: mutedStyle }, `证据强度 ${data.minutes.evidenceStrength}`))
          : h('div', { style: mutedStyle }, data.mode === 'quick' ? 'quick 模式无纪要' : '纪要未提供'));
    }

    function ReportFooter({ data }) {
      const [copyState, setCopyState] = React.useState('');
      async function copy(kind) {
        try {
          if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
          await navigator.clipboard.writeText(kind === 'id' ? data.reportId : JSON.stringify(data.source, null, 2));
          setCopyState(kind === 'id' ? 'reportId 已复制' : 'JSON 已复制');
        } catch { setCopyState('复制失败，请手动选择下方文本'); }
      }
      return section('报告',
        h('div', { style: wrapStyle },
          data.reportId ? h('button', { type: 'button', style: buttonStyle, onClick: () => copy('id') }, '复制 reportId') : null,
          data.available ? h('button', { type: 'button', style: buttonStyle, onClick: () => copy('json') }, '复制 JSON') : null,
          h('span', { role: 'status', 'aria-live': 'polite', style: mutedStyle }, copyState)),
        h('div', null, 'reportId：', h('code', { style: { userSelect: 'text', whiteSpace: 'pre-wrap' } }, data.reportId || '未提供')),
        data.reportId ? h('div', { style: mutedStyle }, '查看完整报告：',
          h('code', { style: { userSelect: 'text', whiteSpace: 'pre-wrap' } }, `/magi-review --report ${data.reportId}`)) : null,
        copyState.startsWith('复制失败') && data.available ? h('details', null,
          h('summary', { style: { cursor: 'pointer', color: colors.secondary } }, '手动复制 JSON'),
          h('pre', { style: { userSelect: 'text', whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto',
            background: 'var(--dsw-alias-bg-base)' } }, displayText(data.source))) : null);
    }

    function ReviewResult({ block, expanded, toggle, openFile }) {
      const data = normalizePayload(block?.meta, contentText(block));
      const failed = block?.isError || block?.error || data.status === 'error';
      const summary = data.seats.map(seat => `${seat.label} ${seatVote(seat)}`).join(' · ') || '席位数据未提供';
      return h('div', { style: cardStyle },
        h('button', { type: 'button', onClick: toggle, 'aria-expanded': expanded,
          'aria-label': `${expanded ? '折叠' : '展开'} MAGI 审查结果`,
          style: { ...buttonStyle, display: 'block', width: '100%', padding: 0, border: 0,
            background: 'var(--dsw-alias-bg-layer-1)', textAlign: 'left', overflowWrap: 'anywhere' } },
        h('span', { style: wrapStyle },
          h('span', { style: rowStyle }, ...(data.seats.length ? data.seats : [null, null, null]).map((seat, index) =>
            h('span', { key: index, style: rowStyle,
              title: seat ? `${seat.seatRef} · ${seat.label} · ${seat.provider}/${seat.model} · ${seatVote(seat)}` : '席位数据未提供' },
            dot(seat ? seatColor(seat) : colors.idle)))),
          h('strong', { style: { color: failed ? colors.error : voteColor(data.verdict) } }, `MAGI · ${data.verdict.toUpperCase()}`),
          h('span', null, `(${shown(data.decision.approveVotes)}/${data.seats.length || '?'})`),
          h('span', null, `· ${shown(data.counts.blocking)} blocking · ${data.mode} · ${duration(data.durationMs)}`),
          h('span', { 'aria-hidden': true, style: { marginLeft: 'auto', color: colors.secondary } }, expanded ? '▾' : '▸')),
        h('span', { style: { ...wrapStyle, ...mutedStyle, marginTop: 4 } }, h('span', null, summary),
          data.homogeneous ? badge('同构') : null,
          data.status === 'degraded' || data.degradedReasons.length ? badge('degraded · 结果已降级', colors.warn) : null,
          data.verdict === 'insufficient' ? badge('insufficient · 证据不足，需复核', colors.brand) : null,
          failed ? badge('error · 审查失败', colors.error) : null,
          !data.available ? badge('结果数据不可用', colors.idle) : null)),
        expanded ? h('div', null, h(SeatRows, { data }), h(Findings, { data, openFile }),
          h(Decision, { data }), h(Discussion, { data }), h(ReportFooter, { key: data.reportId, data })) : null);
    }

    function LocalReview(props) {
      const [expanded, setExpanded] = React.useState(false);
      return h(ReviewResult, { ...props, expanded, toggle: () => setExpanded(value => !value) });
    }

    function HostReview(props) {
      const useDisclosure = props.useDisclosure;
      const disclosure = useDisclosure();
      return disclosure && typeof disclosure.expanded === 'boolean' && typeof disclosure.toggle === 'function'
        ? h(ReviewResult, { ...props, expanded: disclosure.expanded, toggle: disclosure.toggle })
        : h(LocalReview, props);
    }

    function ReviewCard(props) {
      // Gate before reading block, meta, content or invoking any disclosure hook.
      // Even an accidentally populated intermediate block must remain anonymous.
      if (props.phase !== 'result') return h(RunningCard, { phase: props.phase });
      return h(typeof props.useDisclosure === 'function' ? HostReview : LocalReview, props);
    }

    function dot(color, key) {
      return h('span', { key, 'aria-hidden': true, style: {
        display: 'inline-block', width: 8, height: 8, flexShrink: 0,
        borderRadius: '50%', background: color,
      } });
    }

    function displayText(value) {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value) ?? ''; }
      catch { return 'Unable to display diagnostic.'; }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'magi_review' }, ReviewCard));
      },
    };
  },
});
