// Berth: UI, routing and the send pipeline.

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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = () => $('#app');

const TYPES = {
  chatbot: {
    label: 'Chatbot',
    models: 'One model',
    line: 'Answers questions from its instructions and reference text.',
    parts: ['One model', 'Instructions', 'Reference text'],
    example: 'A policy Q&A bot for staff',
  },
  agent: {
    label: 'Agent',
    models: 'Two or three models',
    line: 'A cheap router sends simple requests to a fast model and complex ones to a strong model, which can use tools.',
    parts: ['Model routing', 'Tools', 'Step limit'],
    example: 'A loan assessor that calculates repayments',
  },
  harness: {
    label: 'Harness',
    models: 'Up to four models',
    line: 'An agent inside a controlled pipeline: triage, work, an independent reviewer model, then human approval.',
    parts: ['Routing', 'Independent reviewer', 'Tool permissions', 'Approval gates'],
    example: 'A CV screener with blind screening and sign-off',
  },
};

const SAFEGUARD_LIBRARY = {
  blindScreening: { label: 'Blind screening', detail: 'Remove name, age, gender, nationality and photo references', from: 'candidate-screener' },
  redFlagStop: { label: 'Emergency stop', detail: 'Stop and show emergency advice on red-flag symptoms', from: 'symptom-guide' },
  citationCheck: { label: 'Citation check', detail: 'Flag cited cases and statutes as unverified', from: 'contract-reviewer' },
  noReject: { label: 'Shortlist only', detail: 'Flag any answer that rejects a person', from: 'candidate-screener' },
  noFinalDecision: { label: 'No final decisions', detail: 'Flag answers that read as a final approval or refusal', from: 'loan-checker' },
};

function tmpl(key) { return TEMPLATES.find((t) => t.key === key); }

function buildById(id) { return state.builds.find((b) => b.id === id); }

function tierPlate(tier, extra = '') {
  const t = TIERS[tier] || TIERS.minimal;
  return `<span class="plate plate-${tier}">${esc(t.label.toUpperCase())}${extra ? ` · ${esc(extra)}` : ''}</span>`;
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
  if (!hasKey(m.id)) return { ok: false, text: 'Add API key', key: true };
  const own = Boolean(state.keys[m.provider === 'xai' && state.grokRoute === 'openrouter' ? 'openrouter' : m.provider]);
  return { ok: true, text: own ? 'Ready · your key' : 'Ready · demo' };
}

// ---------------------------------------------------------------------------
// Seed the four governed templates on first run

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
    tools: [...(t.tools || [])],
    knowledge: t.knowledge || '',
    protectedTerms: [...(t.protectedTerms || [])],
    safeguards: structuredClone(t.safeguards || {}),
    chosenSafeguards: [...(t.chosenSafeguards || [])],
    harness: t.harness ? structuredClone(t.harness) : undefined,
    maxSteps: t.harness?.maxSteps || 6,
    tier: t.tier,
    basis: t.basis,
    rationale: t.rationale,
    tierConfirmedBy: 'Template default',
    createdAt: new Date().toISOString(),
  };
}

if (!state.seeded) {
  state.builds = TEMPLATES.map(buildFromTemplate);
  state.seeded = true;
  state.version = 2;
  save();
}

// v2 added multi-model routing: refresh the examples in place, keep their ids.
if ((state.version || 0) < 2) {
  for (const t of TEMPLATES) {
    const i = state.builds.findIndex((b) => b.templateKey === t.key);
    const fresh = buildFromTemplate(t);
    if (i >= 0) state.builds[i] = { ...fresh, id: state.builds[i].id };
    else state.builds.push(fresh);
  }
  for (const b of state.builds) {
    if (b.type !== 'chatbot' && !b.models) { b.models = defaultModels(b.type, b.modelId); b.routing = true; }
  }
  state.version = 2;
  save();
}

// v3 added document retrieval and the Policy Assistant example.
if ((state.version || 0) < 3) {
  for (const t of TEMPLATES) {
    if (!state.builds.some((b) => b.templateKey === t.key)) state.builds.push(buildFromTemplate(t));
  }
  state.version = 3;
  save();
}

// A reload during an answer leaves it half-finished; mark it so.
for (const chat of Object.values(state.chats)) {
  for (const m of chat) {
    if (m.status === 'streaming') { m.status = 'error'; m.error = 'Interrupted by a page reload.'; }
  }
}

// ---------------------------------------------------------------------------
// Layout

const ICON = {
  home: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>',
  list: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
  map: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="4" width="6" height="5" rx="1"/><rect x="9" y="15" width="6" height="5" rx="1"/><path d="M9 6.5h6M6 9v3.5h12V9M12 12.5V15"/></svg>',
  book: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/></svg>',
  arrow: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

function rail(active) {
  const builds = state.builds.map((b) => `
    <a class="rail-link ${active === b.id ? 'is-active' : ''}" href="#/b/${b.id}">
      <span class="dot dot-${b.tier}"></span><span class="rail-name">${esc(b.name)}</span>
      <span class="rail-type">${esc(TYPES[b.type].label)}</span>
    </a>`).join('');
  return `
  <nav class="rail" aria-label="Workspace">
    <a class="brand" href="#/"><span class="brand-word">Berth</span><span class="mono dim">v0.2</span></a>
    <a class="btn btn-outline rail-new" href="#/start">${ICON.plus} New build</a>
    <a class="rail-link rail-home ${active === 'home' ? 'is-active' : ''}" href="#/">${ICON.home}Home</a>
    <a class="rail-link rail-how ${active === 'how' ? 'is-active' : ''}" href="#/how">${ICON.map}How it works</a>
    <a class="rail-link rail-how ${active === 'knowledge' ? 'is-active' : ''}" href="#/knowledge">${ICON.book}Knowledge</a>
    <div class="rail-group">
      <div class="eyebrow">Your builds</div>
      ${builds || '<p class="dim small pad8">Nothing built yet.</p>'}
    </div>
    <div class="rail-foot">
      <a class="rail-link ${active === 'policy' ? 'is-active' : ''}" href="#/policy">${ICON.shield}Governance policy</a>
      <a class="rail-link ${active === 'audit' ? 'is-active' : ''}" href="#/audit">${ICON.list}Audit log<span class="mono dim push">${state.audit.length}</span></a>
      <a class="rail-link ${active === 'settings' ? 'is-active' : ''}" href="#/settings">${ICON.gear}Settings &amp; API keys</a>
    </div>
  </nav>`;
}

function shell(active, main, aside = '') {
  app().innerHTML = `<div class="shell ${aside ? 'has-aside' : ''}">${rail(active)}<main class="main">${main}</main>${aside}</div>`;
  $('.main')?.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Landing page

function renderLanding() {
  const examples = state.builds.filter((b) => b.templateKey);
  shell('home', `
  <div class="landing">
    <section class="hero">
      <div class="eyebrow">A governed AI workspace</div>
      <h1>Multi-model agentic AI with governance and compliance logs.</h1>
      <p class="lede">Berth lets a team choose the right model for each job, route work between cheap and strong models to control cost, and apply controls that match the risk of each use. Personal data is removed before any prompt leaves the browser, and every decision is logged.</p>
      ${currentStatus().demo ? `<p class="demo-note small">${ICON.shield} Live demo: runs on Berth's own keys, ${currentStatus().limits?.perVisitor || 40} requests per visitor per day. No sign-up or API key needed.</p>` : ''}
      <div class="row wrap gap8">
        <a class="btn btn-primary" href="#/start">Start building ${ICON.arrow}</a>
        <a class="btn btn-outline" href="#/how">How it works</a>
      </div>
    </section>

    <section class="band">
      <h2 class="section-title">How it works</h2>
      <ol class="how">
        <li><span class="how-no mono">1</span><div><strong>Say what you are building.</strong><p>A chatbot, an agent or a harness, and what it is for. The purpose and who uses it set the risk tier.</p></div></li>
        <li><span class="how-no mono">2</span><div><strong>Assign models to roles.</strong><p>One model for a chatbot. For agents and harnesses, a cheap router sends simple requests to a fast model and complex ones to a strong model, and a reviewer from another vendor checks the result.</p></div></li>
        <li><span class="how-no mono">3</span><div><strong>Use it with controls in force.</strong><p>Redaction, blocked terms, approval gates, output checks and an audit log apply to every request, and each answer shows its cost.</p></div></li>
      </ol>
    </section>

    <section class="band">
      <h2 class="section-title">Three things you can build</h2>
      <div class="grid grid-3">
        ${Object.entries(TYPES).map(([k, t]) => `
          <a class="card type-card" href="#/start?type=${k}">
            <span class="row between"><span class="type-name">${t.label}</span><span class="mono tiny tag">${esc(t.models)}</span></span>
            <span class="type-line">${esc(t.line)}</span>
            ${pipelineDiagram(k)}
            <span class="small dim">For example: ${esc(t.example)}</span>
          </a>`).join('')}
      </div>
    </section>

    <section class="band split">
      <div>
        <h2 class="section-title">Why route between models</h2>
        <p>Most requests to a workplace assistant are simple: a lookup, a rewrite, a single calculation. Sending all of them to the strongest model costs several times more than needed. Berth asks a cheap model to triage each request, sends simple ones to a fast model and keeps the strong model for work that needs it. Every answer shows its cost and what the same run would have cost on the strong model alone.</p>
      </div>
      <div class="cost-demo">
        <div class="cost-row"><span>Strong model for every request</span><span class="bar"><span style="width:100%"></span></span><span class="mono">100%</span></div>
        <div class="cost-row"><span>Routed: simple requests to a fast model</span><span class="bar"><span class="accent" style="width:42%"></span></span><span class="mono">~42%</span></div>
        <p class="tiny dim">Illustration: 70% of requests simple, Gemini as the fast model, Claude as the strong model, Mistral as the router, at the default price estimates. Your savings depend on your mix of requests.</p>
      </div>
    </section>

    <section class="band">
      <h2 class="section-title">Governance built in</h2>
      <div class="grid grid-4 feature-grid">
        <div><strong>Redaction before sending</strong><p>Emails, phone numbers, card numbers, IBANs and tax file numbers are replaced with placeholders in the browser.</p></div>
        <div><strong>Risk tiers</strong><p>Each build is classified under the EU AI Act by purpose and deployment context. The tier switches controls on.</p></div>
        <div><strong>Human oversight</strong><p>High-risk answers are held until a person approves them. Harnesses can ask before each tool call.</p></div>
        <div><strong>Audit log</strong><p>Every request, route, review, block and approval is recorded and exportable as CSV or JSON.</p></div>
      </div>
    </section>

    <section class="band">
      <h2 class="section-title">Governed examples</h2>
      <p class="dim section-lede">One for each of four regulated industries, plus a policy assistant that answers from uploaded documents.</p>
      <div class="grid grid-auto">
        ${examples.map((b) => {
          const t = tmpl(b.templateKey);
          return `<a class="card tpl-card" href="#/b/${b.id}">
            <span class="row between"><span class="eyebrow">${esc(t.industry)}</span>${tierPlate(b.tier)}</span>
            <span class="tpl-name">${esc(b.name)}</span>
            <span class="small">${esc(b.purpose)}</span>
            <span class="small dim">${esc(TYPES[b.type].label)} · ${modelsUsed(b).map((id) => esc(modelById(id).name)).join(', ')}</span>
          </a>`;
        }).join('')}
      </div>
    </section>

    <footer class="landing-foot small dim">
      Berth is a working prototype built as preparatory work for doctoral research on AI governance.
      <a href="https://github.com/HackrLife/Berth" target="_blank" rel="noopener">Source on GitHub</a> ·
      <a href="https://github.com/HackrLife/Berth/blob/main/PRD.md" target="_blank" rel="noopener">Product requirements</a>
    </footer>
  </div>`);
}

function pipelineDiagram(type) {
  const node = (label, sub, cls = '') => `<span class="pnode ${cls}"><span>${label}</span><span class="mono tiny">${sub}</span></span>`;
  const arrow = '<span class="parrow" aria-hidden="true">→</span>';
  if (type === 'chatbot') return `<span class="pipe">${node('Model', 'answers')}</span>`;
  const work = `<span class="pfork">${node('Fast', 'simple')}${node('Strong', 'complex')}</span>`;
  if (type === 'agent') return `<span class="pipe">${node('Router', 'triage')}${arrow}${work}</span>`;
  return `<span class="pipe">${node('Router', 'triage')}${arrow}${work}${arrow}${node('Reviewer', 'check')}${arrow}${node('Person', 'approve', 'pperson')}</span>`;
}

// ---------------------------------------------------------------------------
// Knowledge: upload, redact, index, search, delete

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
}

function renderKnowledge() {
  const st = currentStatus();
  if (st.retrieval && kb.docs === null) { kb.docs = []; kb.busy = 'Loading documents…'; refreshDocs().then(() => { kb.busy = ''; renderKnowledge(); }); }
  const counts = kb.pending ? summarise(kb.pending.findings) : {};
  shell('knowledge', `
  <div class="page">
    <header class="page-head">
      <h1>Knowledge</h1>
      <p class="lede">Upload documents for your builds to search. Personal data is removed in your browser before anything is indexed, the original file never leaves your device, and every answer cites the passages it used.</p>
    </header>
    <div class="facts-row">
      <div><span class="eyebrow">Embeddings</span><span>${esc(st.embedding || 'text-embedding-3-small')} · 512 dimensions</span></div>
      <div><span class="eyebrow">Stored in</span><span>${esc(st.storage || 'Supabase pgvector')}</span></div>
      <div><span class="eyebrow">Isolation</span><span>Row-level security per visitor</span></div>
      <div><span class="eyebrow">Erasure</span><span>One click, logged</span></div>
    </div>
    ${st.retrieval ? '' : '<div class="notice">Document search runs on the hosted Berth demo. This copy has no retrieval service configured, so uploads are switched off.</div>'}
    ${kb.error ? `<div class="notice warn-bg">${esc(kb.error)}</div>` : ''}

    <section class="kb-grid">
      <div class="card kb-upload">
        <h2 class="h-sub">Add a document</h2>
        ${kb.pending ? `
          <div class="kb-pending">
            <div class="row between wrap"><strong>${esc(kb.pending.name)}</strong><span class="mono tiny dim">${kb.pending.text.length.toLocaleString()} characters</span></div>
            <div class="redact-note">${shieldIcon()} ${kb.pending.findings.length ? `${esc(describeCounts(counts))} will be removed before indexing` : 'No personal data found'}</div>
            <div class="kb-preview">${highlightTokens(kb.pending.redacted.slice(0, 900))}${kb.pending.redacted.length > 900 ? '…' : ''}</div>
            <div class="row gap8">
              <button type="button" class="btn btn-primary" data-action="kb-index" ${kb.busy ? 'disabled' : ''}>${kb.busy ? esc(kb.busy) : 'Index document'}</button>
              <button type="button" class="btn btn-ghost" data-action="kb-cancel">Cancel</button>
            </div>
          </div>` : `
          <label class="kb-drop" for="kb-file">
            <strong>Choose a file</strong>
            <span class="small dim">PDF, Word, text, Markdown, CSV or JSON · up to 150,000 characters</span>
            <input id="kb-file" type="file" accept="${ACCEPT_TYPES}" ${st.retrieval ? '' : 'disabled'}>
          </label>
          <details class="kb-paste"><summary class="small">Or paste text</summary>
            <label class="field"><span>Name</span><input id="kb-name" placeholder="e.g. Leave policy"></label>
            <label class="field"><span>Text</span><textarea id="kb-text" rows="5"></textarea></label>
            <button type="button" class="btn btn-small btn-outline" data-action="kb-paste" ${st.retrieval ? '' : 'disabled'}>Preview redaction</button>
          </details>`}
      </div>

      <div class="card kb-search">
        <h2 class="h-sub">Test a search</h2>
        <form id="kb-search-form" class="row gap8">
          <label for="kb-q" class="sr-only">Question</label>
          <input id="kb-q" value="${esc(kb.query)}" placeholder="e.g. What is the hotel limit in Sydney?" ${st.retrieval ? '' : 'disabled'}>
          <button type="submit" class="btn btn-outline" ${st.retrieval ? '' : 'disabled'}>Search</button>
        </form>
        ${kb.results ? (kb.results.length ? `<ol class="kb-results">${kb.results.map((r) => `
          <li><div class="row between"><strong class="small">${esc(r.document_name)}</strong><span class="mono tiny dim">passage ${r.idx + 1} · ${Math.round(r.similarity * 100)}% match</span></div>
          <p class="small">${highlightTokens(r.content.slice(0, 320))}${r.content.length > 320 ? '…' : ''}</p></li>`).join('')}</ol>` : '<p class="small dim">No passages found.</p>') : '<p class="small dim">Runs the same vector search your builds use, over your documents and the shared samples.</p>'}
      </div>
    </section>

    <section class="band">
      <div class="row between wrap">
        <h2 class="section-title">Documents</h2>
        ${kb.docs?.some((d) => !d.sample) ? (kb.confirmErase
          ? '<span class="row gap8"><span class="small">Delete all your documents and their records?</span><button type="button" class="btn btn-small btn-quiet-danger" data-action="kb-erase">Delete everything</button><button type="button" class="btn btn-small btn-ghost" data-action="kb-erase-cancel">Keep</button></span>'
          : '<button type="button" class="btn btn-small btn-quiet-danger" data-action="kb-erase-ask">Delete all my data</button>') : ''}
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th>Document</th><th>Chunks</th><th>Characters</th><th>Removed before indexing</th><th>Added</th><th></th></tr></thead>
          <tbody>${kb.docs === null || (kb.busy && !kb.docs.length) ? '<tr><td colspan="6" class="dim">Loading…</td></tr>'
            : kb.docs.length ? kb.docs.map((d) => `
            <tr>
              <td>${esc(d.name)} ${d.sample ? '<span class="mono tiny tag">SAMPLE · SHARED</span>' : '<span class="mono tiny tag">YOURS · PRIVATE</span>'}</td>
              <td class="mono">${d.chunk_count}</td><td class="mono">${Number(d.chars).toLocaleString()}</td>
              <td class="small">${esc(describeCounts(d.redactions || {}) || 'none')}</td>
              <td class="mono small nowrap">${new Date(d.created_at).toLocaleDateString()}</td>
              <td>${d.sample ? '' : `<button type="button" class="link-btn" data-action="kb-delete" data-id="${esc(d.id)}">Delete</button>`}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="dim">No documents yet.</td></tr>'}</tbody>
        </table>
      </div>
      <p class="small dim">Sample documents belong to a fictional company and are shared read-only with every visitor. Your own documents are visible only to this browser.</p>
    </section>
  </div>`);
}

async function stageDocument(name, text) {
  const clean = String(text || '').trim();
  if (!clean) { toast('That file has no readable text.'); return; }
  const { text: redacted, findings } = redact(clean);
  kb.pending = { name, text: clean, redacted, findings };
  renderKnowledge();
}

// ---------------------------------------------------------------------------
// How it works: architecture patterns

function renderHow(id) {
  const p = PATTERNS.find((x) => x.id === id) || PATTERNS[0];
  const groups = [...new Set(PATTERNS.map((x) => x.group))];
  shell('how', `
  <div class="how-page">
    <aside class="how-tabs" aria-label="Patterns">
      ${groups.map((g) => `
        <div class="how-group">
          <div class="eyebrow">${esc(g)}</div>
          ${PATTERNS.filter((x) => x.group === g).map((x) => `
            <a class="how-tab ${x.id === p.id ? 'is-active' : ''}" href="#/how/${x.id}" ${x.id === p.id ? 'aria-current="page"' : ''}>
              <span>${esc(x.title)}</span>${x.status === 'reference' ? '<span class="mono tiny dim">ref</span>' : ''}
            </a>`).join('')}
        </div>`).join('')}
    </aside>
    <section class="how-main">
      <label class="how-select"><span class="sr-only">Pattern</span>
        <select id="how-select">${groups.map((g) => `<optgroup label="${esc(g)}">${PATTERNS.filter((x) => x.group === g).map((x) => `<option value="${x.id}" ${x.id === p.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</optgroup>`).join('')}</select>
      </label>
      <header class="how-head">
        <div class="eyebrow">${esc({ Agents: 'Agent pattern', Harnesses: 'Harness pattern', Foundations: 'Foundation' }[p.group])}</div>
        <div class="row between wrap">
          <h1>${esc(p.title)}</h1>
          <span class="status ${p.status === 'runs' ? 'status-runs' : 'status-ref'}">${p.status === 'runs' ? 'Runs in Berth today' : 'Reference design'}</span>
        </div>
        <p class="lede">${esc(p.summary)}</p>
      </header>
      <figure class="diagram-card">
        <div class="diagram-scroll">${renderDiagram(p)}</div>
        <figcaption>${renderLegend()}</figcaption>
      </figure>
      <div class="how-facts">
        <div><h2>When to use it</h2><p>${esc(p.when)}</p></div>
        <div><h2>Cost</h2><p>${esc(p.cost)}</p></div>
        <div><h2>Governance</h2><p>${esc(p.governance)}</p></div>
      </div>
      <p class="small dim">These are architecture patterns, independent of industry or use case. Any of the governed examples can run on the patterns marked as running in Berth.</p>
    </section>
  </div>`);
}

// ---------------------------------------------------------------------------
// Builder: what are you building, then which models

const pick = { type: null, modelId: null, models: {} };

function modelOption(m, selected) {
  const s = modelStatus(m);
  return `<option value="${m.id}" ${selected === m.id ? 'selected' : ''} ${state.policy.allowedModels.includes(m.id) ? '' : 'disabled'}>${esc(m.name)} · ${esc(provenance(m))} · ${s.ok ? 'ready' : s.text.toLowerCase()}</option>`;
}

function modelCard(m) {
  const s = modelStatus(m);
  const sel = pick.modelId === m.id;
  const p = priceOf(m.id);
  return `
    <button type="button" class="card model-card ${sel ? 'is-selected' : ''} ${s.ok ? '' : 'is-muted'}" data-action="pick-model" data-id="${m.id}" aria-pressed="${sel}">
      <span class="row between"><span class="model-name">${esc(m.name)}</span><span class="check" aria-hidden="true"></span></span>
      <span class="small dim">${esc(m.maker)}</span>
      <span class="mono tiny tag">${esc(provenance(m))}</span>
      <span class="mono tiny dim">$${p.in} / $${p.out} per 1M tokens</span>
      <span class="small ${s.ok ? 'ok' : 'warn'}">${esc(s.text)}</span>
    </button>`;
}

function typeCard(key) {
  const t = TYPES[key];
  const sel = pick.type === key;
  return `
    <button type="button" class="card type-card ${sel ? 'is-selected' : ''}" data-action="pick-type" data-id="${key}" aria-pressed="${sel}">
      <span class="row between"><span class="type-name">${t.label}</span><span class="check" aria-hidden="true"></span></span>
      <span class="mono tiny tag">${esc(t.models)}</span>
      <span class="type-line">${esc(t.line)}</span>
      ${pipelineDiagram(key)}
    </button>`;
}

function roleRows(models, type, idPrefix = 'role') {
  return rolesFor(type).map((r) => {
    const role = ROLES[r];
    const p = priceOf(models[r]);
    return `
      <div class="role-row">
        <div class="role-label"><span class="pill-stage mono tiny">${esc(role.stage)}</span><strong>${esc(role.label)}</strong><span class="small dim">${esc(role.blurb)}</span></div>
        <div class="role-pick">
          <select id="${idPrefix}-${r}" data-role="${r}" aria-label="${esc(role.label)}">${MODELS.map((m) => modelOption(m, models[r])).join('')}</select>
          <span class="mono tiny dim">$${p.in} / $${p.out} per 1M</span>
        </div>
      </div>`;
  }).join('');
}

function renderStart() {
  const anyKey = Object.values(state.keys).some(Boolean);
  const closed = MODELS.filter((m) => m.weights === 'closed');
  const open = MODELS.filter((m) => m.weights === 'open');
  const t = pick.type;
  const ready = t === 'chatbot' ? Boolean(pick.modelId) : Boolean(t);

  let step2 = '';
  if (t === 'chatbot') {
    step2 = `
      <p class="small dim">A chatbot uses one model for every answer.</p>
      <div class="group-label">Closed weights</div>
      <div class="grid grid-4">${closed.map(modelCard).join('')}</div>
      <div class="group-label">Open weights <span class="dim">· through OpenRouter</span></div>
      <div class="grid grid-4">${open.map(modelCard).join('')}</div>`;
  } else if (t) {
    step2 = `
      <p class="small dim">${t === 'agent'
        ? 'The router reads each request and sends it to the fast or the strong model. Only the model that does the work uses tools.'
        : 'Each request passes through triage, work and an independent review before any human approval. Choose a reviewer from a different vendor to the workers.'}</p>
      ${pipelineDiagram(t)}
      <div class="roles">${roleRows(pick.models, t, 'start')}</div>`;
  }

  shell('start', `
  <div class="page">
    <header class="page-head">
      <h1>What are you building?</h1>
      <p class="lede">Choose the kind of build first. It decides how many models take part and how they work together.</p>
    </header>
    ${anyKey ? '' : `<div class="notice">
      <strong>Add an API key to run your builds.</strong> Keys are stored only in this browser and sent only to their provider.
      <a class="btn btn-small" href="#/settings">Add keys</a></div>`}

    <section class="step">
      <div class="step-head"><span class="step-no mono">1</span><h2>Choose a build type</h2></div>
      <div class="grid grid-3">${Object.keys(TYPES).map(typeCard).join('')}</div>
    </section>

    ${t ? `<section class="step">
      <div class="step-head"><span class="step-no mono">2</span><h2>${t === 'chatbot' ? 'Choose its model' : 'Assign models to roles'}</h2></div>
      ${step2}
    </section>` : ''}

    <div class="continue-bar">
      <span class="small">${!t ? '<span class="dim">Choose a build type.</span>'
        : t === 'chatbot' ? (pick.modelId ? `Chatbot on <strong>${esc(modelById(pick.modelId).name)}</strong>` : '<span class="dim">Choose a model.</span>')
          : `${esc(TYPES[t].label)} · ${rolesFor(t).map((r) => `${ROLES[r].label}: <strong>${esc(modelById(pick.models[r]).name)}</strong>`).join(' · ')}`}</span>
      <button type="button" class="btn btn-primary" data-action="continue" ${ready ? '' : 'disabled'}>Continue</button>
    </div>
  </div>`);
}

// ---------------------------------------------------------------------------
// Build editor

let draft = null;

function newDraft(type, modelId, models) {
  return {
    id: null,
    name: '',
    type,
    modelId: type === 'chatbot' ? modelId : models.strong,
    models: type === 'chatbot' ? {} : { ...models },
    routing: true,
    purpose: '',
    usedBy: 'Internal team',
    instructions: '',
    starters: [],
    tools: type === 'chatbot' ? [] : ['calculator', 'knowledge'],
    knowledge: '',
    protectedTerms: [],
    safeguards: {},
    chosenSafeguards: [],
    harness: type === 'harness' ? { approval: false, fullLog: true, aiLabel: false, review: true, retry: true, toolModes: {} } : undefined,
    maxSteps: 6,
    tier: null,
  };
}

function renderEditor() {
  const d = draft;
  const isTool = d.type !== 'chatbot';
  const allowed = MODELS.filter((m) => state.policy.allowedModels.includes(m.id));
  shell(d.id || 'home', `
  <div class="page editor">
    <header class="page-head">
      <div class="eyebrow">${d.id ? 'Edit build' : 'New build'}</div>
      <h1>${d.id ? esc(d.name) : `New ${esc(TYPES[d.type].label.toLowerCase())}`}</h1>
    </header>
    <form id="editor" class="form" novalidate>
      <div class="field-row">
        <label class="field"><span>Name</span><input id="f-name" required value="${esc(d.name)}" placeholder="e.g. Supplier Contract Checker"></label>
        <label class="field"><span>Build type</span>
          <select id="f-type">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${d.type === k ? 'selected' : ''}>${t.label}</option>`).join('')}</select></label>
        ${d.type === 'chatbot' ? `<label class="field"><span>Model</span>
          <select id="f-model">${allowed.map((m) => `<option value="${m.id}" ${d.modelId === m.id ? 'selected' : ''}>${esc(m.name)} · ${esc(provenance(m))}</option>`).join('')}</select></label>` : ''}
      </div>
      ${d.type !== 'chatbot' ? `
      <fieldset class="fieldset">
        <legend>Models</legend>
        ${pipelineDiagram(d.type)}
        <label class="check-row"><input type="checkbox" id="f-routing" ${d.routing !== false ? 'checked' : ''}> <span><strong>Route by difficulty</strong><br><span class="small dim">The router sends simple requests to the fast model. Turn off to send everything to the strong model.</span></span></label>
        <div class="roles">${roleRows(d.models || defaultModels(d.type, d.modelId), d.type, 'f-role')}</div>
      </fieldset>` : ''}
      <div class="field-row">
        <label class="field grow"><span>What is it for?</span><input id="f-purpose" value="${esc(d.purpose)}" placeholder="The job it does and for whom. This decides its risk tier."></label>
        <label class="field"><span>Used by</span>
          <select id="f-usedby">${USED_BY.map((u) => `<option ${d.usedBy === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Instructions</span><textarea id="f-instructions" rows="7" placeholder="How it should behave, what it must never do, and the format of its answers.">${esc(d.instructions)}</textarea></label>
      <label class="field"><span>Starter prompts <em class="dim">one per line</em></span><textarea id="f-starters" rows="3">${esc(d.starters.join('\n'))}</textarea></label>
      <label class="field"><span>Reference text <em class="dim">${isTool ? 'searchable with the knowledge tool' : 'added to the instructions'}</em></span><textarea id="f-knowledge" rows="5" placeholder="Paste a policy, criteria or a job description.">${esc(d.knowledge)}</textarea></label>
      <label class="check-row"><input type="checkbox" id="f-docs" ${d.useDocs ? 'checked' : ''} ${currentStatus().retrieval ? '' : 'disabled'}> <span><strong>Search Knowledge documents</strong><br><span class="small dim">${currentStatus().retrieval
        ? (d.type === 'chatbot' ? 'Relevant passages are retrieved before every answer and cited as sources.' : 'Adds a document-search tool; the model decides when to use it and cites what it finds.')
        : 'Available on the hosted demo, where the retrieval service is configured.'}</span></span></label>
      <label class="field"><span>Protected names <em class="dim">comma separated, always removed before sending</em></span><input id="f-terms" value="${esc(d.protectedTerms.join(', '))}" placeholder="Client or patient names"></label>

      ${isTool ? `
      <fieldset class="fieldset">
        <legend>Tools</legend>
        <div class="grid grid-2">
          ${Object.entries(TOOLS).filter(([k]) => k !== 'documents').map(([k, t]) => `
            <div class="tool-row">
              <label class="check-row"><input type="checkbox" name="tool" value="${k}" ${d.tools.includes(k) ? 'checked' : ''}> <span><strong>${esc(t.label)}</strong><br><span class="small dim">${esc(t.blurb)}</span></span></label>
              ${d.type === 'harness' ? `<select class="tool-mode" data-tool="${k}" aria-label="${esc(t.label)} permission">
                ${['auto', 'ask', 'off'].map((mode) => `<option value="${mode}" ${(d.harness?.toolModes?.[k] || 'auto') === mode ? 'selected' : ''}>${{ auto: 'Runs automatically', ask: 'Ask me first', off: 'Blocked' }[mode]}</option>`).join('')}
              </select>` : ''}
            </div>`).join('')}
        </div>
        <label class="field narrow"><span>Step limit</span><input id="f-steps" type="number" min="1" max="12" value="${d.maxSteps || 6}"></label>
      </fieldset>` : ''}

      ${d.type === 'harness' ? `
      <fieldset class="fieldset">
        <legend>Harness controls</legend>
        <p class="small dim">The risk tier sets sensible defaults. In a harness you decide each control yourself, and every change is logged.</p>
        <div class="grid grid-2">
          <label class="check-row"><input type="checkbox" id="h-approval" ${d.harness?.approval ? 'checked' : ''}> <span><strong>Human approval</strong><br><span class="small dim">Hold every answer until a person approves it</span></span></label>
          <label class="check-row"><input type="checkbox" id="h-fulllog" ${d.harness?.fullLog ? 'checked' : ''}> <span><strong>Full record-keeping</strong><br><span class="small dim">Keep prompts and answers in the audit log</span></span></label>
          <label class="check-row"><input type="checkbox" id="h-label" ${d.harness?.aiLabel ? 'checked' : ''}> <span><strong>AI-generated label</strong><br><span class="small dim">Mark every answer as AI-generated</span></span></label>
          <label class="check-row"><input type="checkbox" id="h-review" ${d.harness?.review !== false ? 'checked' : ''}> <span><strong>Independent review</strong><br><span class="small dim">The reviewer model checks every draft against the rules</span></span></label>
          <label class="check-row"><input type="checkbox" id="h-retry" ${d.harness?.retry !== false ? 'checked' : ''}> <span><strong>Revise on review failure</strong><br><span class="small dim">One revision on the strong model when the reviewer finds issues</span></span></label>
          ${Object.entries(SAFEGUARD_LIBRARY).map(([k, s]) => `
            <label class="check-row"><input type="checkbox" name="safeguard" value="${k}" ${d.chosenSafeguards?.includes(k) ? 'checked' : ''}> <span><strong>${esc(s.label)}</strong><br><span class="small dim">${esc(s.detail)}</span></span></label>`).join('')}
        </div>
      </fieldset>` : ''}

      <div class="form-actions">
        <a class="btn btn-ghost" href="${d.id ? `#/b/${d.id}` : '#/start'}">Cancel</a>
        <button type="submit" class="btn btn-primary">Check risk and save</button>
      </div>
    </form>
  </div>`);
}

function readEditor() {
  const d = draft;
  d.name = $('#f-name').value.trim();
  d.type = $('#f-type').value;
  if ($('#f-model')) d.modelId = $('#f-model').value;
  if (document.querySelector('[data-role]')) {
    d.models = {};
    document.querySelectorAll('select[data-role]').forEach((sel) => { d.models[sel.dataset.role] = sel.value; });
    d.routing = $('#f-routing')?.checked ?? true;
    if (d.models.strong) d.modelId = d.models.strong;
  }
  d.purpose = $('#f-purpose').value.trim();
  d.usedBy = $('#f-usedby').value;
  d.instructions = $('#f-instructions').value.trim();
  d.starters = $('#f-starters').value.split('\n').map((s) => s.trim()).filter(Boolean);
  d.knowledge = $('#f-knowledge').value.trim();
  d.useDocs = $('#f-docs')?.checked ?? d.useDocs;
  d.protectedTerms = $('#f-terms').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (d.type !== 'chatbot') {
    d.tools = [...document.querySelectorAll('input[name="tool"]:checked')].map((i) => i.value);
    d.maxSteps = Math.min(12, Math.max(1, Number($('#f-steps')?.value) || 6));
  } else {
    d.tools = [];
  }
  if (d.type === 'harness') {
    d.harness = d.harness || {};
    d.harness.approval = $('#h-approval')?.checked ?? false;
    d.harness.fullLog = $('#h-fulllog')?.checked ?? true;
    d.harness.aiLabel = $('#h-label')?.checked ?? false;
    d.harness.review = $('#h-review')?.checked ?? true;
    d.harness.retry = $('#h-retry')?.checked ?? true;
    d.harness.toolModes = {};
    document.querySelectorAll('.tool-mode').forEach((s) => { d.harness.toolModes[s.dataset.tool] = s.value; });
    d.chosenSafeguards = [...document.querySelectorAll('input[name="safeguard"]:checked')].map((i) => i.value);
  }
}

/** Turn the harness safeguard choices into concrete safeguard rules. */
function compileSafeguards(d) {
  if (d.type !== 'harness' || !d.chosenSafeguards) return d.safeguards || {};
  const sg = {};
  const chosen = d.chosenSafeguards || [];
  if (chosen.includes('blindScreening')) {
    const t = tmpl('candidate-screener').safeguards;
    sg.extraRedaction = t.extraRedaction;
    sg.extraRedactionTitle = t.extraRedactionTitle;
    sg.extraRedactionDetail = t.extraRedactionDetail;
  }
  if (chosen.includes('redFlagStop')) sg.redFlagStop = tmpl('symptom-guide').safeguards.redFlagStop;
  if (chosen.includes('citationCheck')) sg.citationCheck = true;
  const forbid = [];
  if (chosen.includes('noReject')) forbid.push(...tmpl('candidate-screener').safeguards.forbidOutput);
  if (chosen.includes('noFinalDecision')) forbid.push(...tmpl('loan-checker').safeguards.forbidOutput);
  if (forbid.length) sg.forbidOutput = forbid;
  return sg;
}

// Risk review dialog
async function openRiskReview() {
  const d = draft;
  const dlg = $('#dialog');
  const t = d.templateKey && tmpl(d.templateKey);
  const ctx = t?.tierByContext?.[d.usedBy];
  const fromTemplate = t && (d.usedBy === t.usedBy ? { tier: t.tier, basis: t.basis, rationale: t.rationale } : ctx);

  dlg.innerHTML = `<div class="dialog-body"><h2>Risk tier</h2><p class="dim">Asking ${esc(modelById(d.modelId).name)} to classify <strong>${esc(d.name)}</strong> under the EU AI Act…</p><div class="spinner" aria-hidden="true"></div></div>`;
  dlg.showModal();

  let proposal;
  let error = '';
  if (fromTemplate) {
    proposal = { ...fromTemplate, source: 'Template rule' };
  } else {
    try {
      proposal = { ...(await classify(d)), source: `Proposed by ${modelById(d.modelId).name}` };
    } catch (err) {
      error = err.hint || err.message;
      proposal = { tier: d.tier || 'minimal', basis: d.basis || '', rationale: '', source: 'Set manually' };
    }
  }

  dlg.innerHTML = `
    <form method="dialog" class="dialog-body" id="risk-form">
      <h2>Confirm the risk tier</h2>
      ${error ? `<p class="notice warn-bg small">Automatic classification failed: ${esc(error)} Choose the tier yourself.</p>` : ''}
      <div class="risk-proposal">
        <div class="row between">${tierPlate(proposal.tier, proposal.basis)}<span class="mono tiny dim">${esc(proposal.source)}</span></div>
        ${proposal.rationale ? `<p>${esc(proposal.rationale)}</p>` : ''}
      </div>
      <label class="field"><span>Confirmed tier</span>
        <select id="r-tier">${Object.entries(TIERS).map(([k, v]) => `<option value="${k}" ${proposal.tier === k ? 'selected' : ''}>${v.label}: ${esc(v.summary)}</option>`).join('')}</select></label>
      <label class="field"><span>Legal basis</span><input id="r-basis" value="${esc(proposal.basis)}"></label>
      <p class="small dim" id="r-note"></p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" data-action="close-dialog">Back to editing</button>
        <button type="button" class="btn btn-primary" data-action="confirm-save">Confirm and save</button>
      </div>
    </form>`;
  const sync = () => {
    const blocked = $('#r-tier').value === 'prohibited';
    $('[data-action="confirm-save"]').disabled = blocked;
    $('#r-note').textContent = blocked
      ? 'Prohibited practices cannot be deployed under Art. 5, so Berth will not save this build.'
      : $('#r-tier').value !== proposal.tier ? 'You are overriding the proposed tier. The override is recorded in the audit log.' : '';
  };
  $('#r-tier').addEventListener('change', sync);
  sync();
  draft._proposal = proposal;
  if (proposal.tier === 'prohibited') {
    audit({ event: 'Build refused', build: d.name, type: d.type, tier: 'prohibited', model: d.modelId, outcome: 'blocked', actor: 'Berth', detail: proposal.rationale });
  }
}

function confirmSave() {
  const d = draft;
  const tier = $('#r-tier').value;
  const basis = $('#r-basis').value.trim();
  const proposal = d._proposal;
  const overridden = tier !== proposal.tier;
  const build = {
    ...d,
    tier,
    basis,
    rationale: overridden ? `Tier set by a person, overriding the proposed ${TIERS[proposal.tier].label}.` : proposal.rationale,
    tierConfirmedBy: overridden ? 'Admin override' : `Admin confirmed (${proposal.source})`,
    safeguards: compileSafeguards(d),
    id: d.id || uid(),
    createdAt: d.createdAt || new Date().toISOString(),
  };
  delete build._proposal;
  const i = state.builds.findIndex((b) => b.id === build.id);
  if (i >= 0) state.builds[i] = build; else state.builds.push(build);
  audit({
    event: d.id ? 'Build updated' : 'Build created', build: build.name, type: build.type, tier, model: build.modelId,
    outcome: overridden ? 'tier overridden' : 'tier confirmed', actor: 'Admin', detail: `${basis}${overridden ? ` (proposed ${proposal.tier})` : ''}`,
  });
  save();
  $('#dialog').close();
  location.hash = `#/b/${build.id}`;
}

// ---------------------------------------------------------------------------
// Run screen

const run = { controller: null, busy: false, pendingTool: null };

function chatOf(id) {
  if (!state.chats[id]) state.chats[id] = [];
  return state.chats[id];
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

function messageHtml(msg, i, build, isLast) {
  if (msg.role === 'user') {
    const counts = summarise(msg.findings || []);
    return `
    <div class="msg msg-user">
      ${msg.findings?.length ? `<div class="redact-note">${shieldIcon()} ${esc(describeCounts(counts))} removed before sending</div>` : ''}
      <div class="bubble">${highlightTokens(msg.sent ?? msg.content)}</div>
    </div>`;
  }
  if (msg.role === 'system') {
    return `<div class="msg msg-system status-${msg.status}"><div class="sys-card">${msg.status === 'stopped' ? alertIcon() : shieldIcon()}<div>${esc(msg.content)}</div></div></div>`;
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
    ${msg.sources?.length && msg.status !== 'streaming' ? `<details class="sources"><summary class="small">${msg.sources.length} source${msg.sources.length > 1 ? 's' : ''} used</summary><ol>${msg.sources.map((x) => `<li><span class="small"><strong>${esc(x.document_name)}</strong> <span class="mono tiny dim">passage ${x.idx + 1} · ${Math.round(x.similarity * 100)}%</span></span><span class="small dim">${esc(x.content.slice(0, 220))}${x.content.length > 220 ? '…' : ''}</span></li>`).join('')}</ol></details>` : ''}
    ${msg.review?.issues?.length ? `<div class="review ${msg.review.verdict === 'pass' ? 'review-pass' : ''}"><span class="mono tiny">REVIEWER · ${esc(modelById(build.models?.reviewer)?.name || '')}</span><ul>${msg.review.issues.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${msg.notes?.length ? `<div class="notes">${msg.notes.map((n) => `<div class="note note-${n.level}">${esc(n.text)}</div>`).join('')}</div>` : ''}
    ${held ? `
      <div class="hold-bar" role="status">
        ${clockIcon()}<span><strong>Held for human review.</strong> Copy unlocks after approval.</span>
        <button type="button" class="btn btn-small btn-quiet-danger" data-action="reject" data-index="${i}">Reject</button>
        <button type="button" class="btn btn-small btn-dark" data-action="approve" data-index="${i}">Approve</button>
      </div>` : ''}
    ${msg.status === 'approved' ? '<div class="mono tiny ok">Approved by reviewer</div>' : ''}
    ${msg.status === 'rejected' ? '<div class="mono tiny danger">Rejected by reviewer. Not for use.</div>' : ''}
    ${msg.status === 'error' ? `<div class="note note-block">${esc(msg.error)}</div>` : ''}
    ${msg.status !== 'streaming' ? `<div class="msg-actions">
      <button type="button" class="link-btn" data-action="copy" data-index="${i}" ${held || msg.status === 'rejected' ? 'disabled' : ''}>Copy</button>
      ${isLast ? '<button type="button" class="link-btn" data-action="regenerate">Regenerate</button>' : ''}
      ${msg.auditSeq ? `<span class="mono tiny dim">LOG #${String(msg.auditSeq).padStart(4, '0')}</span>` : ''}
      ${msg.tokens ? `<span class="mono tiny dim">${msg.tokens.toLocaleString()} tokens${msg.estimated ? ' (est.)' : ''}</span>` : ''}
      ${msg.cost != null ? `<span class="mono tiny cost">${formatCost(msg.cost)}${msg.baseline > msg.cost * 1.05 ? ` · strong-only ${formatCost(msg.baseline)} · saved ${Math.round((1 - msg.cost / msg.baseline) * 100)}%` : ''}</span>` : ''}
    </div>` : ''}
  </div>`;
}

function stageStrip(stages) {
  return `<div class="stages">${stages.map((st, i) => `
    ${i ? '<span class="parrow" aria-hidden="true">→</span>' : ''}
    <span class="stage stage-${st.role} ${st.status === 'running' ? 'is-running' : ''}">
      <span class="stage-top"><span class="mono tiny">${esc(st.stage.toUpperCase())}</span><strong>${esc(st.label || modelById(st.modelId)?.name || '')}</strong></span>
      <span class="tiny dim">${st.status === 'running' ? 'working…' : esc(st.note || (st.usage ? `${(st.usage.in + st.usage.out).toLocaleString()} tok` : ''))}${st.cost ? ` · ${formatCost(st.cost)}` : ''}</span>
    </span>`).join('')}</div>`;
}

function shieldIcon() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>'; }
function clockIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'; }
function alertIcon() { return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 3l10 18H2L12 3z"/><path d="M12 10v4M12 17h.01"/></svg>'; }

function governancePanel(build) {
  const tierOrder = ['minimal', 'limited', 'high', 'prohibited'];
  const trail = state.audit.filter((a) => a.buildId === build.id || a.build === build.name).slice(0, 6);
  return `
  <aside class="aside" aria-label="Governance">
    <div class="eyebrow">Governance for this build</div>
    <div class="tier-card">
      <div class="row between"><span class="tier-name">${esc(TIERS[build.tier].label)} risk</span><span class="mono tiny">${esc(build.tierConfirmedBy || '')}</span></div>
      <p>${esc(build.basis || TIERS[build.tier].summary)}</p>
      ${build.rationale ? `<p class="tier-why">${esc(build.rationale)}</p>` : ''}
      <div class="scale">${tierOrder.map((t) => `<span class="${t === build.tier ? `on on-${t}` : ''}"></span>`).join('')}</div>
      <div class="scale-labels mono">${tierOrder.map((t) => `<span class="${t === build.tier ? 'cur' : ''}">${TIERS[t].label.toUpperCase()}</span>`).join('')}</div>
    </div>
    ${build.type !== 'chatbot' ? `<div class="controls">
      <div class="h-sub">Models</div>
      ${rolesFor(build.type).map((r) => {
        const mid = build.models?.[r];
        const off = r === 'router' && build.routing === false;
        return `<div class="role-line ${off ? 'is-off' : ''}"><span class="small">${esc(ROLES[r].label)}</span><span class="small"><strong>${esc(modelById(mid)?.name || '')}</strong> <span class="mono tiny dim">${hasKey(mid) ? '' : 'no key'}${off ? 'off' : ''}</span></span></div>`;
      }).join('')}
      ${build.type === 'harness' && build.harness?.review !== false && build.models?.reviewer && [build.models.fast, build.models.strong].some((w) => modelById(w)?.maker === modelById(build.models.reviewer)?.maker) ? '<p class="tiny warn">The reviewer shares a vendor with a worker, so the review is less independent.</p>' : ''}
    </div>` : ''}
    <div class="controls">
      <div class="h-sub">Controls in force</div>
      ${describeControls(build).map((c) => `
        <div class="control ${c.on ? '' : 'is-off'}">
          ${c.on ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12l4 4L19 6"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 12h12"/></svg>'}
          <span>${esc(c.title)}<br><span class="small dim">${esc(c.detail)}</span></span>
        </div>`).join('')}
    </div>
    <div class="trail">
      <div class="row between"><span class="h-sub">Audit trail</span><a class="small" href="#/audit">Full log</a></div>
      ${trail.length ? trail.map((a) => `<div class="trail-row"><span class="mono tiny dim">${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span class="small">${esc(a.event)}${a.outcome ? ` · ${esc(a.outcome)}` : ''}</span></div>`).join('') : '<p class="small dim">No activity yet.</p>'}
    </div>
  </aside>`;
}

function renderRun(id) {
  const build = buildById(id);
  if (!build) { location.hash = '#/'; return; }
  const chat = chatOf(id);
  const m = modelById(build.modelId);
  const t = build.templateKey && tmpl(build.templateKey);
  const lastAssistant = chat.map((x) => x.role).lastIndexOf('assistant');

  shell(id, `
  <div class="run">
    <header class="run-head">
      <div class="run-title">
        <h1>${esc(build.name)}</h1>
        <span class="small dim">${esc(TYPES[build.type].label)} · ${esc(build.purpose || '')}</span>
      </div>
      ${tierPlate(build.tier, build.basis?.split('·')[0]?.trim())}
      <div class="run-tools">
        <label class="inline-select"><span class="small dim">Used by</span>
          <select id="run-usedby">${USED_BY.map((u) => `<option ${build.usedBy === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
        ${build.type === 'chatbot' ? `<label class="inline-select"><span class="small dim">Model</span>
          <select id="run-model">${MODELS.filter((x) => state.policy.allowedModels.includes(x.id)).map((x) => `<option value="${x.id}" ${x.id === build.modelId ? 'selected' : ''}>${esc(x.name)} · ${esc(provenance(x))}</option>`).join('')}</select></label>` : ''}
        <a class="btn btn-small btn-outline" href="#/edit/${build.id}">Edit</a>
      </div>
    </header>
    <div class="messages" id="messages">
      ${chat.length ? chat.map((msg, i) => messageHtml(msg, i, build, i === lastAssistant)).join('') : `
        <div class="empty">
          <h2>${esc(build.name)}</h2>
          <p class="dim">${esc(build.purpose || '')}</p>
          <div class="starters">${(build.starters || []).map((s) => `<button type="button" class="starter" data-action="starter">${esc(s)}</button>`).join('')}</div>
          ${t?.tierByContext ? `<p class="small hint">Try changing <strong>Used by</strong> to <em>${esc(Object.keys(t.tierByContext)[0])}</em> and watch the risk tier change.</p>` : ''}
        </div>`}
      <div id="tool-approval"></div>
    </div>
    <div class="composer-wrap">
      <form class="composer" id="composer">
        <label for="prompt" class="sr-only">Message</label>
        <textarea id="prompt" rows="2" placeholder="Message ${esc(build.name)}…"></textarea>
        <div class="composer-row">
          <span class="small preview" id="preview">${shieldIcon()} Personal data is removed before sending</span>
          ${run.busy ? '<button type="button" class="btn btn-small btn-outline" data-action="stop">Stop</button>' : ''}
          <button type="submit" class="send" aria-label="Send" ${run.busy ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          </button>
        </div>
      </form>
      <div class="mono tiny dim composer-foot">${build.type === 'chatbot'
        ? `${esc(m.name)} · ${esc(provenance(m))} · ${hasKey(m.id) ? 'key set' : '<a href="#/settings">add API key</a>'}`
        : `${modelsUsed(build).map((id) => esc(modelById(id).name)).join(' · ')} · ${modelsUsed(build).every(hasKey) ? 'keys set' : '<a href="#/settings">add missing API keys</a>'}`}</div>
    </div>
  </div>`, governancePanel(build));

  const box = $('#messages');
  box.scrollTop = box.scrollHeight;
  $('#prompt')?.focus();
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
  if (!text.trim()) { el.innerHTML = `${shieldIcon()} Personal data is removed before sending`; el.className = 'small preview'; return; }
  const policy = checkPolicy(text, build.modelId);
  if (!policy.ok) { el.innerHTML = `${alertIcon()} ${esc(policy.reason)}`; el.className = 'small preview is-block'; return; }
  const { findings } = redact(text, extrasFor(build));
  el.innerHTML = findings.length
    ? `${shieldIcon()} ${esc(describeCounts(summarise(findings)))} will be removed before sending`
    : `${shieldIcon()} Nothing to remove`;
  el.className = `small preview ${findings.length ? 'is-active' : ''}`;
}

function askToolPermission(build, call) {
  return new Promise((resolveP, rejectP) => {
    const el = $('#tool-approval');
    const [key, tool] = toolByFunctionName(call.name) || [];
    el.innerHTML = `
      <div class="tool-ask" role="alertdialog" aria-label="Tool permission">
        ${shieldIcon()}<span><strong>${esc(build.name)} wants to use ${esc(tool?.label || call.name)}.</strong><br><span class="mono tiny">${esc(JSON.stringify(call.args))}</span></span>
        <button type="button" class="btn btn-small btn-outline" data-tool-answer="deny">Deny</button>
        <button type="button" class="btn btn-small btn-dark" data-tool-answer="allow">Allow</button>
      </div>`;
    $('#messages').scrollTop = $('#messages').scrollHeight;
    el.querySelectorAll('[data-tool-answer]').forEach((b) => b.addEventListener('click', () => {
      el.innerHTML = '';
      const allowed = b.dataset.toolAnswer === 'allow';
      audit({ event: 'Tool permission', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: allowed ? 'allowed' : 'denied', actor: 'User', detail: `${key}: ${JSON.stringify(call.args)}` });
      if (allowed) resolveP(); else rejectP(new Error('The user denied permission for this tool call.'));
    }));
  });
}

async function send(build, text, { regenerate = false } = {}) {
  if (run.busy) return;
  const chat = chatOf(build.id);
  const c = controlsFor(build);

  if (!regenerate) {
    const blockedModel = modelsUsed(build).find((id) => !state.policy.allowedModels.includes(id));
    const policy = checkPolicy(text, blockedModel || build.modelId);
    if (!policy.ok) {
      chat.push({ role: 'system', status: 'blocked', content: `Not sent. ${policy.reason}` });
      audit({ event: 'Message blocked', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: 'blocked by policy', actor: 'Berth', detail: policy.reason });
      save(); refreshMessages(build); return;
    }
    const guard = preSend(text, c);
    if (guard.stop) {
      chat.push({ role: 'system', status: 'stopped', content: guard.message });
      audit({ event: 'Emergency stop', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: 'not sent', actor: 'Berth', detail: guard.reason });
      save(); refreshMessages(build); return;
    }
    const { text: sent, findings } = redact(text, extrasFor(build));
    // Only the redacted text is kept. The original never leaves the composer.
    chat.push({ role: 'user', sent, findings: findings.map(({ type, token }) => ({ type, token })), at: new Date().toISOString() });
  }

  const history = chat
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.status !== 'error' && m.status !== 'rejected')
    .map((m) => ({ role: m.role, content: m.role === 'user' ? m.sent : m.content }));
  const lastUser = [...chat].reverse().find((m) => m.role === 'user');

  const reply = { role: 'assistant', content: '', status: 'streaming', modelId: build.modelId, at: new Date().toISOString(), steps: [] };
  chat.push(reply);
  run.busy = true;
  run.controller = new AbortController();
  renderRun(build.id);

  const toolNames = build.type === 'chatbot' ? [] : [...new Set([...(build.tools || []), ...(build.useDocs && currentStatus().retrieval ? ['documents'] : [])])]
    .filter((k) => build.harness?.toolModes?.[k] !== 'off');
  reply.sources = [];
  const retrieve = async (q) => {
    const r = await docsApi.search(q, 5);
    reply.sources.push(...r);
    return r;
  };
  let result;
  let pending = 0;
  const paint = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const el = document.querySelector(`.msg-assistant[data-index="${chat.indexOf(reply)}"] .answer`);
      if (el) el.innerHTML = reply.content ? renderMarkdown(reply.content) : '<span class="thinking">Thinking…</span>';
      const box = $('#messages'); if (box) box.scrollTop = box.scrollHeight;
    });
  };
  try {
    result = await execute(build, {
      system: systemPrompt(build),
      history,
      tools: toolDefs(toolNames),
      rulesText: describeControls(build).filter((x) => x.on).map((x) => `- ${x.title}: ${x.detail}`).join('\n'),
      signal: run.controller.signal,
      retrieve: currentStatus().retrieval ? retrieve : null,
      onText: (t) => { reply.content = t; paint(); },
      onStage: (stages) => { reply.stages = stages.map((st) => ({ ...st })); refreshMessages(build); },
      onToolCall: async (call) => {
        const [key, tool] = toolByFunctionName(call.name) || [];
        if (!tool || !toolNames.includes(key)) throw new Error(`Tool ${call.name} is not available to this build.`);
        if (build.type === 'harness' && build.harness?.toolModes?.[key] === 'ask') await askToolPermission(build, call);
        const out = await tool.run(call.args || {}, build, {
          sourceCount: () => reply.sources.length,
          onSources: (r) => { reply.sources.push(...r); },
        });
        reply.steps.push({ name: tool.label, summary: tool.describe(call.args || {}, out) });
        refreshMessages(build);
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
    event: regenerate ? 'Answer regenerated' : 'Message sent',
    buildId: build.id,
    build: build.name,
    type: build.type,
    tier: build.tier,
    model: stages.length ? stages.map((st) => `${st.stage}:${st.modelId}`).join(' > ') : build.modelId,
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
  renderRun(build.id);
}

function review(build, index, approved) {
  const msg = chatOf(build.id)[index];
  if (!msg) return;
  msg.status = approved ? 'approved' : 'rejected';
  audit({ event: approved ? 'Answer approved' : 'Answer rejected', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: msg.status, actor: 'Reviewer', detail: `LOG #${msg.auditSeq}` });
  save();
  renderRun(build.id);
}

function changeUsedBy(build, usedBy) {
  const before = build.tier;
  build.usedBy = usedBy;
  const t = build.templateKey && tmpl(build.templateKey);
  let next = null;
  if (t) next = usedBy === t.usedBy ? { tier: t.tier, basis: t.basis, rationale: t.rationale } : t.tierByContext?.[usedBy];
  if (next) {
    Object.assign(build, next, { tierConfirmedBy: 'Template rule' });
    audit({ event: 'Deployment context changed', buildId: build.id, build: build.name, type: build.type, tier: build.tier, model: build.modelId, outcome: before === build.tier ? 'tier unchanged' : `tier ${before} → ${build.tier}`, actor: 'Admin', detail: `Used by: ${usedBy}` });
    save();
    renderRun(build.id);
    if (before !== build.tier) toast(`Risk tier changed to ${TIERS[build.tier].label}. Controls updated.`);
  } else {
    save();
    draft = structuredClone(build);
    openRiskReview();
  }
}

// ---------------------------------------------------------------------------
// Audit, policy, settings

function renderAudit() {
  const rows = state.audit;
  shell('audit', `
  <div class="page">
    <header class="page-head row between wrap">
      <div><h1>Audit log</h1><p class="lede">Every request, block, approval and tier decision. Prompt text is kept only for high-risk builds or where a harness asks for it.</p></div>
      <div class="row gap8">
        <button type="button" class="btn btn-outline" data-action="export-csv" ${rows.length ? '' : 'disabled'}>Export CSV</button>
        <button type="button" class="btn btn-outline" data-action="export-json" ${rows.length ? '' : 'disabled'}>Export JSON</button>
      </div>
    </header>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>#</th><th>Time</th><th>Event</th><th>Build</th><th>Tier</th><th>Models</th><th>Outcome</th><th>Redactions</th><th>Tokens</th><th>Cost</th></tr></thead>
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
          </tr>`).join('') : '<tr><td colspan="10" class="dim">No activity yet. Open a build and send a message.</td></tr>'}</tbody>
      </table>
    </div>
    <p class="small dim">Tokens are as reported by each provider, or estimated at about four characters per token for streamed answers. Costs use the price estimates in Settings. Hover a row for details.</p>
  </div>`);
}

function renderPolicy() {
  const p = state.policy;
  shell('policy', `
  <div class="page narrow-page">
    <header class="page-head"><h1>Governance policy</h1><p class="lede">Workspace rules that apply to every build, before any build-specific safeguard.</p></header>
    <form id="policy" class="form">
      <fieldset class="fieldset"><legend>Allowed models</legend>
        <div class="grid grid-2">${MODELS.map((m) => `<label class="check-row"><input type="checkbox" name="allowed" value="${m.id}" ${p.allowedModels.includes(m.id) ? 'checked' : ''}> <span><strong>${esc(m.name)}</strong> <span class="mono tiny dim">${esc(m.maker)} · ${esc(provenance(m))}</span></span></label>`).join('')}</div>
      </fieldset>
      <fieldset class="fieldset"><legend>Personal data removed before sending</legend>
        <div class="grid grid-2">${Object.entries(PII_TYPES).map(([k, v]) => `<label class="check-row"><input type="checkbox" name="redact" value="${k}" ${p.redact[k] ? 'checked' : ''}> <span>${esc(v)}</span></label>`).join('')}</div>
      </fieldset>
      <label class="field"><span>Blocked terms <em class="dim">one per line; messages containing them are not sent</em></span><textarea id="p-blocked" rows="4">${esc(p.blockedTerms.join('\n'))}</textarea></label>
      <div class="form-actions"><button type="submit" class="btn btn-primary">Save policy</button></div>
    </form>
  </div>`);
}

function renderSettings() {
  const byProvider = (prov) => MODELS.filter((m) => m.provider === prov);
  shell('settings', `
  <div class="page narrow-page">
    <header class="page-head"><h1>Settings &amp; API keys</h1>
      <p class="lede">Keys are saved in this browser's local storage and sent only to their own provider. Berth has no server. On a shared computer, clear them when you finish.</p></header>
    <form id="settings" class="form">
      ${Object.entries(PROVIDERS).map(([prov, p]) => {
        const models = prov === 'openrouter' ? MODELS.filter((m) => m.provider === 'openrouter') : byProvider(prov);
        return `
        <fieldset class="fieldset">
          <legend>${esc(p.label)}</legend>
          <label class="field"><span>${esc(p.keyLabel)} <a class="small" href="${p.docs}" target="_blank" rel="noopener">Get a key</a></span>
            <input type="password" autocomplete="off" spellcheck="false" data-key="${prov}" value="${esc(state.keys[prov])}" placeholder="${esc(p.keyHint)}"></label>
          ${models.map((m) => `
            <label class="field"><span>${esc(m.name)} model id</span>
              <input list="list-${prov}" data-model-id="${m.id}" value="${esc(state.modelIds[m.id] || m.defaultModel)}"></label>`).join('')}
          ${prov === 'openrouter' ? `<label class="field"><span>Grok via OpenRouter model id</span><input list="list-openrouter" data-model-id="grok@openrouter" value="${esc(state.modelIds['grok@openrouter'] || modelById('grok').openrouterModel)}"></label>` : ''}
          ${prov === 'xai' ? `<label class="field"><span>Grok route</span><select id="grok-route">
              <option value="direct" ${state.grokRoute === 'direct' ? 'selected' : ''}>Direct to xAI</option>
              <option value="openrouter" ${state.grokRoute === 'openrouter' ? 'selected' : ''}>Through OpenRouter</option></select></label>` : ''}
          <datalist id="list-${prov}"></datalist>
          <button type="button" class="btn btn-small btn-outline" data-action="load-models" data-provider="${prov}">Load available models</button>
          <span class="small dim" id="load-${prov}"></span>
        </fieldset>`;
      }).join('')}
      <fieldset class="fieldset">
        <legend>Price estimates</legend>
        <p class="small dim">US dollars per million tokens, used to show the cost of each answer and the saving from routing. Check your provider's current pricing and adjust.</p>
        <div class="price-grid">
          <span class="tiny dim">Model</span><span class="tiny dim">Input</span><span class="tiny dim">Output</span>
          ${MODELS.map((m) => {
            const p = priceOf(m.id);
            return `<span class="small"><strong>${esc(m.name)}</strong></span>
              <input type="number" step="0.01" min="0" data-price="${m.id}" data-dir="in" value="${p.in}" aria-label="${esc(m.name)} input price">
              <input type="number" step="0.01" min="0" data-price="${m.id}" data-dir="out" value="${p.out}" aria-label="${esc(m.name)} output price">`;
          }).join('')}
        </div>
      </fieldset>
      <div class="form-actions">
        <button type="button" class="btn btn-quiet-danger" data-action="reset">Clear all Berth data</button>
        <button type="submit" class="btn btn-primary">Save settings</button>
      </div>
    </form>
  </div>`);
}

// ---------------------------------------------------------------------------
// Router

function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [page, id] = path.split('/');
  if (page === 'start') {
    const t = new URLSearchParams(query).get('type');
    if (t && TYPES[t] && pick.type !== t) setPickType(t);
    return renderStart();
  }
  if (page === 'b' && id) return renderRun(id);
  if (page === 'edit' && id) {
    const b = buildById(id);
    if (!b) { location.hash = '#/'; return; }
    draft = structuredClone(b);
    if (draft.type === 'harness' && !draft.chosenSafeguards) draft.chosenSafeguards = [];
    return renderEditor();
  }
  if (page === 'new') {
    if (!draft) { location.hash = '#/'; return; }
    return renderEditor();
  }
  if (page === 'how') return renderHow(id);
  if (page === 'knowledge') return renderKnowledge();
  if (page === 'audit') return renderAudit();
  if (page === 'policy') return renderPolicy();
  if (page === 'settings') return renderSettings();
  return renderLanding();
}

function setPickType(type) {
  pick.type = type;
  if (type !== 'chatbot') {
    const base = defaultModels(type, pick.models.strong || 'claude');
    pick.models = { ...base, ...pick.models };
    if (type === 'harness' && !pick.models.reviewer) pick.models.reviewer = base.reviewer;
  }
}

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------------------
// Events

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const currentBuild = () => buildById(location.hash.split('/')[2]);

  switch (action) {
    case 'pick-model': pick.modelId = el.dataset.id; renderStart(); break;
    case 'pick-type': setPickType(el.dataset.id); renderStart(); break;
    case 'continue':
      draft = newDraft(pick.type, pick.modelId, pick.models);
      location.hash = '#/new';
      break;
    case 'close-dialog': $('#dialog').close(); break;
    case 'confirm-save': confirmSave(); break;
    case 'starter': {
      const b = currentBuild();
      if (b) send(b, el.textContent.trim());
      break;
    }
    case 'stop': run.controller?.abort(); break;
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
        toast('Indexed. Your builds can now search it.');
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
    case 'approve': review(currentBuild(), Number(el.dataset.index), true); break;
    case 'reject': review(currentBuild(), Number(el.dataset.index), false); break;
    case 'regenerate': {
      const b = currentBuild();
      const chat = chatOf(b.id);
      if (chat[chat.length - 1]?.role === 'assistant') chat.pop();
      send(b, '', { regenerate: true });
      break;
    }
    case 'copy': {
      const b = currentBuild();
      const msg = chatOf(b.id)[Number(el.dataset.index)];
      try { await navigator.clipboard.writeText(msg.content); toast('Copied'); } catch { toast('Copy failed. Select the text instead.'); }
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
    case 'reset': {
      el.textContent = 'Click again to clear everything';
      el.dataset.action = 'reset-confirm';
      break;
    }
    case 'reset-confirm': resetAll(); break;
    default: break;
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
  if (form.id === 'editor') {
    readEditor();
    if (!draft.name) { $('#f-name').focus(); toast('Give the build a name.'); return; }
    if (!draft.purpose) { $('#f-purpose').focus(); toast('Say what the build is for. Its risk tier depends on it.'); return; }
    openRiskReview();
  }
  if (form.id === 'composer') {
    const b = buildById(location.hash.split('/')[2]);
    const text = $('#prompt').value.trim();
    if (b && text) send(b, text);
  }
  if (form.id === 'policy') {
    state.policy.allowedModels = [...form.querySelectorAll('input[name="allowed"]:checked')].map((i) => i.value);
    Object.keys(state.policy.redact).forEach((k) => { state.policy.redact[k] = Boolean(form.querySelector(`input[name="redact"][value="${k}"]`)?.checked); });
    state.policy.blockedTerms = $('#p-blocked').value.split('\n').map((s) => s.trim()).filter(Boolean);
    audit({ event: 'Policy updated', outcome: 'saved', actor: 'Admin', detail: `allowed: ${state.policy.allowedModels.join(', ')}` });
    save();
    toast('Policy saved');
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

document.addEventListener('input', (e) => {
  if (e.target.id === 'prompt') {
    const b = buildById(location.hash.split('/')[2]);
    if (b) updatePreview(b);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'prompt' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'kb-file' && e.target.files?.[0]) {
    const f = e.target.files[0];
    kb.busy = 'Reading file…';
    extractText(f).then((t) => { kb.busy = ''; stageDocument(f.name, t); })
      .catch((err) => { kb.busy = ''; kb.error = err.message; renderKnowledge(); });
    return;
  }
  if (e.target.id === 'how-select') { location.hash = `#/how/${e.target.value}`; return; }
  if (e.target.matches('select[data-role]') && e.target.id.startsWith('start-')) {
    pick.models[e.target.dataset.role] = e.target.value;
    renderStart();
    return;
  }
  const b = buildById(location.hash.split('/')[2]);
  if (e.target.id === 'run-usedby' && b) changeUsedBy(b, e.target.value);
  if (e.target.id === 'run-model' && b) {
    const from = b.modelId;
    b.modelId = e.target.value;
    audit({ event: 'Model changed', buildId: b.id, build: b.name, type: b.type, tier: b.tier, model: b.modelId, outcome: `${from} → ${b.modelId}`, actor: 'User' });
    save();
    renderRun(b.id);
  }
  if (e.target.id === 'f-type' && draft) {
    readEditor();
    draft.type = e.target.value;
    if (draft.type !== 'chatbot' && !draft.tools.length) draft.tools = ['calculator', 'knowledge'];
    if (draft.type === 'harness' && !draft.harness) draft.harness = { approval: false, fullLog: true, aiLabel: false, review: true, retry: true, toolModes: {} };
    if (draft.type !== 'chatbot') {
      const base = defaultModels(draft.type, draft.modelId);
      draft.models = { ...base, ...(draft.models || {}) };
    }
    renderEditor();
  }
});

loadStatus().then(() => route());
route();
