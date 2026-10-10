// Berth: UI, routing and the send pipeline.
//
// Four areas, one per outcome:
//   Build   design an agent as a pipeline (input, protect, route, work, review, approve)
//   Work    use agents; every answer shows the time and money it saved
//   Comply  each agent's risk tier, controls and an evidence pack
//   Govern  approvals, audit log, policy and settings

import { MODELS, PROVIDERS, modelById, provenance } from './models.js';
import { state, save, uid, resetAll } from './store.js';
import { listModels, hasKey } from './providers.js';
import {
  ROLES, rolesFor, defaultModels, modelsUsed, execute, priceOf, formatCost,
} from './pipeline.js';
import {
  redact, checkPolicy, preSend, checkOutput, audit, estimateTokens, summarise, describeCounts, auditToCsv, PII_TYPES,
} from './governance.js';
import { TIERS, USED_BY, controlsFor, describeControls, classify } from './risk.js';
import { TOOLS, toolDefs, toolByFunctionName } from './tools.js';
import { extractText, ACCEPT as ACCEPT_TYPES } from './extract.js';
import { TEMPLATES } from './templates.js';
import { PATTERNS, renderDiagram, renderLegend } from './diagrams.js';
import { loadStatus, currentStatus, docs as docsApi } from './api.js';

// ---------------------------------------------------------------------------
// Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = () => $('#app');

const TYPES = {
  chatbot: { label: 'Chatbot', models: 'One model', line: 'One model answers from its instructions and documents.' },
  agent: { label: 'Agent', models: 'Two or three models', line: 'A cheap router sends simple requests to a fast model and complex ones to a strong model with tools.' },
  harness: { label: 'Harness', models: 'Up to four models', line: 'An agent inside a controlled pipeline: routing, work, an independent reviewer, then human approval.' },
};

const SAFEGUARD_LIBRARY = {
  blindScreening: { label: 'Blind screening', detail: 'Remove name, age, gender, nationality and photo references', from: 'candidate-screener' },
  redFlagStop: { label: 'Emergency stop', detail: 'Stop and show emergency advice on red-flag symptoms', from: 'symptom-guide' },
  citationCheck: { label: 'Citation check', detail: 'Flag cited cases and statutes as unverified', from: 'contract-reviewer' },
  noReject: { label: 'Shortlist only', detail: 'Flag any answer that rejects a person', from: 'candidate-screener' },
  noFinalDecision: { label: 'No final decisions', detail: 'Flag answers that read as a final approval or refusal', from: 'loan-checker' },
};

const APPROVER = {
  'Lenders or insurers': 'Credit officer',
  'HR and recruitment': 'Recruiter',
  'Clinicians or patients': 'Clinician',
  'Law firm': 'Lawyer',
  'Court or tribunal': 'Judicial officer',
  'Schools or universities': 'Teacher',
  'Public authority': 'Case officer',
  'Customers or the public': 'Staff reviewer',
  'Internal team': 'Team lead',
};

const SAMPLE_DOCS = [...new Set(TEMPLATES.flatMap((t) => t.docScope || []))];

function tmpl(key) { return TEMPLATES.find((t) => t.key === key); }
function buildById(id) { return state.builds.find((b) => b.id === id); }
function approverOf(b) { return APPROVER[b.usedBy] || 'Reviewer'; }
function industryOf(b) { return (b.templateKey && tmpl(b.templateKey)?.industry) || 'Custom'; }
function shortDoc(name) { return String(name).replace(/^Meridian Bank · /, ''); }

function tierChip(tier, extra = '') {
  if (!tier) return '<span class="chip chip-pending">Tier set on save</span>';
  const t = TIERS[tier] || TIERS.minimal;
  return `<span class="chip chip-${tier}">${esc(t.label)} risk${extra ? ` · ${esc(extra)}` : ''}</span>`;
}

function renderMarkdown(text) {
  const html = window.marked ? window.marked.parse(text || '') : esc(text).replace(/\n/g, '<br>');
  const clean = window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
  return clean.replace(/\[([A-Z]+)_(\d+)\]/g, '<span class="tok">$1_$2</span>');
}

function highlightTokens(text) {
  return esc(text).replace(/\[([A-Z]+)_(\d+)\]/g, '<span class="tok">$1_$2</span>').replace(/\n/g, '<br>');
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function modelStatus(m) {
  if (!state.policy.allowedModels.includes(m.id)) return { ok: false, text: 'Not allowed by policy' };
  if (!hasKey(m.id)) return { ok: false, text: 'No key' };
  const own = Boolean(state.keys[m.provider === 'xai' && state.grokRoute === 'openrouter' ? 'openrouter' : m.provider]);
  return { ok: true, text: own ? 'Your key' : 'Demo' };
}

function minutesLabel(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------------------------------------------------------------------------
// Seed the five governed examples on first run, and migrate older data

function buildFromTemplate(t) {
  return {
    id: uid(),
    templateKey: t.key,
    name: t.name,
    type: t.type,
    modelId: t.modelId,
    purpose: t.purpose,
    usedBy: t.usedBy,
    instructions: t.instructions,
    starters: [...(t.starters || [])],
    models: t.models ? { ...t.models } : defaultModels(t.type, t.modelId),
    routing: true,
    useDocs: Boolean(t.useDocs),
    docScope: t.docScope ? [...t.docScope] : undefined,
    tools: [...(t.tools || [])],
    knowledge: t.knowledge || '',
    protectedTerms: [...(t.protectedTerms || [])],
    safeguards: structuredClone(t.safeguards || {}),
    chosenSafeguards: [...(t.chosenSafeguards || [])],
    harness: t.harness ? structuredClone(t.harness) : undefined,
    maxSteps: t.harness?.maxSteps || 6,
    minutesManual: t.minutesManual || 10,
    tier: t.tier,
    basis: t.basis,
    rationale: t.rationale,
    tierConfirmedBy: 'Template default',
    createdAt: new Date().toISOString(),
  };
}

function refreshTemplates() {
  for (const t of TEMPLATES) {
    const i = state.builds.findIndex((b) => b.templateKey === t.key);
    const fresh = buildFromTemplate(t);
    if (i >= 0) state.builds[i] = { ...fresh, id: state.builds[i].id };
    else state.builds.push(fresh);
  }
}

if (!state.seeded) {
  state.builds = TEMPLATES.map(buildFromTemplate);
  state.seeded = true;
  state.version = 6;
  save();
}
if ((state.version || 0) < 6) {
  // v2–v5 refreshed the examples (routing, documents, GPT default, Meridian Bank);
  // v6 adds time-saved estimates and the step-based designer.
  refreshTemplates();
  for (const b of state.builds) {
    if (b.type !== 'chatbot' && !b.models) { b.models = defaultModels(b.type, b.modelId); b.routing = true; }
    if (!b.minutesManual) b.minutesManual = 10;
  }
  state.version = 6;
  save();
}

// A reload during an answer leaves it half-finished; mark it so.
for (const chat of Object.values(state.chats)) {
  for (const m of chat) {
    if (m.status === 'streaming') { m.status = 'error'; m.error = 'Interrupted by a page reload.'; }
  }
}

// ---------------------------------------------------------------------------
// Icons

const svg = (body, size = 18, sw = 1.7) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  build: svg('<rect x="3" y="4" width="6" height="6" rx="1.5"/><rect x="15" y="4" width="6" height="6" rx="1.5"/><rect x="9" y="14" width="6" height="6" rx="1.5"/><path d="M9 7h6M6 10v3h12v-3M12 13v1"/>'),
  work: svg('<path d="M4 6h16v10H8l-4 4z"/><path d="M8 10h8M8 13h5"/>'),
  comply: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>'),
  govern: svg('<path d="M4 20h16M6 20V10M10 20V10M14 20V10M18 20V10M3 10l9-6 9 6z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>', 16, 2),
  arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 16, 2),
  back: svg('<path d="M19 12H5M11 18l-6-6 6-6"/>', 16, 2),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 16, 2),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', 14, 2),
  shield: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>', 14, 1.8),
  check: svg('<path d="M5 12l4 4L19 6"/>', 14, 2.2),
  dash: svg('<path d="M6 12h12"/>', 14, 2),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 16, 1.8),
  alert: svg('<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4M12 17h.01"/>', 16, 1.8),
  panel: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', 16, 1.8),
  doc: svg('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>', 16, 1.8),
  // pipeline step icons
  input: svg('<path d="M4 12h12M12 6l6 6-6 6"/>', 16, 2),
  protect: svg('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M9 12h6"/>', 16, 2),
  route: svg('<path d="M6 4v6a4 4 0 0 0 4 4h8M14 10l4 4-4 4M6 4v16"/>', 16, 2),
  workstep: svg('<path d="M12 3l2.2 5.3L20 9l-4.4 3.9L17 19l-5-3-5 3 1.4-6.1L4 9l5.8-.7z"/>', 16, 1.8),
  review: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M8.5 11l2 2 3.5-4"/>', 16, 2),
  approve: svg('<path d="M7 11V6a2 2 0 0 1 4 0v5M11 10V4a2 2 0 0 1 4 0v7M15 9a2 2 0 0 1 4 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.5L3 14a2 2 0 0 1 3.4-2L7 13"/>', 16, 1.8),
};

// ---------------------------------------------------------------------------
// Shell: top app bar, optional secondary tabs, bottom navigation on phones

const TABS = [
  { key: 'build', label: 'Build', href: '#/build', icon: ICON.build },
  { key: 'work', label: 'Work', href: '#/work', icon: ICON.work },
  { key: 'comply', label: 'Comply', href: '#/comply', icon: ICON.comply },
  { key: 'govern', label: 'Govern', href: '#/govern', icon: ICON.govern },
];

function chatEntries() {
  return Object.entries(state.chats).filter(([k]) => !k.startsWith('test:'));
}

function heldItems() {
  const out = [];
  for (const [id, chat] of chatEntries()) {
    const b = buildById(id);
    if (!b) continue;
    chat.forEach((m, i) => { if (m.role === 'assistant' && m.status === 'held') out.push({ build: b, msg: m, index: i, chat }); });
  }
  return out.sort((a, b) => String(b.msg.at).localeCompare(String(a.msg.at)));
}

function appbar(tab) {
  const held = heldItems().length;
  const st = currentStatus();
  return `
  <header class="appbar">
    <a class="logo" href="#/" aria-label="Berth home"><span class="logo-mark">B</span><span class="logo-word">Berth</span></a>
    <nav class="tabs" aria-label="Main">
      ${TABS.map((t) => `<a class="tab ${tab === t.key ? 'is-on' : ''}" href="${t.href}" ${tab === t.key ? 'aria-current="page"' : ''}>${t.label}${t.key === 'govern' && held ? `<span class="badge">${held}</span>` : ''}</a>`).join('')}
    </nav>
    <div class="appbar-end">
      ${st.demo ? '<span class="live"><i></i>Live demo</span>' : ''}
      <a class="icon-btn" href="#/govern/settings" aria-label="Settings and API keys" title="Settings and API keys">${ICON.gear}</a>
    </div>
  </header>`;
}

function bottomnav(tab) {
  const held = heldItems().length;
  return `<nav class="bottomnav" aria-label="Main">${TABS.map((t) => `
    <a class="bn ${tab === t.key ? 'is-on' : ''}" href="${t.href}">${t.icon}<span>${t.label}</span>${t.key === 'govern' && held ? `<span class="badge">${held}</span>` : ''}</a>`).join('')}</nav>`;
}

function subnav(items, active) {
  return `<div class="subnav">${items.map(([key, label, href, count]) => `<a class="subtab ${active === key ? 'is-on' : ''}" href="${href}">${esc(label)}${count ? `<span class="count">${count}</span>` : ''}</a>`).join('')}</div>`;
}

function shell(tab, body, { sub = '', cls = '' } = {}) {
  app().innerHTML = `<div class="frame ${tab ? '' : 'is-home'}">${appbar(tab)}${sub}<main class="view ${cls}" id="view">${body}</main>${bottomnav(tab)}</div>`;
  $('#view')?.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Home: the four-step journey

function renderHome() {
  const examples = state.builds.filter((b) => b.templateKey);
  const loan = examples.find((b) => b.templateKey === 'loan-checker');
  const st = currentStatus();
  shell('', `
  <div class="home">
    <section class="home-hero">
      <span class="eyebrow-pill">Governed AI workspace</span>
      <h1>Build agents that increase productivity, prove compliance and drive governance.</h1>
      <p class="home-sub">Multi-model agentic AI with governance and compliance logs. Berth sits between your people and seven AI models, and every request is protected, routed, checked and logged.</p>
      <div class="cta-row">
        <a class="btn btn-dark btn-lg" href="#/build">Build an agent ${ICON.arrow}</a>
        ${loan ? `<a class="btn btn-soft btn-lg" href="#/work/${loan.id}">Try a live example</a>` : ''}
      </div>
      ${st.demo ? `<p class="home-note">Live demo inside Meridian Bank, a fictional bank. No sign-up or API key needed.</p>` : ''}
    </section>

    <section class="journey" aria-label="How Berth works">
      <a class="jcard" href="#/build">
        <span class="jstep">1</span>
        <h2>Build agents</h2>
        <p>Design an agent as a pipeline and give each step the right model.</p>
        <span class="jvis">
          <span class="mini-pipe">
            <span class="mp mp-protect">Protect</span><i></i><span class="mp mp-route">Route</span><i></i><span class="mp mp-work">Work</span><i></i><span class="mp mp-review">Review</span><i></i><span class="mp mp-approve">Approve</span>
          </span>
          <span class="mini-row"><span>Router</span><b>Mistral</b></span>
          <span class="mini-row"><span>Worker</span><b>GPT</b></span>
          <span class="mini-row"><span>Reviewer</span><b>Claude</b></span>
        </span>
        <span class="jlink">Open Build ${ICON.arrow}</span>
      </a>
      <a class="jcard" href="${loan ? `#/work/${loan.id}` : '#/work'}">
        <span class="jstep">2</span>
        <h2>Increase productivity</h2>
        <p>Staff get cited answers from company documents in seconds.</p>
        <span class="jvis">
          <span class="mini-answer"><b>Meets criteria.</b> Repayments are 13% of income, under the 35% limit <span class="cite">S1</span></span>
          <span class="mini-metrics"><span class="good">~18 min saved</span><span>58% cheaper than one large model</span></span>
        </span>
        <span class="jlink">Open Work ${ICON.arrow}</span>
      </a>
      <a class="jcard" href="#/comply">
        <span class="jstep">3</span>
        <h2>Prove compliance</h2>
        <p>Each agent is classified under the EU AI Act and the controls switch on to match.</p>
        <span class="jvis">
          <span class="mini-tier"><b>High risk</b><span>Annex III(5)(b)</span></span>
          <span class="mini-gauge"><i></i><i></i><i class="on"></i><i></i></span>
          <span class="mini-check">${ICON.check} Personal data redacted</span>
          <span class="mini-check">${ICON.check} Held for human approval</span>
        </span>
        <span class="jlink">Open Comply ${ICON.arrow}</span>
      </a>
      <a class="jcard" href="#/govern">
        <span class="jstep">4</span>
        <h2>Drive governance</h2>
        <p>Approve answers, set policy and export a complete audit trail.</p>
        <span class="jvis mono-vis">
          <span>20:41 redact · EMAIL ×1</span>
          <span>20:41 route · mistral → strong</span>
          <span>20:41 review · passed</span>
          <span class="good">20:43 approved · credit officer</span>
        </span>
        <span class="jlink">Open Govern ${ICON.arrow}</span>
      </a>
    </section>

    <section class="flow-sec">
      <h2 class="sec-title">How a request flows</h2>
      <div class="flow">
        <div class="flow-col">
          <span class="flow-h">Your people</span>
          <span class="ent">Staff<small>policy and HR questions</small></span>
          <span class="ent">Credit officers<small>loan assessments</small></span>
          <span class="ent">Recruiters<small>candidate screening</small></span>
        </div>
        <span class="flow-link" aria-hidden="true"><span>request</span></span>
        <div class="flow-core">
          <div class="core-head"><b>Berth</b><span>governance layer</span></div>
          <div class="layer"><span class="k k1">1</span><span><b>Protect</b><small>Personal data removed in the browser before anything is sent</small></span></div>
          <div class="layer"><span class="k k2">2</span><span><b>Route</b><small>A cheap model triages; hard work goes to a strong one</small></span></div>
          <div class="layer"><span class="k k3">3</span><span><b>Control</b><small>The risk tier sets review and human approval</small></span></div>
          <div class="layer"><span class="k k4">4</span><span><b>Log</b><small>Every prompt, route, source and decision, exportable</small></span></div>
          <div class="core-docs">+ Your documents · every answer cites its source</div>
        </div>
        <span class="flow-link" aria-hidden="true"><span>safe call</span></span>
        <div class="flow-col">
          <span class="flow-h">Any model</span>
          ${['Claude', 'GPT', 'Gemini', 'Grok'].map((n) => `<span class="ent ent-row">${n}<em>closed</em></span>`).join('')}
          <span class="ent ent-row">Mistral · Llama · Qwen<em>open</em></span>
        </div>
      </div>
    </section>

    <section>
      <div class="sec-head"><h2 class="sec-title">Five agents inside Meridian Bank</h2><a class="text-link" href="#/build">See all in Build ${ICON.arrow}</a></div>
      <p class="sec-lede">One fictional bank, five uses from minimal to high risk. Each answers from the bank's own policy.</p>
      <div class="ex-grid">
        ${examples.map((b) => `
          <a class="ex-card" href="#/work/${b.id}">
            <span class="ex-top"><span class="ex-ind">${esc(industryOf(b))}</span>${tierChip(b.tier)}</span>
            <span class="ex-name">${esc(b.name)}</span>
            <span class="ex-meta">${esc(TYPES[b.type].label)} · ${modelsUsed(b).map((id) => esc(modelById(id).name)).join(', ')}</span>
          </a>`).join('')}
      </div>
    </section>

    <footer class="home-foot">
      <span>Berth is a working prototype built as preparatory work for doctoral research on AI governance.</span>
      <span><a href="#/how">Architecture patterns</a> · <a href="https://github.com/HackrLife/Berth" target="_blank" rel="noopener">Source on GitHub</a> · <a href="https://github.com/HackrLife/Berth/blob/main/PRD.md" target="_blank" rel="noopener">Product requirements</a></span>
    </footer>
  </div>`, { cls: 'view-home' });
}

// ---------------------------------------------------------------------------
// Build: agent gallery, architecture patterns and the designer

function buildSub(active) {
  return subnav([['agents', 'Agents', '#/build'], ['patterns', 'Architecture patterns', '#/how']], active);
}

function miniPipe(type) {
  const steps = type === 'chatbot' ? ['Protect', 'Work'] : type === 'agent' ? ['Protect', 'Route', 'Work'] : ['Protect', 'Route', 'Work', 'Review', 'Approve'];
  return `<span class="mini-pipe">${steps.map((s, i) => `${i ? '<i></i>' : ''}<span class="mp mp-${s.toLowerCase()}">${s}</span>`).join('')}</span>`;
}

function renderBuildIndex() {
  const builds = state.builds;
  shell('build', `
  <div class="page">
    <header class="page-head">
      <h1>Build</h1>
      <p class="lede">Design an agent as a pipeline of steps. Each step has its own model and controls, and the risk tier locks the controls the law requires.</p>
    </header>
    <section>
      <h2 class="sec-title sm">Start a new agent</h2>
      <div class="start-grid">
        ${Object.entries(TYPES).map(([k, t]) => `
          <button type="button" class="start-card" data-action="new-agent" data-type="${k}">
            <span class="start-top"><b>${t.label}</b><span class="soft-tag">${esc(t.models)}</span></span>
            <span class="start-line">${esc(t.line)}</span>
            ${miniPipe(k)}
            <span class="jlink">Start ${ICON.arrow}</span>
          </button>`).join('')}
      </div>
    </section>
    <section>
      <h2 class="sec-title sm">Your agents</h2>
      <div class="agent-grid">
        ${builds.map((b) => `
          <div class="agent-card">
            <span class="ex-top"><span class="ex-ind">${esc(industryOf(b))} · ${esc(TYPES[b.type].label)}</span>${tierChip(b.tier)}</span>
            <span class="ex-name">${esc(b.name)}</span>
            <span class="agent-purpose">${esc(b.purpose || '')}</span>
            ${miniPipeFor(b)}
            <span class="agent-actions">
              <a class="btn btn-soft btn-sm" href="#/build/${b.id}">Design</a>
              <a class="btn btn-dark btn-sm" href="#/work/${b.id}">Use</a>
            </span>
          </div>`).join('')}
      </div>
    </section>
  </div>`, { sub: buildSub('agents') });
}

function miniPipeFor(b) {
  const c = controlsFor(b);
  const steps = ['Protect'];
  if (b.type !== 'chatbot' && b.routing !== false) steps.push('Route');
  steps.push('Work');
  if (b.type === 'harness' && b.harness?.review !== false) steps.push('Review');
  if (c.approval) steps.push('Approve');
  return `<span class="mini-pipe">${steps.map((s, i) => `${i ? '<i></i>' : ''}<span class="mp mp-${s.toLowerCase()}">${s}</span>`).join('')}</span>`;
}

function renderHow(id) {
  const p = PATTERNS.find((x) => x.id === id) || PATTERNS[0];
  const groups = [...new Set(PATTERNS.map((x) => x.group))];
  shell('build', `
  <div class="split-page">
    <aside class="side-list" aria-label="Patterns">
      ${groups.map((g) => `
        <div class="side-group">
          <div class="side-h">${esc(g)}</div>
          ${PATTERNS.filter((x) => x.group === g).map((x) => `
            <a class="side-item ${x.id === p.id ? 'is-on' : ''}" href="#/how/${x.id}" ${x.id === p.id ? 'aria-current="page"' : ''}>
              <span>${esc(x.title)}</span>${x.status === 'reference' ? '<span class="soft-tag">ref</span>' : ''}
            </a>`).join('')}
        </div>`).join('')}
    </aside>
    <section class="split-main">
      <label class="how-select"><span class="sr-only">Pattern</span>
        <select id="how-select">${groups.map((g) => `<optgroup label="${esc(g)}">${PATTERNS.filter((x) => x.group === g).map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</optgroup>`).join('')}</select>
      </label>
      <header class="page-head">
        <span class="eyebrow">${esc({ Agents: 'Agent pattern', Harnesses: 'Harness pattern', Foundations: 'Foundation' }[p.group])}</span>
        <div class="row between wrap"><h1>${esc(p.title)}</h1>
          <span class="chip ${p.status === 'runs' ? 'chip-ok' : 'chip-soft'}">${p.status === 'runs' ? 'Runs in Berth today' : 'Reference design'}</span></div>
        <p class="lede">${esc(p.summary)}</p>
      </header>
      <figure class="diagram-card">
        <div class="diagram-scroll">${renderDiagram(p)}</div>
        <figcaption>${renderLegend()}</figcaption>
      </figure>
      <div class="facts3">
        <div><h3>When to use it</h3><p>${esc(p.when)}</p></div>
        <div><h3>Cost</h3><p>${esc(p.cost)}</p></div>
        <div><h3>Governance</h3><p>${esc(p.governance)}</p></div>
      </div>
      <p class="small dim">These patterns are independent of industry or use case.</p>
    </section>
  </div>`, { sub: buildSub('patterns') });
}

// --- Designer --------------------------------------------------------------

let draft = null;
const designer = { sel: 'work', testText: '', dirty: false };

function newDraft(type) {
  const d = {
    id: null,
    name: `New ${TYPES[type].label.toLowerCase()}`,
    type,
    modelId: 'gpt',
    models: type === 'chatbot' ? {} : defaultModels(type, 'gpt'),
    routing: true,
    purpose: '',
    usedBy: 'Internal team',
    instructions: '',
    starters: [],
    tools: type === 'chatbot' ? [] : ['calculator'],
    knowledge: '',
    protectedTerms: [],
    safeguards: {},
    chosenSafeguards: [],
    useDocs: false,
    docScope: [],
    harness: type === 'harness' ? { approval: true, fullLog: true, aiLabel: true, review: true, retry: true, toolModes: {} } : undefined,
    maxSteps: 6,
    minutesManual: 10,
    tier: null,
  };
  return d;
}

/** Template safeguards plus any chosen from the library. */
function compileSafeguards(d) {
  const base = d.templateKey ? structuredClone(tmpl(d.templateKey)?.safeguards || {}) : {};
  const chosen = d.chosenSafeguards || [];
  if (chosen.includes('blindScreening') && !base.extraRedaction) {
    const t = tmpl('candidate-screener').safeguards;
    Object.assign(base, { extraRedaction: t.extraRedaction, extraRedactionTitle: t.extraRedactionTitle, extraRedactionDetail: t.extraRedactionDetail });
  }
  if (chosen.includes('redFlagStop') && !base.redFlagStop) base.redFlagStop = tmpl('symptom-guide').safeguards.redFlagStop;
  if (chosen.includes('citationCheck')) base.citationCheck = true;
  const forbid = [...(base.forbidOutput || [])];
  const addForbid = (rules) => rules.forEach((r) => { if (!forbid.some((f) => f.label === r.label)) forbid.push(r); });
  if (chosen.includes('noReject')) addForbid(tmpl('candidate-screener').safeguards.forbidOutput);
  if (chosen.includes('noFinalDecision')) addForbid(tmpl('loan-checker').safeguards.forbidOutput);
  if (forbid.length) base.forbidOutput = forbid;
  return base;
}

function safeguardFromTemplate(d, key) {
  const base = d.templateKey ? tmpl(d.templateKey)?.safeguards || {} : {};
  if (key === 'blindScreening') return Boolean(base.extraRedaction);
  if (key === 'redFlagStop') return Boolean(base.redFlagStop);
  if (key === 'citationCheck') return Boolean(base.citationCheck);
  if (key === 'noReject') return (base.forbidOutput || []).some((r) => /reject/i.test(r.label));
  if (key === 'noFinalDecision') return (base.forbidOutput || []).some((r) => /final decision/i.test(r.label));
  return false;
}

/** The draft as the engine sees it. */
function compiled(d) {
  return { ...d, safeguards: compileSafeguards(d), tier: d.tier || 'minimal', id: d.id || 'draft' };
}

function stepsFor(d) {
  const b = compiled(d);
  const c = controlsFor(b);
  const steps = [];
  steps.push({ key: 'input', kind: 'Input', icon: ICON.input, title: d.usedBy, text: d.purpose || 'Say what it is for. This sets the risk tier.' });
  const extra = [];
  if (c.extraRedaction?.length) extra.push(c.extraRedactionTitle || 'Extra redaction');
  if (c.redFlagStop) extra.push('Emergency stop');
  if (d.protectedTerms?.length) extra.push(`${d.protectedTerms.length} protected name${d.protectedTerms.length > 1 ? 's' : ''}`);
  steps.push({ key: 'protect', kind: 'Protect', icon: ICON.protect, title: 'Redact', text: 'Personal data removed in the browser before sending', tag: extra.length ? extra.join(' · ') : 'Always on', tagCls: 'ok' });
  if (d.type !== 'chatbot') {
    steps.push({
      key: 'route', kind: 'Route', icon: ICON.route, title: modelById(d.models.router)?.name || 'Router', off: d.routing === false,
      fork: [['simple', modelById(d.models.fast)?.name], ['complex', modelById(d.models.strong)?.name]], removable: !(d.type === 'harness' && d.routing === false),
    });
  }
  const workModel = d.type === 'chatbot' ? d.modelId : d.models.strong;
  const toolCount = d.type === 'chatbot' ? 0 : (d.tools || []).filter((t) => t !== 'documents').length;
  const docCount = d.useDocs ? (d.docScope?.length || 'all') : 0;
  steps.push({
    key: 'work', kind: 'Work', icon: ICON.workstep, title: modelById(workModel)?.name || '',
    text: [toolCount ? `${toolCount} tool${toolCount > 1 ? 's' : ''}` : '', docCount ? (docCount === 'all' ? 'all documents' : `${docCount} document${docCount > 1 ? 's' : ''}`) : ''].filter(Boolean).join(' · ') || 'Instructions only',
    tag: d.useDocs ? 'Cites sources' : '', tagCls: 'blue',
  });
  if (d.type === 'harness') {
    const rv = modelById(d.models.reviewer);
    const sameVendor = [d.models.fast, d.models.strong].some((w) => modelById(w)?.maker === rv?.maker);
    steps.push({ key: 'review', kind: 'Review', icon: ICON.review, title: rv?.name || '', text: 'Checks the draft against the rules; one revision', tag: sameVendor ? 'Same vendor as worker' : 'Independent vendor', tagCls: sameVendor ? 'warn' : 'ok', removable: true, off: d.harness?.review === false });
  }
  if (c.approval) {
    const locked = b.tier === 'high';
    steps.push({ key: 'approve', kind: 'Approve', icon: ICON.approve, title: approverOf(d), text: 'Answer held until a person signs off', tag: locked ? 'Required: high risk' : 'Optional', tagCls: locked ? 'red' : 'soft', locked, removable: !locked });
  }
  return steps;
}

function stepCard(s) {
  const sel = designer.sel === s.key;
  return `
    <div class="step ${sel ? 'is-sel' : ''} ${s.off ? 'is-off' : ''}" data-action="d-select" data-step="${s.key}" role="button" tabindex="0" aria-pressed="${sel}">
      ${s.removable ? `<button type="button" class="step-x" data-action="d-remove" data-step="${s.key}" aria-label="Remove ${esc(s.kind)} step">${ICON.close}</button>` : ''}
      ${s.locked ? `<span class="step-lock" title="Required by the risk tier">${ICON.lock}</span>` : ''}
      <span class="step-ic ic-${s.key}">${s.icon}</span>
      <span class="step-kind">${esc(s.kind)}${s.off ? ' · off' : ''}</span>
      <span class="step-title">${esc(s.title)}</span>
      ${s.fork ? `<span class="step-fork">${s.fork.map(([a, m]) => `<span><em>${a}</em><b>${esc(m || '')}</b></span>`).join('')}</span>` : `<span class="step-text">${esc(s.text || '')}</span>`}
      ${s.tag ? `<span class="step-tag tag-${s.tagCls || 'soft'}">${esc(s.tag)}</span>` : ''}
    </div>`;
}

function modelChips(role, current) {
  return `<div class="mchips">${MODELS.map((m) => {
    const s = modelStatus(m);
    const allowed = state.policy.allowedModels.includes(m.id);
    return `<button type="button" class="mchip ${current === m.id ? 'is-on' : ''}" data-action="d-model" data-role="${role}" data-id="${m.id}" ${allowed ? '' : 'disabled'} title="${esc(m.maker)} · ${esc(provenance(m))} · ${esc(s.text)}">
      <b>${esc(m.name)}</b><small>${m.weights === 'open' ? 'open' : esc(m.maker)}${s.ok ? '' : ' · no key'}</small></button>`;
  }).join('')}</div>`;
}

function toggle(bind, on, label, detail = '', { disabled = false } = {}) {
  return `<label class="opt ${disabled ? 'is-locked' : ''}"><input type="checkbox" data-bind="${bind}" ${on ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><b>${esc(label)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</span>${disabled ? `<span class="opt-lock">${ICON.lock}</span>` : ''}</label>`;
}

function availableDocs() {
  const names = new Set(SAMPLE_DOCS);
  (kb.docs || []).forEach((x) => names.add(x.name));
  (draft?.docScope || []).forEach((n) => names.add(n));
  return [...names];
}

function sheetFor(key) {
  const d = draft;
  const b = compiled(d);
  const c = controlsFor(b);
  const high = b.tier === 'high';
  const head = (kicker, title, desc) => `<div class="sheet-head"><span class="eyebrow">${esc(kicker)}</span><h2>${esc(title)}</h2><p>${esc(desc)}</p></div>`;

  if (key === 'input') {
    return `${head('Step 1 · Input', 'Who uses it, and for what', 'The purpose and who uses it decide the risk tier under the EU AI Act.')}
      <label class="fld"><span>Purpose</span><textarea data-bind="purpose" rows="3" placeholder="The job it does and for whom">${esc(d.purpose)}</textarea></label>
      <label class="fld"><span>Used by</span><select data-bind="usedBy">${USED_BY.map((u) => `<option ${d.usedBy === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
      <label class="fld"><span>Time a person takes today <em>minutes per task, for the time-saved estimate</em></span><input type="number" min="1" max="600" data-bind="minutesManual" value="${d.minutesManual || 10}"></label>
      <label class="fld"><span>Questions to try <em>one per line</em></span><textarea data-bind="starters" rows="3">${esc((d.starters || []).join('\n'))}</textarea></label>`;
  }
  if (key === 'protect') {
    const piiOn = Object.entries(PII_TYPES).filter(([k]) => state.policy.redact[k]).map(([, v]) => v);
    return `${head('Step 2 · Protect', 'Remove personal data first', 'Runs in the browser, so personal data never reaches a model.')}
      <div class="fld"><span>Always removed <em>set in Govern › Policy</em></span><div class="pill-row">${piiOn.map((p) => `<span class="pill">${esc(p)}</span>`).join('')}</div></div>
      <label class="fld"><span>Protected names <em>comma separated, always replaced</em></span><input data-bind="protectedTerms" value="${esc((d.protectedTerms || []).join(', '))}" placeholder="Client, supplier or patient names"></label>
      <div class="fld"><span>Safeguards</span>
        ${Object.entries(SAFEGUARD_LIBRARY).map(([k, s]) => {
          const fromT = safeguardFromTemplate(d, k);
          return `<label class="opt ${fromT ? 'is-locked' : ''}"><input type="checkbox" data-safeguard="${k}" ${fromT || d.chosenSafeguards?.includes(k) ? 'checked' : ''} ${fromT ? 'disabled' : ''}><span><b>${esc(s.label)}</b><small>${esc(s.detail)}</small></span>${fromT ? `<span class="opt-lock" title="Set by the example">${ICON.lock}</span>` : ''}</label>`;
        }).join('')}
      </div>`;
  }
  if (key === 'route') {
    return `${head('Step 3 · Route', 'Send each request to the right model', 'A cheap router sorts requests. Simple ones go to the fast model, complex ones to the strong model in Work.')}
      ${toggle('routing', d.routing !== false, 'Route by difficulty', 'Off sends everything to the strong model')}
      <div class="fld"><span>Router <em>choose a cheap, fast model</em></span>${modelChips('router', d.models.router)}</div>
      <div class="fld"><span>Fast model <em>handles simple requests</em></span>${modelChips('fast', d.models.fast)}</div>
      <p class="sheet-note">Price per million tokens: router ${priceLine(d.models.router)} · fast ${priceLine(d.models.fast)} · strong ${priceLine(d.models.strong)}</p>`;
  }
  if (key === 'work') {
    const isChat = d.type === 'chatbot';
    const docs = availableDocs();
    return `${head(`Step ${isChat ? 3 : 4} · Work`, 'Do the work', 'The model that writes the answer, with the tools and documents it may use.')}
      <div class="fld"><span>${isChat ? 'Model' : 'Strong model'}</span>${modelChips(isChat ? 'chatbot' : 'strong', isChat ? d.modelId : d.models.strong)}</div>
      ${isChat ? '' : `<div class="fld"><span>Tools</span>
        ${Object.entries(TOOLS).filter(([k]) => k !== 'documents').map(([k, t]) => `
          <div class="opt-wrap"><label class="opt"><input type="checkbox" data-tool="${k}" ${d.tools?.includes(k) ? 'checked' : ''}><span><b>${esc(t.label)}</b><small>${esc(t.blurb)}</small></span></label>
          ${d.type === 'harness' && d.tools?.includes(k) ? `<select class="mode" data-toolmode="${k}" aria-label="${esc(t.label)} permission">${['auto', 'ask', 'off'].map((m) => `<option value="${m}" ${(d.harness?.toolModes?.[k] || 'auto') === m ? 'selected' : ''}>${{ auto: 'Runs automatically', ask: 'Ask me first', off: 'Blocked' }[m]}</option>`).join('')}</select>` : ''}</div>`).join('')}
      </div>`}
      <div class="fld"><span>Documents it answers from <em>${currentStatus().retrieval ? 'cited in every answer' : 'available on the hosted demo'}</em></span>
        ${toggle('useDocs', d.useDocs, 'Search documents', 'Retrieve passages and cite them as sources', { disabled: !currentStatus().retrieval && !d.useDocs })}
        ${d.useDocs ? docs.map((n) => `<label class="opt opt-sm"><input type="checkbox" data-doc="${esc(n)}" ${(d.docScope || []).includes(n) ? 'checked' : ''}><span><b>${esc(shortDoc(n))}</b>${n.startsWith('Meridian Bank') ? '<small>Meridian Bank sample</small>' : '<small>Your document</small>'}</span></label>`).join('') + '<a class="text-link small" href="#/knowledge">Upload your own in Work › Documents</a>' : ''}
      </div>
      <label class="fld"><span>Instructions</span><textarea data-bind="instructions" rows="6" placeholder="How it behaves, what it must never do, the format of answers">${esc(d.instructions)}</textarea></label>
      <details class="fld-more"><summary>Reference text and step limit</summary>
        <label class="fld"><span>Reference text <em>${isChat ? 'added to the instructions' : 'searchable with the knowledge tool'}</em></span><textarea data-bind="knowledge" rows="4">${esc(d.knowledge)}</textarea></label>
        ${isChat ? '' : `<label class="fld"><span>Step limit</span><input type="number" min="1" max="12" data-bind="maxSteps" value="${d.maxSteps || 6}"></label>`}
      </details>`;
  }
  if (key === 'review') {
    return `${head('Step 5 · Review', 'An independent check', 'A second model checks every draft against the rules before a person sees it. A different vendor gives a more independent check.')}
      <div class="fld"><span>Reviewer</span>${modelChips('reviewer', d.models.reviewer)}</div>
      ${toggle('h.review', d.harness?.review !== false, 'Review every draft')}
      ${toggle('h.retry', d.harness?.retry !== false, 'Revise once on failure', 'The strong model rewrites the answer using the reviewer\'s feedback')}`;
  }
  if (key === 'approve') {
    return `${head('Final step · Approve', 'A person signs off', `Answers are held until ${approverOf(d).toLowerCase()} approves them. Copying is locked until then.`)}
      ${high ? `<div class="lock-note">${ICON.lock}<span><b>Required by the high-risk tier.</b> Human approval (Art. 14) and full record-keeping (Art. 12) cannot be switched off.</span></div>` : ''}
      ${toggle('approval', c.approval, 'Human approval', 'Hold every answer for sign-off', { disabled: high })}
      ${toggle('fullLog', c.fullLog, 'Full record-keeping', 'Keep prompt and answer in the audit log', { disabled: high || d.type !== 'harness' })}
      ${toggle('aiLabel', c.aiLabel, 'AI-generated label', 'Mark every answer as AI-generated (Art. 50)', { disabled: d.type !== 'harness' })}
      ${d.type !== 'harness' ? '<p class="sheet-note">Record-keeping and labels follow the risk tier. Add a Review step to make this a harness and set them yourself.</p>' : ''}`;
  }
  return '';
}

function priceLine(id) {
  const p = priceOf(id);
  return `$${p.in}/$${p.out}`;
}

function addBar(d) {
  const c = controlsFor(compiled(d));
  const btn = (action, label, disabled = false) => `<button type="button" class="add-btn" data-action="${action}" ${disabled ? 'disabled' : ''}>${ICON.plus}${esc(label)}</button>`;
  return `<div class="add-bar"><span class="add-label">Add a step</span>
    ${btn('d-add-route', 'Routing', d.type !== 'chatbot' && d.routing !== false)}
    ${btn('d-add-tool', 'Tool')}
    ${btn('d-add-docs', 'Documents', d.useDocs)}
    ${btn('d-add-review', 'Review', d.type === 'harness')}
    ${btn('d-add-approval', 'Human approval', c.approval)}
  </div>`;
}

function canvasHtml() {
  const d = draft;
  const steps = stepsFor(d);
  return `${addBar(d)}
    <div class="pipeline">${steps.map((s, i) => `${i ? '<span class="link" aria-hidden="true"></span>' : ''}${stepCard(s)}`).join('')}</div>`;
}

function headHtml() {
  const d = draft;
  const stale = d._tierStale || !d.tier;
  return `
    <a class="icon-btn" href="#/build" aria-label="All agents">${ICON.back}</a>
    <input class="dtitle" data-bind="name" value="${esc(d.name)}" aria-label="Agent name">
    <span class="soft-tag">${esc(TYPES[d.type].label)}</span>
    ${stale ? '<span class="chip chip-pending">Risk tier confirmed on save</span>' : tierChip(d.tier, d.basis?.split('·')[0]?.trim())}
    <span class="dhead-end">
      ${d.id ? `<a class="btn btn-soft btn-sm" href="#/work/${d.id}">Use in Work</a>` : ''}
      <button type="button" class="btn btn-dark btn-sm" data-action="d-save">${d.id ? 'Save' : 'Save agent'}</button>
    </span>`;
}

function renderDesigner() {
  const d = draft;
  shell('build', `
  <div class="designer">
    <div class="dhead" id="dhead">${headHtml()}</div>
    <div class="dbody">
      <section class="canvas" id="canvas-wrap">
        <div id="canvas">${canvasHtml()}</div>
        <div class="test-card">
          <div class="test-top"><b>Test run</b><span>Runs the real pipeline · logged to the audit trail</span></div>
          <form class="test-form" id="test-form">
            <label class="sr-only" for="test-input">Test question</label>
            <input id="test-input" value="${esc(designer.testText || d.starters?.[0] || '')}" placeholder="Ask something this agent should handle">
            <button type="submit" class="btn btn-dark" ${run.busy ? 'disabled' : ''}>Run</button>
          </form>
          <div id="test-out">${testOutHtml()}</div>
          <div id="tool-approval"></div>
        </div>
      </section>
      <aside class="sheet" id="sheet" aria-label="Step settings">${sheetFor(designer.sel)}</aside>
    </div>
  </div>`, { cls: 'view-designer' });
}

function paintDesigner({ sheet = false } = {}) {
  if (!$('#canvas')) return renderDesigner();
  $('#canvas').innerHTML = canvasHtml();
  const title = $('.dtitle');
  const focused = document.activeElement === title;
  if (!focused) $('#dhead').innerHTML = headHtml();
  if (sheet) $('#sheet').innerHTML = sheetFor(designer.sel);
}

function testKey() { return `test:${draft?.id || 'draft'}`; }

function testOutHtml() {
  if (!draft) return '';
  const chat = state.chats[testKey()] || [];
  const reply = [...chat].reverse().find((m) => m.role === 'assistant' || m.role === 'system');
  if (!reply) return '<p class="test-empty">Run a question to watch each step light up, with the cost and time saved.</p>';
  if (reply.role === 'system') return `<div class="sys-line">${esc(reply.content)}</div>`;
  const user = chat[chat.lastIndexOf(reply) - 1];
  const lights = (reply.stages || []).map((st) => `<span class="light ${st.status === 'running' ? 'is-run' : 'is-done'}">${st.status === 'running' ? '' : ICON.check}${esc(st.stage)}${st.label || st.modelId ? ` · ${esc(st.label || modelById(st.modelId)?.name || '')}` : ''}${st.note && st.status !== 'running' ? ` · ${esc(st.note)}` : ''}</span>`).join('');
  const red = user?.findings?.length ? `<span class="light is-done">${ICON.check}Protect · ${esc(describeCounts(summarise(user.findings)))} removed</span>` : `<span class="light is-done">${ICON.check}Protect · nothing to remove</span>`;
  const hold = reply.status === 'held' ? `<span class="light is-wait">${ICON.clock}Awaiting ${esc(approverOf(draft).toLowerCase())}</span>` : '';
  return `
    <div class="lights">${red}${lights}${hold}</div>
    <div class="test-answer">${reply.content ? renderMarkdown(reply.content) : '<span class="thinking">Working…</span>'}</div>
    ${reply.status === 'error' ? `<div class="note note-block">${esc(reply.error)}</div>` : ''}
    ${reply.notes?.length ? `<div class="notes">${reply.notes.map((n) => `<div class="note note-${n.level}">${esc(n.text)}</div>`).join('')}</div>` : ''}
    ${reply.status !== 'streaming' && reply.cost != null ? `<div class="test-metrics">${metricsHtml(reply)}</div>` : ''}`;
}

function metricsHtml(msg) {
  const parts = [];
  if (msg.cost != null) parts.push(`<span>${formatCost(msg.cost)}</span>`);
  if (msg.baseline > msg.cost * 1.05) parts.push(`<span class="good">${Math.round((1 - msg.cost / msg.baseline) * 100)}% cheaper than strong-only</span>`);
  if (msg.minutesSaved) parts.push(`<span class="good">~${minutesLabel(msg.minutesSaved)} saved</span>`);
  return parts.join('<span class="sep">·</span>');
}

// Type changes driven by adding or removing steps
function toAgent(d) {
  if (d.type === 'chatbot') {
    d.models = { ...defaultModels('agent', d.modelId), strong: d.modelId };
    if (!d.tools?.length) d.tools = ['calculator'];
    d.routing = true;
  }
  d.type = 'agent';
}
function toHarness(d) {
  if (d.type === 'chatbot') toAgent(d);
  const c = controlsFor(compiled(d));
  d.models = { ...defaultModels('harness', d.models.strong), ...d.models };
  if (!d.models.reviewer) d.models.reviewer = d.models.strong === 'claude' ? 'gpt' : 'claude';
  d.harness = { approval: c.approval, fullLog: c.fullLog, aiLabel: c.aiLabel, review: true, retry: true, toolModes: {}, ...(d.harness || {}) };
  d.harness.review = true;
  d.type = 'harness';
}
function toChatbot(d) {
  d.modelId = d.models?.strong || d.modelId;
  d.models = {};
  d.tools = [];
  d.type = 'chatbot';
}

function setApproval(d, on) {
  if (d.type === 'harness') { d.harness = d.harness || {}; d.harness.approval = on; }
  else d.requireApproval = on;
}

function markDirty() { designer.dirty = true; }

function openDesigner(id) {
  const b = buildById(id);
  if (!b) { location.hash = '#/build'; return; }
  if (!draft || draft.id !== id || !designer.dirty) {
    draft = structuredClone(b);
    draft.docScope = draft.docScope || [];
    draft.chosenSafeguards = draft.chosenSafeguards || [];
    designer.dirty = false;
    designer.sel = 'work';
    designer.testText = '';
  }
  if (currentStatus().retrieval && kb.docs === null) refreshDocs();
  renderDesigner();
}

function saveDesigner() {
  const d = draft;
  if (!d.name.trim()) { toast('Give the agent a name.'); return; }
  if (!d.purpose.trim()) { designer.sel = 'input'; paintDesigner({ sheet: true }); toast('Say what the agent is for. Its risk tier depends on it.'); return; }
  if (!d.id || d._tierStale || !d.tier) { openRiskReview(); return; }
  commitBuild({ ...d });
  toast('Saved');
}

function commitBuild(d, auditExtra = {}) {
  const build = { ...d, safeguards: compileSafeguards(d), id: d.id || uid(), createdAt: d.createdAt || new Date().toISOString() };
  delete build._proposal;
  delete build._tierStale;
  const i = state.builds.findIndex((b) => b.id === build.id);
  const isNew = i < 0;
  if (isNew) state.builds.push(build); else state.builds[i] = build;
  audit({ event: isNew ? 'Build created' : 'Build updated', build: build.name, buildId: build.id, type: build.type, tier: build.tier, model: build.modelId, outcome: auditExtra.outcome || 'saved', actor: 'Admin', detail: auditExtra.detail || `${TYPES[build.type].label} · ${modelsUsed(build).join(', ')}` });
  save();
  draft = structuredClone(build);
  designer.dirty = false;
  if (isNew) location.hash = `#/build/${build.id}`; else paintDesigner();
  return build;
}

// Risk review dialog: a model proposes the tier, a person confirms it.
async function openRiskReview() {
  const d = draft;
  const dlg = $('#dialog');
  const t = d.templateKey && tmpl(d.templateKey);
  const ctx = t?.tierByContext?.[d.usedBy];
  const fromTemplate = t && (d.usedBy === t.usedBy ? { tier: t.tier, basis: t.basis, rationale: t.rationale } : ctx);
  const classifier = d.type === 'chatbot' ? d.modelId : d.models.strong;

  dlg.innerHTML = `<div class="dialog-body"><h2>Risk tier</h2><p class="dim">Asking ${esc(modelById(classifier).name)} to classify <strong>${esc(d.name)}</strong> under the EU AI Act…</p><div class="spinner" aria-hidden="true"></div></div>`;
  dlg.showModal();

  let proposal;
  let error = '';
  if (fromTemplate) {
    proposal = { ...fromTemplate, source: 'Template rule' };
  } else {
    try {
      proposal = { ...(await classify({ ...d, modelId: classifier })), source: `Proposed by ${modelById(classifier).name}` };
    } catch (err) {
      error = err.hint || err.message;
      proposal = { tier: d.tier || 'minimal', basis: d.basis || '', rationale: '', source: 'Set manually' };
    }
  }

  dlg.innerHTML = `
    <form method="dialog" class="dialog-body" id="risk-form">
      <h2>Confirm the risk tier</h2>
      ${error ? `<p class="note note-warn">Automatic classification failed: ${esc(error)} Choose the tier yourself.</p>` : ''}
      <div class="risk-proposal">
        <div class="row between">${tierChip(proposal.tier, proposal.basis)}<span class="tiny dim">${esc(proposal.source)}</span></div>
        ${proposal.rationale ? `<p>${esc(proposal.rationale)}</p>` : ''}
      </div>
      <label class="fld"><span>Confirmed tier</span>
        <select id="r-tier">${Object.entries(TIERS).map(([k, v]) => `<option value="${k}" ${proposal.tier === k ? 'selected' : ''}>${v.label}: ${esc(v.summary)}</option>`).join('')}</select></label>
      <label class="fld"><span>Legal basis</span><input id="r-basis" value="${esc(proposal.basis)}"></label>
      <p class="small dim" id="r-note"></p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-soft" data-action="close-dialog">Back</button>
        <button type="button" class="btn btn-dark" data-action="confirm-save">Confirm and save</button>
      </div>
    </form>`;
  const sync = () => {
    const blocked = $('#r-tier').value === 'prohibited';
    $('[data-action="confirm-save"]').disabled = blocked;
    $('#r-note').textContent = blocked
      ? 'Prohibited practices cannot be deployed under Art. 5, so Berth will not save this agent.'
      : $('#r-tier').value !== proposal.tier ? 'You are overriding the proposed tier. The override is recorded in the audit log.' : '';
  };
  $('#r-tier').addEventListener('change', sync);
  sync();
  draft._proposal = proposal;
  if (proposal.tier === 'prohibited') {
    audit({ event: 'Build refused', build: d.name, type: d.type, tier: 'prohibited', model: classifier, outcome: 'blocked', actor: 'Berth', detail: proposal.rationale });
  }
}

function confirmSave() {
  const d = draft;
  const tier = $('#r-tier').value;
  const basis = $('#r-basis').value.trim();
  const proposal = d._proposal;
  const overridden = tier !== proposal.tier;
  $('#dialog').close();
  commitBuild({
    ...d,
    tier,
    basis,
    rationale: overridden ? `Tier set by a person, overriding the proposed ${TIERS[proposal.tier].label}.` : proposal.rationale,
    tierConfirmedBy: overridden ? 'Admin override' : `Admin confirmed (${proposal.source})`,
  }, { outcome: overridden ? 'tier overridden' : 'tier confirmed', detail: `${basis}${overridden ? ` (proposed ${proposal.tier})` : ''}` });
  toast(`Saved · ${TIERS[tier].label} risk`);
}

function applyUsedBy(d, usedBy) {
  const before = d.tier;
  d.usedBy = usedBy;
  const t = d.templateKey && tmpl(d.templateKey);
  const next = t && (usedBy === t.usedBy ? { tier: t.tier, basis: t.basis, rationale: t.rationale } : t.tierByContext?.[usedBy]);
  if (next) {
    Object.assign(d, next, { tierConfirmedBy: 'Template rule' });
    d._tierStale = false;
    return { changed: before !== d.tier, ruled: true };
  }
  d._tierStale = true;
  return { changed: false, ruled: false };
}

// ---------------------------------------------------------------------------
// Knowledge (Work › Documents): upload, redact, index, search, delete

const kb = { docs: null, error: '', pending: null, busy: '', results: null, query: '', confirmErase: false };

async function refreshDocs() {
  try {
    kb.docs = await docsApi.list();
    kb.error = '';
  } catch (err) {
    kb.error = err.message;
    kb.docs = kb.docs || [];
  }
  if (location.hash.startsWith('#/knowledge')) renderKnowledge();
  else if (location.hash.startsWith('#/build/') && designer.sel === 'work' && $('#sheet')) $('#sheet').innerHTML = sheetFor('work');
}

function workSub(active, id = '') {
  return subnav([['agents', 'Agents', id ? `#/work/${id}` : '#/work'], ['docs', 'Documents', '#/knowledge']], active);
}

function renderKnowledge() {
  const st = currentStatus();
  if (st.retrieval && kb.docs === null) { kb.docs = []; kb.busy = 'Loading documents…'; refreshDocs().then(() => { kb.busy = ''; renderKnowledge(); }); }
  const counts = kb.pending ? summarise(kb.pending.findings) : {};
  shell('work', `
  <div class="page">
    <header class="page-head">
      <h1>Documents</h1>
      <p class="lede">Upload documents for your agents to answer from. Personal data is removed in your browser before anything is indexed, the original never leaves your device, and every answer cites the passages it used.</p>
    </header>
    <div class="facts4">
      <div><span class="eyebrow">Embeddings</span><span>${esc(st.embedding || 'text-embedding-3-small')} · 512 dimensions</span></div>
      <div><span class="eyebrow">Stored in</span><span>${esc(st.storage || 'Supabase pgvector')}</span></div>
      <div><span class="eyebrow">Isolation</span><span>Row-level security per visitor</span></div>
      <div><span class="eyebrow">Erasure</span><span>One click, logged</span></div>
    </div>
    ${st.retrieval ? '' : '<div class="note note-info">Document search runs on the hosted Berth demo. This copy has no retrieval service configured, so uploads are switched off.</div>'}
    ${kb.error ? `<div class="note note-warn">${esc(kb.error)}</div>` : ''}

    <section class="two-col">
      <div class="panel">
        <h2 class="panel-h">Add a document</h2>
        ${kb.pending ? `
          <div class="stack">
            <div class="row between wrap"><strong>${esc(kb.pending.name)}</strong><span class="tiny dim">${kb.pending.text.length.toLocaleString()} characters</span></div>
            <div class="redact-note">${ICON.shield} ${kb.pending.findings.length ? `${esc(describeCounts(counts))} will be removed before indexing` : 'No personal data found'}</div>
            <div class="kb-preview">${highlightTokens(kb.pending.redacted.slice(0, 900))}${kb.pending.redacted.length > 900 ? '…' : ''}</div>
            <div class="row gap8">
              <button type="button" class="btn btn-dark" data-action="kb-index" ${kb.busy ? 'disabled' : ''}>${kb.busy ? esc(kb.busy) : 'Index document'}</button>
              <button type="button" class="btn btn-soft" data-action="kb-cancel">Cancel</button>
            </div>
          </div>` : `
          <label class="drop" for="kb-file">
            <strong>Choose a file</strong>
            <span class="small dim">PDF, Word, text, Markdown, CSV or JSON · up to 150,000 characters</span>
            <input id="kb-file" type="file" accept="${ACCEPT_TYPES}" ${st.retrieval ? '' : 'disabled'}>
          </label>
          <details class="fld-more"><summary>Or paste text</summary>
            <label class="fld"><span>Name</span><input id="kb-name" placeholder="e.g. Leave policy"></label>
            <label class="fld"><span>Text</span><textarea id="kb-text" rows="5"></textarea></label>
            <button type="button" class="btn btn-soft btn-sm" data-action="kb-paste" ${st.retrieval ? '' : 'disabled'}>Preview redaction</button>
          </details>`}
      </div>
      <div class="panel">
        <h2 class="panel-h">Test a search</h2>
        <form id="kb-search-form" class="row gap8">
          <label for="kb-q" class="sr-only">Question</label>
          <input id="kb-q" value="${esc(kb.query)}" placeholder="e.g. What is the hotel limit in Sydney?" ${st.retrieval ? '' : 'disabled'}>
          <button type="submit" class="btn btn-soft" ${st.retrieval ? '' : 'disabled'}>Search</button>
        </form>
        ${kb.results ? (kb.results.length ? `<ol class="kb-results">${kb.results.map((r) => `
          <li><div class="row between"><strong class="small">${esc(shortDoc(r.document_name))}</strong><span class="tiny dim">passage ${r.idx + 1} · ${Math.round(r.similarity * 100)}% match</span></div>
          <p class="small">${highlightTokens(r.content.slice(0, 320))}${r.content.length > 320 ? '…' : ''}</p></li>`).join('')}</ol>` : '<p class="small dim">No passages found.</p>') : '<p class="small dim">Runs the same vector search your agents use, over your documents and the Meridian Bank samples.</p>'}
      </div>
    </section>

    <section class="stack">
      <div class="row between wrap">
        <h2 class="sec-title sm">Library</h2>
        ${kb.docs?.some((d) => !d.sample) ? (kb.confirmErase
          ? '<span class="row gap8"><span class="small">Delete all your documents and their records?</span><button type="button" class="btn btn-danger btn-sm" data-action="kb-erase">Delete everything</button><button type="button" class="btn btn-soft btn-sm" data-action="kb-erase-cancel">Keep</button></span>'
          : '<button type="button" class="btn btn-soft btn-sm" data-action="kb-erase-ask">Delete all my data</button>') : ''}
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Document</th><th>Chunks</th><th>Characters</th><th>Removed before indexing</th><th>Added</th><th></th></tr></thead>
          <tbody>${kb.docs === null || (kb.busy && !kb.docs.length) ? '<tr><td colspan="6" class="dim">Loading…</td></tr>'
            : kb.docs.length ? kb.docs.map((d) => `
            <tr>
              <td>${esc(d.name)} ${d.sample ? '<span class="soft-tag">Sample · shared</span>' : '<span class="soft-tag">Yours · private</span>'}</td>
              <td class="mono">${d.chunk_count}</td><td class="mono">${Number(d.chars).toLocaleString()}</td>
              <td class="small">${esc(describeCounts(d.redactions || {}) || 'none')}</td>
              <td class="mono small nowrap">${new Date(d.created_at).toLocaleDateString()}</td>
              <td>${d.sample ? '' : `<button type="button" class="link-btn" data-action="kb-delete" data-id="${esc(d.id)}">Delete</button>`}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="dim">No documents yet.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="small dim">Sample documents are the policies of Meridian Bank, a fictional bank, shared read-only with every visitor. Your own documents are visible only to this browser.</p>
    </section>
  </div>`, { sub: workSub('docs') });
}

async function stageDocument(name, text) {
  const clean = String(text || '').trim();
  if (!clean) { toast('That file has no readable text.'); return; }
  const { text: redacted, findings } = redact(clean);
  kb.pending = { name, text: clean, redacted, findings };
  renderKnowledge();
}

// ---------------------------------------------------------------------------
// Work: use agents, see the time and money saved

const run = { controller: null, busy: false };
const ui = { listOpen: true, sheetOpen: false };

function chatOf(key) {
  if (!state.chats[key]) state.chats[key] = [];
  return state.chats[key];
}

function extrasFor(build) {
  const c = controlsFor(build);
  return { extra: c.extraRedaction || [], terms: build.protectedTerms || [] };
}

function systemPrompt(build) {
  const parts = [build.instructions || 'You are a helpful assistant.'];
  if (build.type === 'chatbot' && build.knowledge) parts.push(`Reference text:\n"""\n${build.knowledge}\n"""`);
  parts.push('Personal details in messages may appear as placeholders such as [EMAIL_1] or [NAME_1]. Keep placeholders exactly as written and never try to guess the original values.');
  return parts.join('\n\n');
}

/** Minutes a person saves when the agent drafts the work and they check it. */
function minutesSavedFor(build) {
  const c = controlsFor(build);
  const check = c.approval ? 3 : 1;
  return Math.max(0, (build.minutesManual || 10) - check);
}

function statsFor(id) {
  const s = { answers: 0, minutes: 0, cost: 0, baseline: 0 };
  for (const [key, chat] of chatEntries()) {
    if (id && key !== id) continue;
    for (const m of chat) {
      if (m.role !== 'assistant' || !['ok', 'held', 'approved'].includes(m.status)) continue;
      s.answers += 1;
      s.minutes += m.minutesSaved || 0;
      s.cost += m.cost || 0;
      s.baseline += m.baseline || m.cost || 0;
    }
  }
  return s;
}

function messageHtml(msg, i, build, isLast) {
  if (msg.role === 'user') {
    const counts = summarise(msg.findings || []);
    return `
    <div class="msg msg-user">
      ${msg.findings?.length ? `<div class="redact-note">${ICON.shield} ${esc(describeCounts(counts))} removed before sending</div>` : ''}
      <div class="bubble">${highlightTokens(msg.sent ?? msg.content)}</div>
    </div>`;
  }
  if (msg.role === 'system') {
    return `<div class="msg msg-system status-${msg.status}"><div class="sys-card">${msg.status === 'stopped' ? ICON.alert : ICON.shield}<div>${esc(msg.content)}</div></div></div>`;
  }
  const c = controlsFor(build);
  const held = msg.status === 'held';
  const worker = [...(msg.stages || [])].reverse().find((st) => st.role === 'fast' || st.role === 'strong' || st.role === 'model');
  const m = modelById(worker?.modelId || msg.modelId || build.modelId);
  return `
  <div class="msg msg-assistant ${held ? 'is-held' : ''} ${msg.status === 'rejected' ? 'is-rejected' : ''}" data-index="${i}">
    <div class="msg-meta"><strong>${esc(build.name)}</strong> · ${esc(m?.name || '')} ${msg.at ? `· ${new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
      ${c.aiLabel && msg.status !== 'streaming' ? '<span class="ai-label">AI-generated</span>' : ''}</div>
    ${msg.stages?.length > 1 ? stageStrip(msg.stages) : ''}
    ${msg.steps?.length ? `<div class="steps">${msg.steps.map((s) => `<div class="step-line"><span class="mono tiny">${esc(s.name)}</span> ${esc(s.summary || '')}</div>`).join('')}</div>` : ''}
    <div class="answer">${msg.content ? renderMarkdown(msg.content) : '<span class="thinking">Thinking…</span>'}</div>
    ${msg.sources?.length && msg.status !== 'streaming' ? `<details class="sources"><summary class="small">${msg.sources.length} source${msg.sources.length > 1 ? 's' : ''} used</summary><ol>${msg.sources.map((x) => `<li><span class="small"><strong>${esc(shortDoc(x.document_name))}</strong> <span class="tiny dim">passage ${x.idx + 1} · ${Math.round(x.similarity * 100)}%</span></span><span class="small dim">${esc(x.content.slice(0, 220))}${x.content.length > 220 ? '…' : ''}</span></li>`).join('')}</ol></details>` : ''}
    ${msg.review?.issues?.length ? `<div class="review ${msg.review.verdict === 'pass' ? 'review-pass' : ''}"><span class="tiny">REVIEWER · ${esc(modelById(build.models?.reviewer)?.name || '')}</span><ul>${msg.review.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${msg.notes?.length ? `<div class="notes">${msg.notes.map((n) => `<div class="note note-${n.level}">${esc(n.text)}</div>`).join('')}</div>` : ''}
    ${held ? `
      <div class="hold-bar" role="status">
        ${ICON.clock}<span><strong>Held for ${esc(approverOf(build).toLowerCase())} approval.</strong> Copy unlocks after approval.</span>
        <button type="button" class="btn btn-sm btn-danger-soft" data-action="reject" data-build="${build.id}" data-index="${i}">Reject</button>
        <button type="button" class="btn btn-sm btn-dark" data-action="approve" data-build="${build.id}" data-index="${i}">Approve</button>
      </div>` : ''}
    ${msg.status === 'approved' ? `<div class="tiny ok">Approved by ${esc(approverOf(build).toLowerCase())}</div>` : ''}
    ${msg.status === 'rejected' ? '<div class="tiny danger">Rejected. Not for use.</div>' : ''}
    ${msg.status === 'error' ? `<div class="note note-block">${esc(msg.error)}</div>` : ''}
    ${msg.status !== 'streaming' ? `<div class="msg-actions">
      <button type="button" class="link-btn" data-action="copy" data-index="${i}" ${held || msg.status === 'rejected' ? 'disabled' : ''}>Copy</button>
      ${isLast ? '<button type="button" class="link-btn" data-action="regenerate">Regenerate</button>' : ''}
      ${msg.auditSeq ? `<span class="tiny dim">Log #${String(msg.auditSeq).padStart(4, '0')}</span>` : ''}
      ${msg.cost != null ? `<span class="tiny metrics">${metricsHtml(msg)}</span>` : ''}
    </div>` : ''}
  </div>`;
}

function stageStrip(stages) {
  return `<div class="stages">${stages.map((st, i) => `
    ${i ? '<span class="stage-link" aria-hidden="true"></span>' : ''}
    <span class="stage stage-${st.role} ${st.status === 'running' ? 'is-running' : ''}">
      <span class="stage-top"><span class="stage-k">${esc(st.stage)}</span><strong>${esc(st.label || modelById(st.modelId)?.name || '')}</strong></span>
      <span class="tiny dim">${st.status === 'running' ? 'working…' : esc(st.note || (st.usage ? `${(st.usage.in + st.usage.out).toLocaleString()} tok` : ''))}${st.cost ? ` · ${formatCost(st.cost)}` : ''}</span>
    </span>`).join('')}</div>`;
}

function controlsSheet(build) {
  const tierOrder = ['minimal', 'limited', 'high', 'prohibited'];
  const trail = state.audit.filter((a) => a.buildId === build.id || a.build === build.name).slice(0, 6);
  return `
    <div class="gsheet-head"><span class="eyebrow">Governance for this agent</span><button type="button" class="icon-btn" data-action="toggle-sheet" aria-label="Close">${ICON.close}</button></div>
    <div class="tier-card">
      <div class="row between"><span class="tier-name">${esc(TIERS[build.tier].label)} risk</span><span class="tiny">${esc(build.tierConfirmedBy || '')}</span></div>
      <p>${esc(build.basis || TIERS[build.tier].summary)}</p>
      ${build.rationale ? `<p class="tier-why">${esc(build.rationale)}</p>` : ''}
      <div class="scale">${tierOrder.map((t) => `<span class="${t === build.tier ? `on on-${t}` : ''}"></span>`).join('')}</div>
      <div class="scale-labels">${tierOrder.map((t) => `<span class="${t === build.tier ? 'cur' : ''}">${TIERS[t].label}</span>`).join('')}</div>
    </div>
    <div class="ctrl-list">
      <div class="h-sub">Controls in force</div>
      ${describeControls(build).map((c) => `
        <div class="ctrl ${c.on ? '' : 'is-off'}">${c.on ? ICON.check : ICON.dash}<span>${esc(c.title)}<small>${esc(c.detail)}</small></span></div>`).join('')}
    </div>
    <div class="trail">
      <div class="row between"><span class="h-sub">Audit trail</span><a class="small text-link" href="#/govern/audit">Full log</a></div>
      ${trail.length ? trail.map((a) => `<div class="trail-row"><span class="tiny dim">${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="small">${esc(a.event)}${a.outcome ? ` · ${esc(a.outcome)}` : ''}</span></div>`).join('') : '<p class="small dim">No activity yet.</p>'}
    </div>`;
}

function renderWork(id) {
  const build = buildById(id) || state.builds[0];
  if (!build) { location.hash = '#/build'; return; }
  if (build.id !== id) { history.replaceState(null, '', `#/work/${build.id}`); }
  const chat = chatOf(build.id);
  const s = statsFor(build.id);
  const all = statsFor(null);
  const lastAssistant = chat.map((x) => x.role).lastIndexOf('assistant');
  const t = build.templateKey && tmpl(build.templateKey);

  shell('work', `
  <div class="work ${ui.listOpen ? '' : 'list-closed'} ${ui.sheetOpen ? 'sheet-open' : ''}">
    <aside class="agent-list" aria-label="Agents">
      <div class="al-head"><span class="eyebrow">Agents</span><button type="button" class="icon-btn" data-action="toggle-list" aria-label="Collapse list">${ICON.panel}</button></div>
      <div class="al-items">
        ${state.builds.map((b) => `<a class="al-item ${b.id === build.id ? 'is-on' : ''}" href="#/work/${b.id}"><span class="dot dot-${b.tier}"></span><span class="al-name">${esc(b.name)}</span><span class="al-type">${esc(TYPES[b.type].label)}</span></a>`).join('')}
      </div>
      <div class="al-total">
        <span class="eyebrow">All agents so far</span>
        <span class="big">${minutesLabel(all.minutes)}</span><span class="small dim">saved across ${all.answers} answer${all.answers === 1 ? '' : 's'}</span>
      </div>
      <a class="btn btn-soft btn-sm" href="#/build">${ICON.plus} New agent</a>
    </aside>

    <section class="chatpane">
      <header class="chat-head">
        ${ui.listOpen ? '' : `<button type="button" class="icon-btn" data-action="toggle-list" aria-label="Show agents">${ICON.panel}</button>`}
        <div class="chat-title"><h1>${esc(build.name)}</h1><span class="small dim">${esc(industryOf(build))} · ${esc(TYPES[build.type].label)} · ${modelsUsed(build).map((x) => esc(modelById(x).name)).join(', ')}</span></div>
        ${tierChip(build.tier, build.basis?.split('·')[0]?.trim())}
        <label class="inline-select"><span class="tiny dim">Used by</span>
          <select id="run-usedby">${USED_BY.map((u) => `<option ${build.usedBy === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
        <a class="btn btn-soft btn-sm" href="#/build/${build.id}">Design</a>
        <button type="button" class="btn btn-soft btn-sm ${ui.sheetOpen ? 'is-on' : ''}" data-action="toggle-sheet">${ICON.shield} Controls</button>
      </header>
      <div class="prod-bar">
        <span><b>${s.answers}</b> answer${s.answers === 1 ? '' : 's'}</span>
        <span class="good"><b>${minutesLabel(s.minutes)}</b> saved</span>
        <span><b>${formatCost(s.cost)}</b> spent</span>
        ${s.baseline > s.cost * 1.05 ? `<span class="good"><b>${Math.round((1 - s.cost / s.baseline) * 100)}%</b> cheaper than one large model</span>` : ''}
        <span class="dim">Estimate: ${build.minutesManual || 10} min of manual work per task</span>
      </div>
      <div class="messages" id="messages">
        ${chat.length ? chat.map((msg, i) => messageHtml(msg, i, build, i === lastAssistant)).join('') : `
          <div class="empty">
            <span class="eyebrow">${esc(industryOf(build))}</span>
            <h2>${esc(build.name)}</h2>
            <p class="dim">${esc(build.purpose || '')}</p>
            <div class="starters">${(build.starters || []).map((x) => `<button type="button" class="starter" data-action="starter">${esc(x)}</button>`).join('')}</div>
            ${t?.tierByContext ? `<p class="hint">Try changing <strong>Used by</strong> to <em>${esc(Object.keys(t.tierByContext)[0])}</em> and watch the risk tier change.</p>` : ''}
          </div>`}
        <div id="tool-approval"></div>
      </div>
      <div class="composer-wrap">
        <form class="composer" id="composer">
          <label for="prompt" class="sr-only">Message</label>
          <textarea id="prompt" rows="2" placeholder="Message ${esc(build.name)}…"></textarea>
          <div class="composer-row">
            <span class="small preview" id="preview">${ICON.shield} Personal data is removed before sending</span>
            ${run.busy ? '<button type="button" class="btn btn-sm btn-soft" data-action="stop">Stop</button>' : ''}
            <button type="submit" class="send" aria-label="Send" ${run.busy ? 'disabled' : ''}>${ICON.arrow}</button>
          </div>
        </form>
        <div class="composer-foot tiny dim">${modelsUsed(build).every(hasKey) ? 'Runs on the live demo keys' : '<a href="#/govern/settings">Add missing API keys</a>'} · logged to the audit trail</div>
      </div>
    </section>

    <aside class="gsheet" aria-label="Governance">${controlsSheet(build)}</aside>
  </div>`, { sub: workSub('agents', build.id), cls: 'view-work' });

  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
  if (window.matchMedia('(min-width: 900px)').matches) $('#prompt')?.focus();
}

function refreshMessages(build) {
  const chat = chatOf(build.id);
  const lastAssistant = chat.map((x) => x.role).lastIndexOf('assistant');
  const box = $('#messages');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.innerHTML = chat.map((msg, i) => messageHtml(msg, i, build, i === lastAssistant)).join('') + '<div id="tool-approval"></div>';
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function updatePreview(build) {
  const text = $('#prompt').value;
  const el = $('#preview');
  if (!text.trim()) { el.innerHTML = `${ICON.shield} Personal data is removed before sending`; el.className = 'small preview'; return; }
  const policy = checkPolicy(text, build.modelId);
  if (!policy.ok) { el.innerHTML = `${ICON.alert} ${esc(policy.reason)}`; el.className = 'small preview is-block'; return; }
  const { findings } = redact(text, extrasFor(build));
  el.innerHTML = findings.length
    ? `${ICON.shield} ${esc(describeCounts(summarise(findings)))} will be removed before sending`
    : `${ICON.shield} Nothing to remove`;
  el.className = `small preview ${findings.length ? 'is-active' : ''}`;
}

function askToolPermission(build, call) {
  return new Promise((resolveP, rejectP) => {
    const el = $('#tool-approval');
    const [key, tool] = toolByFunctionName(call.name) || [];
    el.innerHTML = `
      <div class="tool-ask" role="alertdialog" aria-label="Tool permission">
        ${ICON.shield}<span><strong>${esc(build.name)} wants to use ${esc(tool?.label || call.name)}.</strong><br><span class="mono tiny">${esc(JSON.stringify(call.args))}</span></span>
        <button type="button" class="btn btn-sm btn-soft" data-tool-answer="deny">Deny</button>
        <button type="button" class="btn btn-sm btn-dark" data-tool-answer="allow">Allow</button>
      </div>`;
    el.querySelectorAll('[data-tool-answer]').forEach((b) => b.addEventListener('click', () => {
      el.innerHTML = '';
      const allowed = b.dataset.toolAnswer === 'allow';
      audit({ event: 'Tool permission', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: allowed ? 'allowed' : 'denied', actor: 'User', detail: `${key}: ${JSON.stringify(call.args)}` });
      if (allowed) resolveP(); else rejectP(new Error('The user denied permission for this tool call.'));
    }));
  });
}

function workView(build) {
  return {
    render: () => { if (location.hash.startsWith(`#/work/${build.id}`)) renderWork(build.id); },
    refresh: () => refreshMessages(build),
    paint: (reply, chat) => {
      const el = document.querySelector(`.msg-assistant[data-index="${chat.indexOf(reply)}"] .answer`);
      if (el) el.innerHTML = reply.content ? renderMarkdown(reply.content) : '<span class="thinking">Thinking…</span>';
      const box = $('#messages'); if (box) box.scrollTop = box.scrollHeight;
    },
  };
}

const testView = {
  render: () => { const el = $('#test-out'); if (el) el.innerHTML = testOutHtml(); const btn = $('#test-form button'); if (btn) btn.disabled = run.busy; },
  refresh: () => { const el = $('#test-out'); if (el) el.innerHTML = testOutHtml(); },
  paint: () => { const el = $('#test-out .test-answer'); const chat = state.chats[testKey()] || []; const r = chat[chat.length - 1]; if (el && r) el.innerHTML = r.content ? renderMarkdown(r.content) : '<span class="thinking">Working…</span>'; },
};

async function send(build, text, { regenerate = false, key = build.id, view = workView(build) } = {}) {
  if (run.busy) return;
  const chat = chatOf(key);
  const c = controlsFor(build);
  const isTest = key.startsWith('test:');

  if (!regenerate) {
    const blockedModel = modelsUsed(build).find((id) => !state.policy.allowedModels.includes(id));
    const policy = checkPolicy(text, blockedModel || build.modelId);
    if (!policy.ok) {
      chat.push({ role: 'system', status: 'blocked', content: `Not sent. ${policy.reason}` });
      audit({ event: 'Message blocked', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: 'blocked by policy', actor: 'Berth', detail: policy.reason });
      save(); view.refresh(); return;
    }
    const guard = preSend(text, c);
    if (guard.stop) {
      chat.push({ role: 'system', status: 'stopped', content: guard.message });
      audit({ event: 'Emergency stop', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: 'not sent', actor: 'Berth', detail: guard.reason });
      save(); view.refresh(); return;
    }
    const { text: sent, findings } = redact(text, extrasFor(build));
    // Only the redacted text is kept. The original never leaves the composer.
    chat.push({ role: 'user', sent, findings: findings.map(({ type, token }) => ({ type, token })), at: new Date().toISOString() });
  }

  const history = (isTest ? chat.slice(-1) : chat)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.status !== 'error' && m.status !== 'rejected')
    .map((m) => ({ role: m.role, content: m.role === 'user' ? m.sent : m.content }));
  const lastUser = [...chat].reverse().find((m) => m.role === 'user');

  const reply = { role: 'assistant', content: '', status: 'streaming', modelId: build.modelId, at: new Date().toISOString(), steps: [] };
  chat.push(reply);
  run.busy = true;
  run.controller = new AbortController();
  view.render();

  const docsOn = build.useDocs && currentStatus().retrieval;
  const scope = build.docScope?.length ? build.docScope : null;
  // With document search on, it replaces the inline knowledge text (kept as the offline fallback).
  const toolNames = build.type === 'chatbot' ? [] : [...new Set([...(build.tools || []).filter((k) => !(docsOn && k === 'knowledge' && scope)), ...(docsOn ? ['documents'] : [])])]
    .filter((k) => build.harness?.toolModes?.[k] !== 'off');
  reply.sources = [];
  const retrieve = async (q) => {
    const r = await docsApi.search(q, 5, { names: scope });
    reply.sources.push(...r);
    return r;
  };
  const scoped = { ...build, docScope: scope };
  let result;
  let pending = 0;
  const paint = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; view.paint(reply, chat); });
  };
  try {
    result = await execute(build, {
      system: systemPrompt(build),
      history,
      tools: toolDefs(toolNames),
      rulesText: describeControls(build).filter((x) => x.on).map((x) => `- ${x.title}: ${x.detail}`).join('\n'),
      signal: run.controller.signal,
      retrieve: docsOn ? retrieve : null,
      onText: (t) => { reply.content = t; paint(); },
      onStage: (stages) => { reply.stages = stages.map((st) => ({ ...st })); view.refresh(); },
      onToolCall: async (call) => {
        const [tk, tool] = toolByFunctionName(call.name) || [];
        if (!tool || !toolNames.includes(tk)) throw new Error(`Tool ${call.name} is not available to this agent.`);
        if (build.type === 'harness' && build.harness?.toolModes?.[tk] === 'ask') await askToolPermission(build, call);
        const out = await tool.run(call.args || {}, scoped, {
          sourceCount: () => reply.sources.length,
          onSources: (r) => { reply.sources.push(...r); },
        });
        reply.steps.push({ name: tool.label, summary: tool.describe(call.args || {}, out) });
        view.refresh();
        return out;
      },
    });
    reply.content = result.text || '(No answer returned.)';
    reply.stages = result.stages;
    reply.review = result.review;
    reply.cost = result.cost;
    reply.baseline = result.baseline;
    reply.estimated = result.estimated;
    reply.notes = checkOutput(reply.content, c);
    if (result.review?.verdict === 'revise') reply.notes.push({ level: 'block', text: 'The reviewer still found issues after one revision. Check them before approving.' });
    if (result.stepLimitHit) reply.notes.push({ level: 'warn', text: `Step limit of ${build.maxSteps} reached. The answer may be incomplete.` });
    reply.status = c.approval ? 'held' : 'ok';
    reply.minutesSaved = minutesSavedFor(build);
  } catch (err) {
    if (err.name === 'AbortError') {
      reply.status = reply.content ? 'ok' : 'error';
      reply.error = 'Stopped.';
    } else {
      reply.status = 'error';
      reply.error = `${err.message}${err.hint ? ` ${err.hint}` : ''}`;
    }
  }

  const stages = reply.stages || [];
  const tokensIn = stages.reduce((n, st) => n + (st.usage?.in || 0), 0) || estimateTokens(systemPrompt(build) + history.map((h) => h.content).join(' '));
  const tokensOut = stages.reduce((n, st) => n + (st.usage?.out || 0), 0) || estimateTokens(reply.content);
  reply.tokens = tokensIn + tokensOut;
  const rec = audit({
    event: isTest ? 'Test run' : regenerate ? 'Answer regenerated' : 'Message sent',
    buildId: build.id,
    build: build.name,
    type: build.type,
    tier: build.tier,
    model: stages.length ? stages.map((st) => `${st.stage}:${st.modelId || st.label}`).join(' > ') : build.modelId,
    outcome: reply.status === 'error' ? 'error' : reply.status === 'held' ? 'held for approval' : 'sent',
    redactions: describeCounts(summarise(lastUser?.findings || [])) || 'none',
    tokensIn,
    tokensOut,
    cost: reply.cost != null ? Number(reply.cost.toFixed(6)) : '',
    actor: 'User',
    detail: [
      stages.find((st) => st.stage === 'Triage')?.note ? `route: ${stages.find((st) => st.stage === 'Triage').note}` : '',
      result?.review ? `review: ${result.review.verdict}${result.review.issues.length ? ` (${result.review.issues.join('; ')})` : ''}` : '',
      reply.steps.length ? `tools: ${reply.steps.map((st) => st.name).join(', ')}` : '',
      reply.sources?.length ? `sources: ${reply.sources.map((x, i) => `S${i + 1} ${x.document_name} #${x.idx + 1}`).join('; ')}` : '',
      reply.notes?.length ? `checks: ${reply.notes.map((n) => n.text).join(' | ')}` : '',
      reply.error || '',
      c.fullLog ? `prompt: ${lastUser?.sent || ''} || answer: ${reply.content}` : '',
    ].filter(Boolean).join(' · '),
  });
  reply.auditSeq = rec.seq;
  run.busy = false;
  run.controller = null;
  save();
  view.render();
}

function review(buildId, index, approved) {
  const build = buildById(buildId);
  const msg = build && chatOf(build.id)[index];
  if (!msg) return;
  msg.status = approved ? 'approved' : 'rejected';
  audit({ event: approved ? 'Answer approved' : 'Answer rejected', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: msg.status, actor: approverOf(build), detail: `Log #${msg.auditSeq}` });
  save();
  route();
}

function changeUsedBy(build, usedBy) {
  const before = build.tier;
  const r = applyUsedBy(build, usedBy);
  if (r.ruled) {
    audit({ event: 'Deployment context changed', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: before === build.tier ? 'tier unchanged' : `tier ${before} → ${build.tier}`, actor: 'Admin', detail: `Used by: ${usedBy}` });
    delete build._tierStale;
    save();
    route();
    if (before !== build.tier) toast(`Risk tier changed to ${TIERS[build.tier].label}. Controls updated.`);
  } else {
    save();
    draft = structuredClone(build);
    designer.dirty = true;
    location.hash = `#/build/${build.id}`;
    setTimeout(openRiskReview, 50);
  }
}

// ---------------------------------------------------------------------------
// Comply: risk register and evidence packs

function renderComply() {
  const builds = state.builds;
  const count = (t) => builds.filter((b) => b.tier === t).length;
  shell('comply', `
  <div class="page">
    <header class="page-head">
      <h1>Comply</h1>
      <p class="lede">Every agent is classified under the EU AI Act by what it does and who uses it. The tier switches the required controls on, and each agent has an evidence pack for an auditor or regulator.</p>
    </header>
    <div class="tier-tiles">
      ${['minimal', 'limited', 'high', 'prohibited'].map((t) => `<div class="tt tt-${t}"><span class="tt-n">${count(t)}</span><span class="tt-l">${esc(TIERS[t].label)} risk</span><span class="tt-s">${esc(TIERS[t].summary)}</span></div>`).join('')}
    </div>
    <section class="stack">
      <h2 class="sec-title sm">Risk register</h2>
      ${builds.map((b) => {
        const ctrls = describeControls(b);
        const t = b.templateKey && tmpl(b.templateKey);
        return `
        <article class="reg-card">
          <div class="reg-main">
            <span class="ex-top"><span class="ex-ind">${esc(industryOf(b))} · ${esc(TYPES[b.type].label)}</span>${tierChip(b.tier)}</span>
            <h3>${esc(b.name)}</h3>
            <p class="small">${esc(b.purpose || '')}</p>
            <dl class="reg-facts">
              <div><dt>Legal basis</dt><dd>${esc(b.basis || '—')}</dd></div>
              <div><dt>Decided by</dt><dd>${esc(b.tierConfirmedBy || '—')}</dd></div>
              <div><dt>Used by</dt><dd><select data-usedby="${b.id}" aria-label="Used by">${USED_BY.map((u) => `<option ${b.usedBy === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></dd></div>
            </dl>
            ${b.rationale ? `<p class="small dim">${esc(b.rationale)}</p>` : ''}
            ${t?.tierByContext ? `<p class="hint small">Change <strong>Used by</strong> to <em>${esc(Object.keys(t.tierByContext)[0])}</em>: the same agent becomes ${esc(TIERS[Object.values(t.tierByContext)[0].tier].label.toLowerCase())} risk, because the Act classifies by use.</p>` : ''}
          </div>
          <div class="reg-ctrls">
            <span class="h-sub">Controls</span>
            ${ctrls.map((c) => `<div class="ctrl ${c.on ? '' : 'is-off'}">${c.on ? ICON.check : ICON.dash}<span>${esc(c.title)}</span></div>`).join('')}
            <div class="reg-actions">
              <button type="button" class="btn btn-dark btn-sm" data-action="evidence" data-id="${b.id}">${ICON.doc} Evidence pack</button>
              <a class="btn btn-soft btn-sm" href="#/build/${b.id}">Design</a>
            </div>
          </div>
        </article>`;
      }).join('')}
    </section>
  </div>`);
}

function evidencePack(b) {
  const rows = state.audit.filter((a) => a.buildId === b.id || a.build === b.name);
  const c = describeControls(b);
  const s = statsFor(b.id);
  const date = new Date().toISOString().slice(0, 10);
  const line = (r) => `| ${String(r.seq).padStart(4, '0')} | ${new Date(r.at).toISOString().replace('T', ' ').slice(0, 16)} | ${r.event} | ${r.outcome || ''} | ${r.redactions || ''} | ${r.model || ''} |`;
  return `# Evidence pack: ${b.name}

Generated by Berth on ${date}. Meridian Bank is a fictional organisation used for demonstration.

## 1. Intended purpose and deployment
- **Purpose:** ${b.purpose || 'not stated'}
- **Used by:** ${b.usedBy}
- **Build type:** ${TYPES[b.type].label}
- **Human approver:** ${controlsFor(b).approval ? approverOf(b) : 'not required'}

## 2. Risk classification (EU AI Act)
- **Tier:** ${TIERS[b.tier].label}
- **Legal basis:** ${b.basis || 'not recorded'}
- **Rationale:** ${b.rationale || 'not recorded'}
- **Decided by:** ${b.tierConfirmedBy || 'not recorded'}

## 3. Models and roles
${b.type === 'chatbot' ? `- Model: ${modelById(b.modelId).name} (${provenance(modelById(b.modelId))})` : rolesFor(b.type).map((r) => `- ${ROLES[r].label}: ${modelById(b.models[r]).name} (${provenance(modelById(b.models[r]))})`).join('\n')}

## 4. Controls in force
${c.map((x) => `- [${x.on ? 'x' : ' '}] **${x.title}**: ${x.detail}`).join('\n')}

## 5. Data and sources
- Personal data redaction runs in the browser before any request is sent.
- Documents: ${b.useDocs ? (b.docScope?.length ? b.docScope.join('; ') : 'all workspace documents') : 'none'}

## 6. Use and outcomes
- Answers: ${s.answers}
- Estimated time saved: ${minutesLabel(s.minutes)}
- Model spend: ${formatCost(s.cost)}

## 7. Audit records (${rows.length})
| # | Time (UTC) | Event | Outcome | Redactions | Models |
|---|---|---|---|---|---|
${rows.slice(0, 200).map(line).join('\n') || '| | | No records yet | | | |'}
`;
}

// ---------------------------------------------------------------------------
// Govern: approvals, audit log, policy, settings

function governSub(active) {
  return subnav([
    ['approvals', 'Approvals', '#/govern', heldItems().length],
    ['audit', 'Audit log', '#/govern/audit'],
    ['policy', 'Policy', '#/govern/policy'],
    ['settings', 'Settings & keys', '#/govern/settings'],
  ], active);
}

function renderApprovals() {
  const items = heldItems();
  shell('govern', `
  <div class="page">
    <header class="page-head">
      <h1>Approvals</h1>
      <p class="lede">Answers from high-risk agents wait here until the right person signs off. Every decision is recorded in the audit log.</p>
    </header>
    ${items.length ? `<div class="stack">${items.map(({ build, msg, index, chat }) => {
      const q = [...chat.slice(0, index)].reverse().find((m) => m.role === 'user');
      return `
      <article class="appr">
        <div class="appr-top"><span class="ex-ind">${esc(build.name)}</span>${tierChip(build.tier)}<span class="tiny dim">${new Date(msg.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })} · waiting for ${esc(approverOf(build).toLowerCase())}</span></div>
        ${q ? `<div class="appr-q">${highlightTokens(q.sent || '')}</div>` : ''}
        <div class="appr-a answer">${renderMarkdown(msg.content.slice(0, 900))}${msg.content.length > 900 ? '…' : ''}</div>
        <div class="appr-actions">
          ${msg.cost != null ? `<span class="tiny metrics">${metricsHtml(msg)}</span>` : ''}
          <a class="btn btn-soft btn-sm" href="#/work/${build.id}">Open</a>
          <button type="button" class="btn btn-danger-soft btn-sm" data-action="reject" data-build="${build.id}" data-index="${index}">Reject</button>
          <button type="button" class="btn btn-dark btn-sm" data-action="approve" data-build="${build.id}" data-index="${index}">Approve</button>
        </div>
      </article>`;
    }).join('')}</div>` : `<div class="empty-card">${ICON.check}<div><b>Nothing waiting.</b><span>Ask a high-risk agent, such as the Loan Eligibility Checker, a question in Work. Its answer will wait here for approval.</span></div></div>`}
  </div>`, { sub: governSub('approvals') });
}

function renderAudit() {
  const rows = state.audit;
  shell('govern', `
  <div class="page wide">
    <header class="page-head row between wrap">
      <div><h1>Audit log</h1><p class="lede">Every request, block, approval and tier decision. Prompt text is kept only where full record-keeping is on.</p></div>
      <div class="row gap8">
        <button type="button" class="btn btn-soft" data-action="export-csv" ${rows.length ? '' : 'disabled'}>Export CSV</button>
        <button type="button" class="btn btn-soft" data-action="export-json" ${rows.length ? '' : 'disabled'}>Export JSON</button>
      </div>
    </header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>#</th><th>Time</th><th>Event</th><th>Agent</th><th>Tier</th><th>Models</th><th>Outcome</th><th>Redactions</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr title="${esc(r.detail || '')}">
            <td class="mono">${String(r.seq).padStart(4, '0')}</td>
            <td class="mono nowrap">${new Date(r.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${esc(r.event)}</td><td>${esc(r.build || '')}</td>
            <td>${r.tier ? `<span class="dot dot-${r.tier}"></span> ${esc(TIERS[r.tier]?.label || r.tier)}` : ''}</td>
            <td class="mono small">${esc(r.model || '')}</td><td>${esc(r.outcome || '')}</td>
            <td class="small">${esc(r.redactions || '')}</td>
            <td class="mono small">${r.tokensIn ? `${r.tokensIn} / ${r.tokensOut}` : ''}</td>
            <td class="mono small">${r.cost !== '' && r.cost != null ? formatCost(Number(r.cost)) : ''}</td>
          </tr>`).join('') : '<tr><td colspan="10" class="dim">No activity yet. Open an agent in Work and send a message.</td></tr>'}</tbody>
      </table>
    </div>
    <p class="small dim">Tokens are as reported by each provider, or estimated at about four characters per token. Costs use the price estimates in Settings. Hover a row for details.</p>
  </div>`, { sub: governSub('audit') });
}

function renderPolicy() {
  const p = state.policy;
  shell('govern', `
  <div class="page narrow">
    <header class="page-head"><h1>Policy</h1><p class="lede">Workspace rules that apply to every agent, before any agent's own safeguards.</p></header>
    <form id="policy" class="stack">
      <div class="panel"><h2 class="panel-h">Allowed models</h2>
        <div class="opt-grid">${MODELS.map((m) => `<label class="opt"><input type="checkbox" name="allowed" value="${m.id}" ${p.allowedModels.includes(m.id) ? 'checked' : ''}><span><b>${esc(m.name)}</b><small>${esc(m.maker)} · ${esc(provenance(m))}</small></span></label>`).join('')}</div>
      </div>
      <div class="panel"><h2 class="panel-h">Personal data removed before sending</h2>
        <div class="opt-grid">${Object.entries(PII_TYPES).map(([k, v]) => `<label class="opt"><input type="checkbox" name="redact" value="${k}" ${p.redact[k] ? 'checked' : ''}><span><b>${esc(v)}</b></span></label>`).join('')}</div>
      </div>
      <div class="panel"><h2 class="panel-h">Blocked terms</h2>
        <label class="fld"><span>One per line. Messages containing them are not sent.</span><textarea id="p-blocked" rows="4">${esc(p.blockedTerms.join('\n'))}</textarea></label>
      </div>
      <div class="row end"><button type="submit" class="btn btn-dark">Save policy</button></div>
    </form>
  </div>`, { sub: governSub('policy') });
}

function renderSettings() {
  const byProvider = (prov) => MODELS.filter((m) => m.provider === prov);
  shell('govern', `
  <div class="page narrow">
    <header class="page-head"><h1>Settings &amp; API keys</h1>
      <p class="lede">The live demo runs on Berth's own keys. Keys you add here are saved in this browser only, sent only to their own provider, and take priority over the demo keys.</p></header>
    <form id="settings" class="stack">
      ${Object.entries(PROVIDERS).map(([prov, p]) => {
        const models = prov === 'openrouter' ? MODELS.filter((m) => m.provider === 'openrouter') : byProvider(prov);
        return `
        <div class="panel">
          <h2 class="panel-h">${esc(p.label)} ${currentStatus().providers?.[prov] ? '<span class="chip chip-ok">Demo key active</span>' : ''}</h2>
          <label class="fld"><span>${esc(p.keyLabel)} <a class="text-link" href="${p.docs}" target="_blank" rel="noopener">Get a key</a></span>
            <input type="password" autocomplete="off" spellcheck="false" data-key="${prov}" value="${esc(state.keys[prov])}" placeholder="${esc(p.keyHint)}"></label>
          ${models.map((m) => `
            <label class="fld"><span>${esc(m.name)} model id</span>
              <input list="list-${prov}" data-model-id="${m.id}" value="${esc(state.modelIds[m.id] || m.defaultModel)}"></label>`).join('')}
          ${prov === 'openrouter' ? `<label class="fld"><span>Grok via OpenRouter model id</span><input list="list-openrouter" data-model-id="grok@openrouter" value="${esc(state.modelIds['grok@openrouter'] || modelById('grok').openrouterModel)}"></label>` : ''}
          ${prov === 'xai' ? `<label class="fld"><span>Grok route</span><select id="grok-route">
              <option value="direct" ${state.grokRoute === 'direct' ? 'selected' : ''}>Direct to xAI</option>
              <option value="openrouter" ${state.grokRoute === 'openrouter' ? 'selected' : ''}>Through OpenRouter</option></select></label>` : ''}
          <datalist id="list-${prov}"></datalist>
          <div class="row gap8"><button type="button" class="btn btn-soft btn-sm" data-action="load-models" data-provider="${prov}">Load available models</button>
          <span class="small dim" id="load-${prov}"></span></div>
        </div>`;
      }).join('')}
      <div class="panel">
        <h2 class="panel-h">Price estimates</h2>
        <p class="small dim">US dollars per million tokens, used for the cost of each answer and the saving from routing.</p>
        <div class="price-grid">
          <span class="tiny dim">Model</span><span class="tiny dim">Input</span><span class="tiny dim">Output</span>
          ${MODELS.map((m) => {
            const pr = priceOf(m.id);
            return `<span class="small"><strong>${esc(m.name)}</strong></span>
              <input type="number" step="0.01" min="0" data-price="${m.id}" data-dir="in" value="${pr.in}" aria-label="${esc(m.name)} input price">
              <input type="number" step="0.01" min="0" data-price="${m.id}" data-dir="out" value="${pr.out}" aria-label="${esc(m.name)} output price">`;
          }).join('')}
        </div>
      </div>
      <div class="row end gap8">
        <button type="button" class="btn btn-danger-soft" data-action="reset">Clear all Berth data</button>
        <button type="submit" class="btn btn-dark">Save settings</button>
      </div>
    </form>
  </div>`, { sub: governSub('settings') });
}

// ---------------------------------------------------------------------------
// Router

function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id, sub] = path.split('/');
  // Older links
  if (page === 'b' && id) { location.replace(`#/work/${id}`); return; }
  if (page === 'edit' && id) { location.replace(`#/build/${id}`); return; }
  if (page === 'start' || page === 'new') { location.replace('#/build'); return; }
  if (page === 'audit' || page === 'policy' || page === 'settings') { location.replace(`#/govern/${page}`); return; }

  if (page === 'build') {
    if (id === 'new') {
      const t = new URLSearchParams(query).get('type');
      if (!draft || draft.id || !designer.dirty) { draft = newDraft(TYPES[t] ? t : 'agent'); designer.sel = 'input'; designer.dirty = true; designer.testText = ''; }
      return renderDesigner();
    }
    if (id) return openDesigner(id);
    return renderBuildIndex();
  }
  if (page === 'how') return renderHow(id);
  if (page === 'work') return renderWork(id || state.builds[0]?.id);
  if (page === 'knowledge') return renderKnowledge();
  if (page === 'comply') return renderComply();
  if (page === 'govern') {
    if (id === 'audit') return renderAudit();
    if (id === 'policy') return renderPolicy();
    if (id === 'settings') return renderSettings();
    return renderApprovals();
  }
  void sub;
  return renderHome();
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Events

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const workBuild = () => buildById(location.hash.split('/')[2]);

  switch (action) {
    // Build
    case 'new-agent':
      draft = newDraft(el.dataset.type);
      designer.sel = 'input';
      designer.dirty = true;
      designer.testText = '';
      location.hash = `#/build/new?type=${el.dataset.type}`;
      break;
    case 'd-select': {
      if (e.target.closest('.step-x')) break;
      designer.sel = el.dataset.step;
      paintDesigner({ sheet: true });
      if (window.matchMedia('(max-width: 900px)').matches) $('#sheet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
    case 'd-remove': {
      const step = el.dataset.step;
      if (step === 'route') { if (draft.type === 'harness') draft.routing = false; else toChatbot(draft); }
      if (step === 'review') {
        const wasApproval = controlsFor(compiled(draft)).approval;
        draft.type = 'agent';
        delete draft.models.reviewer;
        draft.requireApproval = wasApproval;
      }
      if (step === 'approve') setApproval(draft, false);
      if (designer.sel === step) designer.sel = 'work';
      markDirty();
      paintDesigner({ sheet: true });
      break;
    }
    case 'd-add-route': if (draft.type === 'chatbot') toAgent(draft); draft.routing = true; designer.sel = 'route'; markDirty(); paintDesigner({ sheet: true }); break;
    case 'd-add-tool': if (draft.type === 'chatbot') toAgent(draft); designer.sel = 'work'; markDirty(); paintDesigner({ sheet: true }); break;
    case 'd-add-docs': draft.useDocs = true; designer.sel = 'work'; markDirty(); paintDesigner({ sheet: true }); break;
    case 'd-add-review': toHarness(draft); designer.sel = 'review'; markDirty(); paintDesigner({ sheet: true }); break;
    case 'd-add-approval': setApproval(draft, true); designer.sel = 'approve'; markDirty(); paintDesigner({ sheet: true }); break;
    case 'd-model': {
      const role = el.dataset.role;
      if (role === 'chatbot') draft.modelId = el.dataset.id;
      else { draft.models[role] = el.dataset.id; if (role === 'strong') draft.modelId = el.dataset.id; }
      markDirty();
      paintDesigner({ sheet: true });
      break;
    }
    case 'd-save': saveDesigner(); break;
    case 'close-dialog': $('#dialog').close(); break;
    case 'confirm-save': confirmSave(); break;

    // Work
    case 'starter': { const b = workBuild(); if (b) send(b, el.textContent.trim()); break; }
    case 'stop': run.controller?.abort(); break;
    case 'toggle-list': ui.listOpen = !ui.listOpen; route(); break;
    case 'toggle-sheet': ui.sheetOpen = !ui.sheetOpen; route(); break;
    case 'approve': review(el.dataset.build, Number(el.dataset.index), true); break;
    case 'reject': review(el.dataset.build, Number(el.dataset.index), false); break;
    case 'regenerate': {
      const b = workBuild();
      const chat = chatOf(b.id);
      if (chat[chat.length - 1]?.role === 'assistant') chat.pop();
      send(b, '', { regenerate: true });
      break;
    }
    case 'copy': {
      const b = workBuild();
      const msg = chatOf(b.id)[Number(el.dataset.index)];
      try { await navigator.clipboard.writeText(msg.content); toast('Copied'); } catch { toast('Copy failed. Select the text instead.'); }
      break;
    }

    // Documents
    case 'kb-cancel': kb.pending = null; renderKnowledge(); break;
    case 'kb-paste': stageDocument($('#kb-name').value.trim() || 'Pasted text', $('#kb-text').value); break;
    case 'kb-index': {
      const p = kb.pending;
      kb.busy = 'Indexing…';
      renderKnowledge();
      try {
        const counts = summarise(p.findings);
        const d = await docsApi.add(p.name, p.redacted, counts);
        audit({ event: 'Document indexed', build: d.name, outcome: `${d.chunk_count} chunks`, redactions: describeCounts(counts) || 'none', actor: 'User', detail: `${p.text.length} characters, original kept on device` });
        kb.pending = null;
        toast('Indexed. Your agents can now answer from it.');
      } catch (err) {
        kb.error = err.message;
      }
      kb.busy = '';
      await refreshDocs();
      break;
    }
    case 'kb-delete': {
      try {
        await docsApi.remove(el.dataset.id);
        audit({ event: 'Document deleted', outcome: 'deleted', actor: 'User', detail: el.dataset.id });
        toast('Document and its chunks deleted');
      } catch (err) { kb.error = err.message; }
      await refreshDocs();
      break;
    }
    case 'kb-erase-ask': kb.confirmErase = true; renderKnowledge(); break;
    case 'kb-erase-cancel': kb.confirmErase = false; renderKnowledge(); break;
    case 'kb-erase': {
      try {
        const r = await docsApi.eraseAll();
        audit({ event: 'Erasure completed', outcome: `${r.deleted} documents deleted`, actor: 'User', detail: 'All documents, chunks and server-side events for this visitor removed' });
        toast('All your documents and records were deleted');
      } catch (err) { kb.error = err.message; }
      kb.confirmErase = false;
      await refreshDocs();
      break;
    }

    // Comply and Govern
    case 'evidence': {
      const b = buildById(el.dataset.id);
      if (!b) break;
      download(`berth-evidence-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.md`, evidencePack(b), 'text/markdown');
      audit({ event: 'Evidence pack exported', buildId: b.id, build: b.name, type: b.type, tier: b.tier, model: b.modelId, outcome: 'exported', actor: 'Admin' });
      save();
      break;
    }
    case 'export-csv': download(`berth-audit-${new Date().toISOString().slice(0, 10)}.csv`, auditToCsv(state.audit), 'text/csv'); break;
    case 'export-json': download(`berth-audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state.audit, null, 2), 'application/json'); break;
    case 'load-models': {
      const prov = el.dataset.provider;
      const out = $(`#load-${prov}`);
      const keyInput = document.querySelector(`[data-key="${prov}"]`);
      state.keys[prov] = keyInput.value.trim();
      out.textContent = 'Loading…';
      try {
        const ids = await listModels(prov);
        $(`#list-${prov}`).innerHTML = ids.map((i) => `<option value="${esc(i)}"></option>`).join('');
        out.textContent = `${ids.length} models found. Pick one in the model id fields.`;
      } catch (err) {
        out.textContent = err.message;
      }
      break;
    }
    case 'reset': el.textContent = 'Click again to clear everything'; el.dataset.action = 'reset-confirm'; break;
    case 'reset-confirm': resetAll(); break;
    default: break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'prompt' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.step[data-action="d-select"]')) {
    e.preventDefault();
    e.target.click();
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target;
  e.preventDefault();
  if (form.id === 'kb-search-form') {
    kb.query = $('#kb-q').value.trim();
    if (!kb.query) return;
    const { text: q } = redact(kb.query);
    docsApi.search(q, 5).then((r) => { kb.results = r; audit({ event: 'Document search', outcome: `${r.length} passages`, actor: 'User' }); renderKnowledge(); })
      .catch((err) => { kb.error = err.message; renderKnowledge(); });
    return;
  }
  if (form.id === 'test-form') {
    const text = $('#test-input').value.trim();
    if (!text || !draft) return;
    designer.testText = text;
    state.chats[testKey()] = [];
    send(compiled(draft), text, { key: testKey(), view: testView });
    return;
  }
  if (form.id === 'composer') {
    const b = buildById(location.hash.split('/')[2]);
    const text = $('#prompt').value.trim();
    if (b && text) send(b, text);
    return;
  }
  if (form.id === 'policy') {
    state.policy.allowedModels = [...form.querySelectorAll('input[name="allowed"]:checked')].map((i) => i.value);
    Object.keys(state.policy.redact).forEach((k) => { state.policy.redact[k] = Boolean(form.querySelector(`input[name="redact"][value="${k}"]`)?.checked); });
    state.policy.blockedTerms = $('#p-blocked').value.split('\n').map((s) => s.trim()).filter(Boolean);
    audit({ event: 'Policy updated', outcome: 'saved', actor: 'Admin', detail: `allowed: ${state.policy.allowedModels.join(', ')}` });
    save();
    toast('Policy saved');
    return;
  }
  if (form.id === 'settings') {
    form.querySelectorAll('[data-key]').forEach((i) => { state.keys[i.dataset.key] = i.value.trim(); });
    form.querySelectorAll('[data-model-id]').forEach((i) => {
      const v = i.value.trim();
      if (v) state.modelIds[i.dataset.modelId] = v; else delete state.modelIds[i.dataset.modelId];
    });
    form.querySelectorAll('[data-price]').forEach((i) => {
      const id = i.dataset.price;
      state.prices[id] = state.prices[id] || { ...priceOf(id) };
      state.prices[id][i.dataset.dir] = Math.max(0, Number(i.value) || 0);
    });
    const gr = $('#grok-route');
    if (gr) state.grokRoute = gr.value;
    save();
    toast('Settings saved');
  }
});

// Designer bindings: text fields update the draft as you type
function bindValue(el) {
  const d = draft;
  const key = el.dataset.bind;
  const v = el.type === 'checkbox' ? el.checked : el.value;
  switch (key) {
    case 'name': d.name = v; break;
    case 'purpose': d.purpose = v; if (d.id) d._tierStale = true; break;
    case 'usedBy': {
      const r = applyUsedBy(d, v);
      if (r.changed) toast(`Risk tier changed to ${TIERS[d.tier].label}. Controls updated.`);
      break;
    }
    case 'minutesManual': d.minutesManual = Math.max(1, Math.min(600, Number(v) || 10)); break;
    case 'starters': d.starters = v.split('\n').map((s) => s.trim()).filter(Boolean); break;
    case 'protectedTerms': d.protectedTerms = v.split(',').map((s) => s.trim()).filter(Boolean); break;
    case 'instructions': d.instructions = v; break;
    case 'knowledge': d.knowledge = v; break;
    case 'maxSteps': d.maxSteps = Math.min(12, Math.max(1, Number(v) || 6)); break;
    case 'routing': d.routing = v; break;
    case 'useDocs': d.useDocs = v; break;
    case 'h.review': d.harness.review = v; break;
    case 'h.retry': d.harness.retry = v; break;
    case 'approval': setApproval(d, v); break;
    case 'fullLog': d.harness.fullLog = v; break;
    case 'aiLabel': d.harness.aiLabel = v; break;
    default: return false;
  }
  markDirty();
  return true;
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'prompt') {
    const b = buildById(location.hash.split('/')[2]);
    if (b) updatePreview(b);
    return;
  }
  if (e.target.id === 'test-input') { designer.testText = e.target.value; return; }
  if (draft && e.target.dataset?.bind && e.target.type !== 'checkbox' && e.target.tagName !== 'SELECT') {
    if (bindValue(e.target)) paintDesigner();
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'kb-file' && t.files?.[0]) {
    const f = t.files[0];
    kb.busy = 'Reading file…';
    extractText(f).then((txt) => { kb.busy = ''; stageDocument(f.name, txt); })
      .catch((err) => { kb.busy = ''; kb.error = err.message; renderKnowledge(); });
    return;
  }
  if (t.id === 'how-select') { location.hash = `#/how/${t.value}`; return; }
  if (t.dataset?.usedby) { const b = buildById(t.dataset.usedby); if (b) changeUsedBy(b, t.value); return; }
  if (t.id === 'run-usedby') { const b = buildById(location.hash.split('/')[2]); if (b) changeUsedBy(b, t.value); return; }
  if (!draft || !location.hash.startsWith('#/build/')) return;
  if (t.dataset.bind && (t.type === 'checkbox' || t.tagName === 'SELECT')) {
    if (t.dataset.bind === 'approval' && !t.checked) designer.sel = 'work';
    if (bindValue(t)) paintDesigner({ sheet: true });
    return;
  }
  if (t.dataset.tool) {
    const k = t.dataset.tool;
    draft.tools = t.checked ? [...new Set([...(draft.tools || []), k])] : (draft.tools || []).filter((x) => x !== k);
    markDirty(); paintDesigner({ sheet: true });
    return;
  }
  if (t.dataset.toolmode) {
    draft.harness = draft.harness || {};
    draft.harness.toolModes = { ...(draft.harness.toolModes || {}), [t.dataset.toolmode]: t.value };
    markDirty();
    return;
  }
  if (t.dataset.doc) {
    const n = t.dataset.doc;
    draft.docScope = t.checked ? [...new Set([...(draft.docScope || []), n])] : (draft.docScope || []).filter((x) => x !== n);
    markDirty(); paintDesigner();
    return;
  }
  if (t.dataset.safeguard) {
    const k = t.dataset.safeguard;
    draft.chosenSafeguards = t.checked ? [...new Set([...(draft.chosenSafeguards || []), k])] : (draft.chosenSafeguards || []).filter((x) => x !== k);
    markDirty(); paintDesigner();
  }
});

loadStatus().then(() => route());
route();
