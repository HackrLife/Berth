// Berth: UI, routing and the send pipeline.

import { MODELS, PROVIDERS, modelById, provenance } from './models.js';
import { state, save, uid, resetAll } from './store.js';
import { runTurn, listModels, hasKey, resolve } from './providers.js';
import {
  redact, checkPolicy, preSend, checkOutput, audit, estimateTokens, summarise, describeCounts, auditToCsv, PII_TYPES,
} from './governance.js';
import { TIERS, USED_BY, controlsFor, describeControls, classify } from './risk.js';
import { TOOLS, toolDefs, toolByFunctionName } from './tools.js';
import { TEMPLATES } from './templates.js';

// ---------------------------------------------------------------------------
// Helpers

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const app = () => $('#app');

const TYPES = {
  chatbot: {
    label: 'Chatbot',
    line: 'Answers questions from instructions and reference text.',
    parts: ['Instructions', 'Starter prompts', 'Reference text'],
  },
  agent: {
    label: 'Agent',
    line: 'Plans and uses tools to complete a task in several steps.',
    parts: ['Everything in a chatbot', 'Tools', 'Step limit'],
  },
  harness: {
    label: 'Harness',
    line: 'Wraps an agent in controls you set: tool permissions, approval gates and output checks.',
    parts: ['Everything in an agent', 'Per-tool permissions', 'Safeguards you choose'],
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
  return { ok: true, text: 'Ready' };
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

function rail(active) {
  const builds = state.builds.map((b) => `
    <a class="rail-link ${active === b.id ? 'is-active' : ''}" href="#/b/${b.id}">
      <span class="dot dot-${b.tier}"></span><span class="rail-name">${esc(b.name)}</span>
      <span class="rail-type">${esc(TYPES[b.type].label)}</span>
    </a>`).join('');
  return `
  <nav class="rail" aria-label="Workspace">
    <a class="brand" href="#/"><span class="brand-word">Berth</span><span class="mono dim">v0.1</span></a>
    <a class="btn btn-outline rail-new" href="#/">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      New build
    </a>
    <div class="rail-group">
      <div class="eyebrow">Your builds</div>
      ${builds || '<p class="dim small pad8">Nothing built yet.</p>'}
    </div>
    <div class="rail-foot">
      <a class="rail-link ${active === 'policy' ? 'is-active' : ''}" href="#/policy">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>Governance policy</a>
      <a class="rail-link ${active === 'audit' ? 'is-active' : ''}" href="#/audit">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>Audit log<span class="mono dim push">${state.audit.length}</span></a>
      <a class="rail-link ${active === 'settings' ? 'is-active' : ''}" href="#/settings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>Settings &amp; API keys</a>
    </div>
  </nav>`;
}

function shell(active, main, aside = '') {
  app().innerHTML = `<div class="shell ${aside ? 'has-aside' : ''}">${rail(active)}<main class="main">${main}</main>${aside}</div>`;
}

// ---------------------------------------------------------------------------
// Home: choose a model, choose what to build

const pick = { modelId: null, type: null };

function modelCard(m) {
  const s = modelStatus(m);
  const sel = pick.modelId === m.id;
  return `
    <button type="button" class="card model-card ${sel ? 'is-selected' : ''} ${s.ok ? '' : 'is-muted'}" data-action="pick-model" data-id="${m.id}" aria-pressed="${sel}">
      <span class="row between"><span class="model-name">${esc(m.name)}</span><span class="check" aria-hidden="true"></span></span>
      <span class="small dim">${esc(m.maker)}</span>
      <span class="mono tiny tag">${esc(provenance(m))}</span>
      <span class="small ${s.ok ? 'ok' : 'warn'}">${esc(s.text)}</span>
    </button>`;
}

function typeCard(key) {
  const t = TYPES[key];
  const sel = pick.type === key;
  return `
    <button type="button" class="card type-card ${sel ? 'is-selected' : ''}" data-action="pick-type" data-id="${key}" aria-pressed="${sel}">
      <span class="row between"><span class="type-name">${t.label}</span><span class="check" aria-hidden="true"></span></span>
      <span class="type-line">${esc(t.line)}</span>
      <span class="type-parts">${t.parts.map((p) => `<span>${esc(p)}</span>`).join('')}</span>
    </button>`;
}

function renderHome() {
  const anyKey = Object.values(state.keys).some(Boolean);
  const closed = MODELS.filter((m) => m.weights === 'closed');
  const open = MODELS.filter((m) => m.weights === 'open');
  const ready = pick.modelId && pick.type;
  const m = pick.modelId && modelById(pick.modelId);

  shell('home', `
  <div class="page home">
    <header class="page-head">
      <h1>What will you build?</h1>
      <p class="lede">Choose a model, then a chatbot, an agent or a harness. Every build is given a risk tier, and the tier decides its controls.</p>
    </header>
    ${anyKey ? '' : `<div class="notice">
      <strong>Add an API key to start.</strong> Keys are stored only in this browser and sent only to their provider.
      <a class="btn btn-small" href="#/settings">Add keys</a></div>`}

    <section class="step">
      <div class="step-head"><span class="step-no mono">1</span><h2>Choose a model</h2></div>
      <div class="group-label">Closed weights</div>
      <div class="grid grid-4">${closed.map(modelCard).join('')}</div>
      <div class="group-label">Open weights <span class="dim">· through OpenRouter</span></div>
      <div class="grid grid-4">${open.map(modelCard).join('')}</div>
    </section>

    <section class="step">
      <div class="step-head"><span class="step-no mono">2</span><h2>Choose what to build</h2></div>
      <div class="grid grid-3">${Object.keys(TYPES).map(typeCard).join('')}</div>
    </section>

    <div class="continue-bar">
      <span class="small">${ready ? `${esc(TYPES[pick.type].label)} on <strong>${esc(m.name)}</strong> <span class="mono dim tiny">${esc(provenance(m))}</span>` : '<span class="dim">Pick a model and a build type.</span>'}</span>
      <button type="button" class="btn btn-primary" data-action="continue" ${ready ? '' : 'disabled'}>Continue</button>
    </div>

    <section class="step">
      <div class="step-head"><h2 class="h-small">Or open a governed example</h2></div>
      <div class="grid grid-4">
        ${state.builds.filter((b) => b.templateKey).map((b) => {
          const t = tmpl(b.templateKey);
          return `<a class="card tpl-card" href="#/b/${b.id}">
            <span class="row between"><span class="eyebrow">${esc(t.industry)}</span>${tierPlate(b.tier)}</span>
            <span class="tpl-name">${esc(b.name)}</span>
            <span class="small dim">${esc(TYPES[b.type].label)} · ${esc(modelById(b.modelId).name)}</span>
          </a>`;
        }).join('')}
      </div>
    </section>
  </div>`);
}

// ---------------------------------------------------------------------------
// Build editor

let draft = null;

function newDraft(modelId, type) {
  return {
    id: null,
    name: '',
    type,
    modelId,
    purpose: '',
    usedBy: 'Internal team',
    instructions: '',
    starters: [],
    tools: type === 'chatbot' ? [] : ['calculator', 'knowledge'],
    knowledge: '',
    protectedTerms: [],
    safeguards: {},
    chosenSafeguards: [],
    harness: type === 'harness' ? { approval: false, fullLog: true, aiLabel: false, toolModes: {} } : undefined,
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
        <label class="field"><span>Model</span>
          <select id="f-model">${allowed.map((m) => `<option value="${m.id}" ${d.modelId === m.id ? 'selected' : ''}>${esc(m.name)} · ${esc(provenance(m))}</option>`).join('')}</select></label>
      </div>
      <div class="field-row">
        <label class="field grow"><span>What is it for?</span><input id="f-purpose" value="${esc(d.purpose)}" placeholder="The job it does and for whom. This decides its risk tier."></label>
        <label class="field"><span>Used by</span>
          <select id="f-usedby">${USED_BY.map((u) => `<option ${d.usedBy === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Instructions</span><textarea id="f-instructions" rows="7" placeholder="How it should behave, what it must never do, and the format of its answers.">${esc(d.instructions)}</textarea></label>
      <label class="field"><span>Starter prompts <em class="dim">one per line</em></span><textarea id="f-starters" rows="3">${esc(d.starters.join('\n'))}</textarea></label>
      <label class="field"><span>Reference text <em class="dim">${isTool ? 'searchable with the knowledge tool' : 'added to the instructions'}</em></span><textarea id="f-knowledge" rows="5" placeholder="Paste a policy, criteria or a job description.">${esc(d.knowledge)}</textarea></label>
      <label class="field"><span>Protected names <em class="dim">comma separated, always removed before sending</em></span><input id="f-terms" value="${esc(d.protectedTerms.join(', '))}" placeholder="Client or patient names"></label>

      ${isTool ? `
      <fieldset class="fieldset">
        <legend>Tools</legend>
        <div class="grid grid-2">
          ${Object.entries(TOOLS).map(([k, t]) => `
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
          ${Object.entries(SAFEGUARD_LIBRARY).map(([k, s]) => `
            <label class="check-row"><input type="checkbox" name="safeguard" value="${k}" ${d.chosenSafeguards?.includes(k) ? 'checked' : ''}> <span><strong>${esc(s.label)}</strong><br><span class="small dim">${esc(s.detail)}</span></span></label>`).join('')}
        </div>
      </fieldset>` : ''}

      <div class="form-actions">
        <a class="btn btn-ghost" href="${d.id ? `#/b/${d.id}` : '#/'}">Cancel</a>
        <button type="submit" class="btn btn-primary">Check risk and save</button>
      </div>
    </form>
  </div>`);
}

function readEditor() {
  const d = draft;
  d.name = $('#f-name').value.trim();
  d.type = $('#f-type').value;
  d.modelId = $('#f-model').value;
  d.purpose = $('#f-purpose').value.trim();
  d.usedBy = $('#f-usedby').value;
  d.instructions = $('#f-instructions').value.trim();
  d.starters = $('#f-starters').value.split('\n').map((s) => s.trim()).filter(Boolean);
  d.knowledge = $('#f-knowledge').value.trim();
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
  const m = modelById(msg.modelId || build.modelId);
  return `
  <div class="msg msg-assistant ${held ? 'is-held' : ''} ${msg.status === 'rejected' ? 'is-rejected' : ''}" data-index="${i}">
    <div class="msg-meta"><strong>${esc(build.name)}</strong> · ${esc(m?.name || '')} ${msg.at ? `· ${new Date(msg.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
      ${c.aiLabel && msg.status !== 'streaming' ? '<span class="ai-label">AI-generated</span>' : ''}</div>
    ${msg.steps?.length ? `<div class="steps">${msg.steps.map((s) => `<div class="step-line"><span class="mono tiny">${esc(s.name)}</span> ${esc(s.summary || '')}</div>`).join('')}</div>` : ''}
    <div class="answer">${msg.content ? renderMarkdown(msg.content) : '<span class="thinking">Thinking…</span>'}</div>
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
      ${msg.tokens ? `<span class="mono tiny dim">${msg.tokens} tokens</span>` : ''}
    </div>` : ''}
  </div>`;
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
        <label class="inline-select"><span class="small dim">Model</span>
          <select id="run-model">${MODELS.filter((x) => state.policy.allowedModels.includes(x.id)).map((x) => `<option value="${x.id}" ${x.id === build.modelId ? 'selected' : ''}>${esc(x.name)} · ${esc(provenance(x))}</option>`).join('')}</select></label>
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
      <div class="mono tiny dim composer-foot">${esc(m.name)} · ${esc(provenance(m))} · ${hasKey(m.id) ? 'key set' : '<a href="#/settings">add API key</a>'}</div>
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
    const policy = checkPolicy(text, build.modelId);
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

  const toolNames = build.type === 'chatbot' ? [] : (build.tools || []).filter((k) => build.harness?.toolModes?.[k] !== 'off');
  let result;
  try {
    let pending = 0;
    result = await runTurn({
      modelId: build.modelId,
      system: systemPrompt(build),
      history,
      tools: toolDefs(toolNames),
      maxSteps: build.maxSteps || 6,
      signal: run.controller.signal,
      onText: (t) => {
        reply.content = t;
        if (!pending) {
          pending = requestAnimationFrame(() => {
            pending = 0;
            const el = document.querySelector(`.msg-assistant[data-index="${chat.indexOf(reply)}"] .answer`);
            if (el) el.innerHTML = renderMarkdown(reply.content);
            const box = $('#messages'); if (box) box.scrollTop = box.scrollHeight;
          });
        }
      },
      onToolCall: async (call) => {
        const [key, tool] = toolByFunctionName(call.name) || [];
        if (!tool || !toolNames.includes(key)) throw new Error(`Tool ${call.name} is not available to this build.`);
        if (build.type === 'harness' && build.harness?.toolModes?.[key] === 'ask') await askToolPermission(build, call);
        const out = await tool.run(call.args || {}, build);
        reply.steps.push({ name: tool.label, summary: tool.describe(call.args || {}, out) });
        refreshMessages(build);
        return out;
      },
    });
    reply.content = result.text || '(No answer returned.)';
    reply.notes = checkOutput(reply.content, c);
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

  const tokensIn = estimateTokens(systemPrompt(build) + history.map((h) => h.content).join(' '));
  const tokensOut = estimateTokens(reply.content);
  reply.tokens = tokensIn + tokensOut;
  const rec = audit({
    event: regenerate ? 'Answer regenerated' : 'Message sent',
    buildId: build.id,
    build: build.name,
    type: build.type,
    tier: build.tier,
    model: `${build.modelId} (${result?.resolved?.model || resolve(build.modelId).model})`,
    outcome: reply.status === 'error' ? 'error' : reply.status === 'held' ? 'held for approval' : 'sent',
    redactions: describeCounts(summarise(lastUser?.findings || [])) || 'none',
    tokensIn,
    tokensOut,
    actor: 'User',
    detail: [
      reply.steps.length ? `tools: ${reply.steps.map((s) => s.name).join(', ')}` : '',
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
        <thead><tr><th>#</th><th>Time</th><th>Event</th><th>Build</th><th>Tier</th><th>Model</th><th>Outcome</th><th>Redactions</th><th>Tokens</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `
          <tr title="${esc(r.detail || '')}">
            <td class="mono">${String(r.seq).padStart(4, '0')}</td>
            <td class="mono nowrap">${new Date(r.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</td>
            <td>${esc(r.event)}</td><td>${esc(r.build || '')}</td>
            <td>${r.tier ? `<span class="dot dot-${r.tier}"></span> ${esc(TIERS[r.tier]?.label || r.tier)}` : ''}</td>
            <td class="mono small">${esc(r.model || '')}</td><td>${esc(r.outcome || '')}</td>
            <td class="small">${esc(r.redactions || '')}</td>
            <td class="mono small">${r.tokensIn ? `${r.tokensIn} / ${r.tokensOut}` : ''}</td>
          </tr>`).join('') : '<tr><td colspan="9" class="dim">No activity yet. Open a build and send a message.</td></tr>'}</tbody>
      </table>
    </div>
    <p class="small dim">Token counts are estimates (about four characters per token). Hover a row for details.</p>
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
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [page, id] = parts;
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
  if (page === 'audit') return renderAudit();
  if (page === 'policy') return renderPolicy();
  if (page === 'settings') return renderSettings();
  return renderHome();
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
    case 'pick-model': pick.modelId = el.dataset.id; renderHome(); break;
    case 'pick-type': pick.type = el.dataset.id; renderHome(); break;
    case 'continue':
      draft = newDraft(pick.modelId, pick.type);
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
    if (draft.type === 'harness' && !draft.harness) draft.harness = { approval: false, fullLog: true, aiLabel: false, toolModes: {} };
    renderEditor();
  }
});

route();
