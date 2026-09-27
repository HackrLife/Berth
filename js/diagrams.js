// Architecture patterns for the "How it works" page.
//
// Every diagram uses one notation so a reader learns it once:
//   pill      request or answer
//   gate      governance checkpoint (redaction, policy, checks)
//   model     a model in a named role
//   tool      a tool the model can call
//   decision  a branch
//   human     a person who decides
//   store     the audit log or another record
//   pattern   a placeholder for any pattern (governance layer only)
//
// Positions are in grid units: col (0..6) and row (fractions allowed).
// The patterns are industry-agnostic by design.

const COL = 132;
const ROW = 100;
const MX = 16;
const MY = 34;
const SIZE = {
  pill: [86, 40], gate: [112, 52], model: [112, 56], tool: [112, 50], decision: [118, 72],
  human: [120, 52], store: [112, 48], pattern: [112, 70],
};

// ---------------------------------------------------------------------------
// Pattern definitions

const IN = (col = 1) => ({ id: 'in', kind: 'gate', role: 'GOVERNANCE', label: 'Redact · policy', col, row: 1 });
const OUT = (col, row = 1) => ({ id: 'out', kind: 'gate', role: 'GOVERNANCE', label: 'Output checks', col, row });
const AUDIT = (col, row = 0) => ({ id: 'audit', kind: 'store', label: 'Audit log', col, row });

export const PATTERNS = [
  {
    id: 'single', group: 'Agents', title: 'Single model', status: 'runs',
    summary: 'One model answers every request from its instructions and reference text.',
    when: 'Narrow, predictable tasks where one model is good enough and cost per request is low. The baseline every other pattern is measured against.',
    cost: 'Every request pays the price of the one model. Cheap if that model is small, expensive if it is the strongest available.',
    governance: 'Redaction and policy on the way in, output checks and the audit log on the way out. Tier controls such as approval still apply.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      IN(),
      { id: 'm', kind: 'model', role: 'MODEL', label: 'Answers', col: 2, row: 1 },
      OUT(3), AUDIT(3),
      { id: 'ans', kind: 'pill', label: 'Answer', col: 4, row: 1 },
    ],
    edges: [['req', 'in'], ['in', 'm'], ['m', 'out'], ['out', 'ans'], ['out', 'audit', { style: 'log' }]],
  },
  {
    id: 'routed', group: 'Agents', title: 'Routed', status: 'runs',
    summary: 'A cheap router model classifies each request. Simple requests go to a fast model and complex ones to a strong model.',
    when: 'Mixed workloads where most requests are simple and a minority need deep reasoning. The default Berth pattern for agents.',
    cost: 'The router adds a small fixed cost per request. Every simple request then avoids the strong model, which usually saves more than half the spend.',
    governance: 'The router sees only redacted text. It defaults to the strong model when unsure, and its decision and reason are logged with the answer.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      IN(),
      { id: 'r', kind: 'model', role: 'ROUTER', label: 'Cheap model', col: 2, row: 1 },
      { id: 'f', kind: 'model', role: 'FAST', label: 'Fast model', col: 3.8, row: 0.25 },
      { id: 's', kind: 'model', role: 'STRONG', label: 'Strong model', col: 3.8, row: 1.75 },
      OUT(5), AUDIT(5, 0),
      { id: 'ans', kind: 'pill', label: 'Answer', col: 6, row: 1 },
    ],
    edges: [
      ['req', 'in'], ['in', 'r'],
      ['r', 'f', { label: 'simple', from: 'right', to: 'left', labelSeg: 'last' }],
      ['r', 's', { label: 'complex or unsure', from: 'right', to: 'left', labelSeg: 'last' }],
      ['f', 'out', { from: 'right', to: 'left', toAt: 0.3 }],
      ['s', 'out', { from: 'right', to: 'left', toAt: 0.7 }],
      ['out', 'ans'], ['out', 'audit', { style: 'log' }],
    ],
  },
  {
    id: 'cascade', group: 'Agents', title: 'Cascade', status: 'reference',
    summary: 'The fast model always answers first. A check decides whether the answer is good enough, and only failures move up to the strong model.',
    when: 'When quality can be checked cheaply (a format, a required section, a confidence score) and most first attempts pass.',
    cost: 'Failed requests pay twice, once for each model, so a cascade saves money only when the pass rate is high. Track the escalation rate in the audit log.',
    governance: 'The check is deterministic where possible, so escalation is explainable. Both attempts are logged, not just the final one.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      IN(),
      { id: 'f', kind: 'model', role: 'FAST', label: 'First attempt', col: 2, row: 1 },
      { id: 'd', kind: 'decision', label: 'Good enough?', col: 3, row: 1 },
      { id: 's', kind: 'model', role: 'STRONG', label: 'Second attempt', col: 4.2, row: 2.1 },
      OUT(5.3), AUDIT(5.3, 0),
      { id: 'ans', kind: 'pill', label: 'Answer', col: 6.3, row: 1 },
    ],
    edges: [
      ['req', 'in'], ['in', 'f'], ['f', 'd'],
      ['d', 'out', { label: 'yes' }],
      ['d', 's', { label: 'no, escalate', from: 'bottom', to: 'left', labelSeg: 'last' }],
      ['s', 'out', { from: 'right', to: 'bottom' }],
      ['out', 'ans'], ['out', 'audit', { style: 'log' }],
    ],
  },
  {
    id: 'tool-loop', group: 'Agents', title: 'Tool loop', status: 'runs',
    summary: 'The model plans a step, calls a tool, reads the result and repeats until the task is done or the step limit is reached.',
    when: 'Tasks that need facts or actions the model does not have: calculations, lookups, searching reference documents, calling other systems.',
    cost: 'Each step is a separate model call that re-reads everything so far, so cost grows with the number of steps. A step limit caps it.',
    governance: 'Each tool call passes a permission check, which can run automatically, ask a person first, or be blocked. Every call and its result are recorded.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      IN(),
      { id: 'm', kind: 'model', role: 'AGENT', label: 'Plan next step', col: 2, row: 1 },
      { id: 'd', kind: 'decision', label: 'Tool needed?', col: 3, row: 1 },
      { id: 'p', kind: 'gate', role: 'GOVERNANCE', label: 'Tool permission', col: 3, row: 2.2 },
      { id: 't', kind: 'tool', role: 'TOOL', label: 'Run tool', col: 2, row: 2.2 },
      OUT(4.4), AUDIT(4.4, 0),
      { id: 'ans', kind: 'pill', label: 'Answer', col: 5.4, row: 1 },
    ],
    edges: [
      ['req', 'in'], ['in', 'm'], ['m', 'd'],
      ['d', 'out', { label: 'no, done' }],
      ['d', 'p', { label: 'yes', from: 'bottom', to: 'top' }],
      ['p', 't', { from: 'left', to: 'right' }],
      ['t', 'm', { label: 'result', from: 'top', to: 'bottom', style: 'loop' }],
      ['out', 'ans'], ['out', 'audit', { style: 'log' }],
    ],
  },
  {
    id: 'orchestrator', group: 'Agents', title: 'Orchestrator and workers', status: 'reference',
    summary: 'A strong model splits the task into parts, fast worker models handle the parts in parallel, and a model combines their results.',
    when: 'Large tasks that divide cleanly: reviewing many documents, researching several questions, comparing options against the same criteria.',
    cost: 'The expensive model plans and combines; the cheap models do the volume. Parallel workers also cut waiting time.',
    governance: 'Each worker receives only the part it needs, which limits what data each model sees. Every sub-task is logged under the parent request.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      IN(),
      { id: 'o', kind: 'model', role: 'ORCHESTRATOR', label: 'Split the task', col: 2, row: 1 },
      { id: 'w1', kind: 'model', role: 'WORKER', label: 'Part 1', col: 3, row: 0.25 },
      { id: 'w2', kind: 'model', role: 'WORKER', label: 'Part 2', col: 3, row: 1 },
      { id: 'w3', kind: 'model', role: 'WORKER', label: 'Part 3', col: 3, row: 1.75 },
      { id: 'c', kind: 'model', role: 'SYNTHESISER', label: 'Combine', col: 4, row: 1 },
      OUT(5), AUDIT(5, 0),
      { id: 'ans', kind: 'pill', label: 'Answer', col: 6, row: 1 },
    ],
    edges: [
      ['req', 'in'], ['in', 'o'],
      ['o', 'w1', { from: 'right', to: 'left', fromAt: 0.25 }], ['o', 'w2'], ['o', 'w3', { from: 'right', to: 'left', fromAt: 0.75 }],
      ['w1', 'c', { from: 'right', to: 'left', toAt: 0.25 }], ['w2', 'c'], ['w3', 'c', { from: 'right', to: 'left', toAt: 0.75 }],
      ['c', 'out'], ['out', 'ans'], ['out', 'audit', { style: 'log' }],
    ],
  },
  {
    id: 'review', group: 'Harnesses', title: 'Review and revise', status: 'runs',
    summary: 'A worker model drafts the answer. An independent reviewer model checks it against the instructions and rules, and the worker revises once if issues are found.',
    when: 'Any output a person will rely on: assessments, summaries of obligations, anything with required content or forbidden decisions.',
    cost: 'Adds one reviewer call per request, and a second worker call when a revision is needed. Much cheaper than a person catching the same errors.',
    governance: 'The reviewer should come from a different vendor to the worker, so the check is independent. Drafts that fail twice go to a person with the issues listed.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1.3 },
      { id: 'in', kind: 'gate', role: 'GOVERNANCE', label: 'Redact · policy', col: 1, row: 1.3 },
      { id: 'w', kind: 'model', role: 'WORKER', label: 'Draft', col: 2, row: 1.3 },
      { id: 'rv', kind: 'model', role: 'REVIEWER', label: 'Other vendor', col: 3, row: 1.3 },
      { id: 'd', kind: 'decision', label: 'Pass?', col: 4, row: 1.3 },
      OUT(5.3, 1.3), AUDIT(5.3, 0.2),
      { id: 'h', kind: 'human', role: 'PERSON', label: 'Resolve issues', col: 4, row: 2.5 },
      { id: 'ans', kind: 'pill', label: 'Answer', col: 6.3, row: 1.3 },
    ],
    edges: [
      ['req', 'in'], ['in', 'w'], ['w', 'rv'], ['rv', 'd'],
      ['d', 'out', { label: 'pass' }],
      ['d', 'w', { label: 'revise once', from: 'top', to: 'top', via: 'above', style: 'loop' }],
      ['d', 'h', { label: 'fails again', from: 'bottom', to: 'top' }],
      ['h', 'out', { from: 'right', to: 'bottom' }],
      ['out', 'ans'], ['out', 'audit', { style: 'log' }],
    ],
  },
  {
    id: 'approval', group: 'Harnesses', title: 'Approval-gated', status: 'runs',
    summary: 'People sign off at set checkpoints: before selected tool calls and before any output is released.',
    when: 'High-risk uses where the law or the organisation requires human oversight, and actions that are hard to undo.',
    cost: 'Model cost is unchanged. The cost is reviewer time, so gates belong where the risk justifies them, not on every step.',
    governance: 'Implements human oversight (EU AI Act Art. 14). Output stays locked until approved; rejections are kept in the log with the reason.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1.2 },
      { id: 'in', kind: 'gate', role: 'GOVERNANCE', label: 'Redact · policy', col: 1, row: 1.2 },
      { id: 'a', kind: 'model', role: 'AGENT', label: 'Works the task', col: 2, row: 1.2 },
      { id: 'ht', kind: 'human', role: 'PERSON', label: 'Allow tool call?', col: 2, row: 0 },
      { id: 't', kind: 'tool', role: 'TOOL', label: 'Run tool', col: 3.3, row: 0 },
      { id: 'out', kind: 'gate', role: 'GOVERNANCE', label: 'Output checks', col: 3.1, row: 1.2 },
      { id: 'hr', kind: 'human', role: 'PERSON', label: 'Approve output', col: 4.2, row: 1.2 },
      { id: 'x', kind: 'store', label: 'Rejected · logged', col: 4.2, row: 2.35 },
      { id: 'ans', kind: 'pill', label: 'Answer', col: 5.4, row: 1.2 },
    ],
    edges: [
      ['req', 'in'], ['in', 'a'],
      ['a', 'ht', { label: 'asks', from: 'top', to: 'bottom', fromAt: 0.3, toAt: 0.3 }],
      ['ht', 't', { label: 'allow' }],
      ['t', 'a', { label: 'result', from: 'bottom', to: 'top', toAt: 0.75, style: 'loop' }],
      ['a', 'out'], ['out', 'hr'],
      ['hr', 'ans', { label: 'approve' }],
      ['hr', 'x', { label: 'reject', from: 'bottom', to: 'top', style: 'log' }],
    ],
  },
  {
    id: 'consensus', group: 'Harnesses', title: 'Consensus', status: 'reference',
    summary: 'Two models from different vendors answer the same request independently. A judge compares them, and any material disagreement goes to a person.',
    when: 'Decisions where a single model’s blind spot is costly: eligibility, classification, extracting figures that others will rely on.',
    cost: 'Roughly doubles the work cost, plus the judge. Use it for a small share of high-stakes requests, not as a default.',
    governance: 'Disagreement is a measurable signal of uncertainty. It is logged per request and turns model error into a routing rule for human review.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      IN(),
      { id: 'a', kind: 'model', role: 'MODEL A', label: 'Vendor 1', col: 2, row: 0.35 },
      { id: 'b', kind: 'model', role: 'MODEL B', label: 'Vendor 2', col: 2, row: 1.65 },
      { id: 'j', kind: 'model', role: 'JUDGE', label: 'Compare', col: 3, row: 1 },
      { id: 'd', kind: 'decision', label: 'Agree?', col: 4, row: 1 },
      OUT(5.3), AUDIT(5.3, 0),
      { id: 'h', kind: 'human', role: 'PERSON', label: 'Decide', col: 4, row: 2.25 },
      { id: 'ans', kind: 'pill', label: 'Answer', col: 6.3, row: 1 },
    ],
    edges: [
      ['req', 'in'],
      ['in', 'a', { from: 'right', to: 'left', fromAt: 0.3 }], ['in', 'b', { from: 'right', to: 'left', fromAt: 0.7 }],
      ['a', 'j', { from: 'right', to: 'left', toAt: 0.3 }], ['b', 'j', { from: 'right', to: 'left', toAt: 0.7 }],
      ['j', 'd'], ['d', 'out', { label: 'agree' }],
      ['d', 'h', { label: 'disagree', from: 'bottom', to: 'top' }],
      ['h', 'out', { from: 'right', to: 'bottom' }],
      ['out', 'ans'], ['out', 'audit', { style: 'log' }],
    ],
  },
  {
    id: 'router', group: 'Foundations', title: 'Router', status: 'runs',
    summary: 'The router is a small, cheap model that reads the redacted request and returns a route and a reason as JSON. It never does the work itself. A reply that cannot be read counts as complex.',
    when: 'Inside every routed agent and harness. Switch routing off for a build to send everything to the strong model.',
    cost: 'A router call is a few hundred tokens on the cheapest model, usually a fraction of a cent. It pays for itself when a minority of requests are simple.',
    governance: 'Three rules keep routing safe: the router sees only redacted text, any doubt or error routes to the strong model, and every route and reason is logged.',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      { id: 'r', kind: 'model', role: 'ROUTER', label: 'Cheap model', col: 1, row: 1 },
      { id: 'd', kind: 'decision', label: 'Route', col: 2.1, row: 1 },
      { id: 'f', kind: 'model', role: 'FAST', label: 'Simple work', col: 4, row: 0 },
      { id: 's', kind: 'model', role: 'STRONG', label: 'Complex work', col: 4, row: 1 },
      { id: 'audit', kind: 'store', label: 'Route + reason', col: 2.1, row: 2.1 },
      { id: 'nx', kind: 'pill', label: 'Next stage', col: 5.2, row: 1 },
    ],
    edges: [
      ['req', 'r'], ['r', 'd'],
      ['d', 'f', { label: 'simple', from: 'top', to: 'left', labelSeg: 'last' }],
      ['d', 's', { label: 'complex, unsure or error' }],
      ['d', 'audit', { style: 'log', from: 'bottom', to: 'top' }],
      ['f', 'nx', { from: 'right', to: 'top' }], ['s', 'nx'],
    ],
  },
  {
    id: 'governance', group: 'Foundations', title: 'Governance layer', status: 'runs',
    summary: 'Every pattern above runs inside the same envelope: checks on the way in, the build’s risk-tier controls on the way out, and one audit log throughout.',
    when: 'Always. The layer is not optional per build; only its settings change with the risk tier and the workspace policy.',
    cost: 'Redaction and policy checks run in the browser at no model cost. Only an independent review adds model calls.',
    governance: 'Maps to data minimisation (GDPR Art. 5(1)(c)), transparency (AI Act Art. 50), human oversight (Art. 14) and record-keeping (Art. 12).',
    nodes: [
      { id: 'req', kind: 'pill', label: 'Request', col: 0, row: 1 },
      { id: 'rd', kind: 'gate', role: 'IN', label: 'Redact data', col: 1, row: 1 },
      { id: 'po', kind: 'gate', role: 'IN', label: 'Policy check', col: 2, row: 1 },
      { id: 'gd', kind: 'gate', role: 'IN', label: 'Pre-send guard', col: 3, row: 1 },
      { id: 'pt', kind: 'pattern', label: 'Any agent or\nharness pattern', col: 4, row: 1 },
      { id: 'ck', kind: 'gate', role: 'OUT', label: 'Output checks', col: 5, row: 1 },
      { id: 'tc', kind: 'gate', role: 'OUT', label: 'Tier controls', col: 6, row: 1 },
      { id: 'ans', kind: 'pill', label: 'Answer', col: 6, row: 0 },
      { id: 'audit', kind: 'store', label: 'Audit log', col: 3.5, row: 2.25, w: 300 },
    ],
    edges: [
      ['req', 'rd'], ['rd', 'po'], ['po', 'gd'], ['gd', 'pt'], ['pt', 'ck'], ['ck', 'tc'],
      ['tc', 'ans', { from: 'top', to: 'bottom' }],
      ['po', 'audit', { style: 'log', from: 'bottom', to: 'top', toAt: 0.1 }],
      ['gd', 'audit', { style: 'log', from: 'bottom', to: 'top', toAt: 0.3 }],
      ['ck', 'audit', { style: 'log', from: 'bottom', to: 'top', toAt: 0.7 }],
      ['tc', 'audit', { style: 'log', from: 'bottom', to: 'top', toAt: 0.9 }],
    ],
  },
];

// ---------------------------------------------------------------------------
// Renderer

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function box(n) {
  const [dw, dh] = SIZE[n.kind];
  const w = n.w || dw;
  const h = n.h || dh;
  const cx = MX + n.col * COL + COL / 2;
  const cy = MY + n.row * ROW + 30;
  return { ...n, w, h, cx, cy, x: cx - w / 2, y: cy - h / 2 };
}

function anchor(b, side, at = 0.5) {
  if (b.kind === 'decision') {
    if (side === 'left') return { x: b.x, y: b.cy };
    if (side === 'right') return { x: b.x + b.w, y: b.cy };
    if (side === 'top') return { x: b.cx, y: b.y };
    return { x: b.cx, y: b.y + b.h };
  }
  if (side === 'left') return { x: b.x, y: b.y + b.h * at };
  if (side === 'right') return { x: b.x + b.w, y: b.y + b.h * at };
  if (side === 'top') return { x: b.x + b.w * at, y: b.y };
  return { x: b.x + b.w * at, y: b.y + b.h };
}

function defaultSides(a, b) {
  if (b.x >= a.x + a.w - 1) return ['right', 'left'];
  if (b.x + b.w <= a.x + 1) return ['left', 'right'];
  if (b.cy > a.cy) return ['bottom', 'top'];
  return ['top', 'bottom'];
}

const horiz = (s) => s === 'left' || s === 'right';

function routePoints(p1, s1, p2, s2, via, a, b) {
  if (via) {
    const lane = via === 'above' ? Math.min(a.y, b.y) - 22 : Math.max(a.y + a.h, b.y + b.h) + 22;
    return [p1, { x: p1.x, y: lane }, { x: p2.x, y: lane }, p2];
  }
  if (horiz(s1) && horiz(s2)) {
    if (Math.abs(p1.y - p2.y) < 1) return [p1, p2];
    const mx = (p1.x + p2.x) / 2;
    return [p1, { x: mx, y: p1.y }, { x: mx, y: p2.y }, p2];
  }
  if (!horiz(s1) && !horiz(s2)) {
    if (Math.abs(p1.x - p2.x) < 1) return [p1, p2];
    const my = (p1.y + p2.y) / 2;
    return [p1, { x: p1.x, y: my }, { x: p2.x, y: my }, p2];
  }
  if (horiz(s1)) return [p1, { x: p2.x, y: p1.y }, p2];
  return [p1, { x: p1.x, y: p2.y }, p2];
}

function labelPos(pts, seg) {
  let best = 0;
  let len = -1;
  if (seg === 'last' || seg === 'first') {
    const i = seg === 'last' ? pts.length - 2 : 0;
    return seg_(pts, i);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (l > len) { len = l; best = i; }
  }
  return seg_(pts, best);
}

function seg_(pts, i) {
  const a = pts[i];
  const b = pts[i + 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, vertical: a.x === b.x, x1: Math.min(a.x, b.x), x2: Math.max(a.x, b.x) };
}

function text(lines, x, y, cls, size) {
  const arr = String(lines).split('\n');
  const start = y - ((arr.length - 1) * size * 1.2) / 2;
  return `<text x="${x}" y="${start}" class="${cls}" text-anchor="middle" dominant-baseline="central">${arr.map((l, i) => `<tspan x="${x}" dy="${i ? size * 1.2 : 0}">${esc(l)}</tspan>`).join('')}</text>`;
}

function nodeSvg(b) {
  const role = b.role ? text(b.role, b.cx, b.y + 14, `d-role d-role-${b.kind}`, 9) : '';
  const labelY = b.role ? b.cy + 7 : b.cy;
  switch (b.kind) {
    case 'pill':
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.h / 2}" class="d-pill"/>${text(b.label, b.cx, b.cy, 'd-label', 12)}`;
    case 'decision': {
      const pts = `${b.cx},${b.y} ${b.x + b.w},${b.cy} ${b.cx},${b.y + b.h} ${b.x},${b.cy}`;
      return `<polygon points="${pts}" class="d-decision"/>${text(b.label, b.cx, b.cy, 'd-label d-label-sm', 10.5)}`;
    }
    case 'store': {
      const ry = 6;
      return `<path d="M${b.x},${b.y + ry} v${b.h - 2 * ry} a${b.w / 2},${ry} 0 0 0 ${b.w},0 v-${b.h - 2 * ry}" class="d-store"/>
        <ellipse cx="${b.cx}" cy="${b.y + ry}" rx="${b.w / 2}" ry="${ry}" class="d-store"/>${text(b.label, b.cx, b.cy + 4, 'd-label d-label-sm', 11)}`;
    }
    case 'human':
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" class="d-human"/>${role}${text(b.label, b.cx, labelY, 'd-label', 12)}`;
    case 'pattern':
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" class="d-pattern"/>${text(b.label, b.cx, b.cy, 'd-label d-label-accent', 11.5)}`;
    default:
      return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.kind === 'model' ? 8 : 6}" class="d-${b.kind}"/>${role}${text(b.label, b.cx, labelY, `d-label d-label-${b.kind}`, 12)}`;
  }
}

/** Render one pattern as an SVG string. */
export function renderDiagram(p) {
  const boxes = new Map(p.nodes.map((n) => [n.id, box(n)]));
  const all = [...boxes.values()];
  const maxX = Math.max(...all.map((b) => b.x + b.w)) + MX;
  const maxY = Math.max(...all.map((b) => b.y + b.h)) + 30;
  const minY = Math.min(...all.map((b) => b.y)) - 34;

  const edges = p.edges.map(([from, to, o = {}]) => {
    const a = boxes.get(from);
    const b = boxes.get(to);
    const [ds1, ds2] = defaultSides(a, b);
    const s1 = o.from || ds1;
    const s2 = o.to || ds2;
    const p1 = anchor(a, s1, o.fromAt);
    const p2 = anchor(b, s2, o.toAt);
    const pts = routePoints(p1, s1, p2, s2, o.via, a, b);
    const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
    const cls = `d-edge d-edge-${o.style || 'flow'}`;
    let label = '';
    if (o.label) {
      const lp = labelPos(pts, o.labelSeg);
      const w = o.label.length * 6.1 + 10;
      // Keep a horizontal label clear of the node the edge points into.
      const lx = lp.vertical ? lp.x + w / 2 + 4 : Math.min(lp.x, lp.x2 - w / 2 - 8);
      const ly = lp.vertical ? lp.y : lp.y - 10;
      label = `<rect x="${lx - w / 2}" y="${ly - 8}" width="${w}" height="16" rx="3" class="d-edge-label-bg"/><text x="${lx}" y="${ly}" class="d-edge-label" text-anchor="middle" dominant-baseline="central">${esc(o.label)}</text>`;
    }
    return { path: `<path d="${d}" class="${cls}" marker-end="url(#arrow-${o.style || 'flow'})"/>`, label };
  });

  return `<svg viewBox="0 ${minY} ${maxX} ${maxY - minY}" class="diagram" role="img" aria-label="${esc(p.title)} architecture diagram">
    <defs>
      ${['flow', 'loop', 'log'].map((k) => `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow-${k}"/></marker>`).join('')}
    </defs>
    ${edges.map((e) => e.path).join('')}
    ${all.map(nodeSvg).join('')}
    ${edges.map((e) => e.label).join('')}
  </svg>`;
}

/** Small legend explaining the notation. */
export function renderLegend() {
  const item = (svg, label) => `<span class="legend-item"><svg viewBox="0 0 34 22" width="34" height="22" aria-hidden="true">${svg}</svg>${esc(label)}</span>`;
  return `<div class="legend">
    ${item('<rect x="2" y="3" width="30" height="16" rx="8" class="d-pill"/>', 'Request or answer')}
    ${item('<rect x="2" y="3" width="30" height="16" rx="3" class="d-model"/>', 'Model')}
    ${item('<rect x="2" y="3" width="30" height="16" rx="3" class="d-gate"/>', 'Governance checkpoint')}
    ${item('<rect x="2" y="3" width="30" height="16" rx="3" class="d-tool"/>', 'Tool')}
    ${item('<polygon points="17,2 32,11 17,20 2,11" class="d-decision"/>', 'Decision')}
    ${item('<rect x="2" y="3" width="30" height="16" rx="5" class="d-human"/>', 'Person')}
    ${item('<rect x="2" y="4" width="30" height="14" rx="2" class="d-store"/>', 'Audit record')}
    ${item('<path d="M2,11 H30" class="d-edge d-edge-loop"/>', 'Loop back')}
    ${item('<path d="M2,11 H30" class="d-edge d-edge-log"/>', 'Logged')}
  </div>`;
}
