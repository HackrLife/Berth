// The governance layer. Runs on every outgoing prompt and every returned answer.
//
//   1. redact()        – replace personal data with typed placeholders
//   2. checkPolicy()   – blocked terms, allowed models
//   3. preSend guards  – build-specific stops (e.g. medical red flags)
//   4. checkOutput()   – build-specific checks on the answer
//   5. audit()         – append a record to the audit log

import { state, save } from './store.js';

// ---------------------------------------------------------------------------
// 1. Redaction

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = Number(digits[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function validTfn(digits) {
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  if (digits.length !== 9) return false;
  const sum = digits.split('').reduce((s, d, i) => s + Number(d) * w[i], 0);
  return sum % 11 === 0;
}

// Order matters: more specific patterns run first so a card number is not
// also counted as a phone number.
const PATTERNS = [
  { type: 'EMAIL', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { type: 'IBAN', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { type: 'CARD', re: /\b(?:\d[ -]?){12,18}\d\b/g, valid: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'TFN', re: /\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g, valid: (m) => validTfn(m.replace(/\D/g, '')) },
  {
    type: 'PHONE',
    re: /(?:\+\d{1,3}[ .-]?)?(?:\(?\d{1,4}\)?[ .-]?)?\d{3,4}[ .-]?\d{3,4}\b/g,
    valid: (m) => m.replace(/\D/g, '').length >= 9,
  },
];

export const PII_TYPES = {
  EMAIL: 'Email addresses',
  PHONE: 'Phone numbers',
  CARD: 'Payment card numbers',
  IBAN: 'Bank account numbers (IBAN)',
  TFN: 'Australian Tax File Numbers',
};

/**
 * Replace personal data with placeholders such as [EMAIL_1].
 * `extra` holds build-specific rules: { type, re, group } where `group` is the
 * capture group to replace (0 = whole match), and exact protected terms.
 */
export function redact(text, { enabled = state.policy.redact, extra = [], terms = [] } = {}) {
  const findings = [];
  const seen = new Map();
  const counters = {};

  const tokenFor = (type, original) => {
    const k = `${type}:${original.toLowerCase()}`;
    if (!seen.has(k)) {
      counters[type] = (counters[type] || 0) + 1;
      const token = `[${type}_${counters[type]}]`;
      seen.set(k, token);
      findings.push({ type, original, token });
    }
    return seen.get(k);
  };

  let out = text;

  for (const term of terms.filter(Boolean)) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(re, (m) => tokenFor('CLIENT', m));
  }

  for (const rule of extra) {
    const re = new RegExp(rule.re, 'gi');
    out = out.replace(re, (...args) => {
      const match = args[0];
      const value = rule.group ? args[rule.group] : match;
      if (!value || /^\[[A-Z]+_\d+\]$/.test(value.trim())) return match;
      return match.replace(value, tokenFor(rule.type, value.trim()));
    });
  }

  for (const p of PATTERNS) {
    if (!enabled[p.type]) continue;
    out = out.replace(p.re, (m) => {
      if (p.valid && !p.valid(m)) return m;
      return tokenFor(p.type, m.trim());
    });
  }

  return { text: out, findings };
}

/** Put original values back for display on this device only. */
export function restore(text, findings) {
  let out = text;
  for (const f of findings) out = out.split(f.token).join(f.original);
  return out;
}

export function summarise(findings) {
  const counts = {};
  for (const f of findings) counts[f.type] = (counts[f.type] || 0) + 1;
  return counts;
}

export function describeCounts(counts) {
  const names = { EMAIL: 'email', PHONE: 'phone number', CARD: 'card number', IBAN: 'bank account', TFN: 'tax file number', CLIENT: 'client name', NAME: 'name', AGE: 'age', GENDER: 'gender', NATIONALITY: 'nationality', DOB: 'date of birth', PHOTO: 'photo reference' };
  return Object.entries(counts)
    .map(([t, n]) => `${n} ${names[t] || t.toLowerCase()}${n > 1 ? 's' : ''}`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// 2. Policy

export function checkPolicy(text, modelId) {
  if (!state.policy.allowedModels.includes(modelId)) {
    return { ok: false, reason: 'This model is not on the workspace allowed list. An admin can change this under Policy.' };
  }
  const hit = state.policy.blockedTerms.find((t) => t && text.toLowerCase().includes(t.toLowerCase()));
  if (hit) {
    return { ok: false, reason: `Your message contains "${hit}", which is on the workspace blocked-terms list. Remove it to send.` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3 and 4. Build-specific guards

/** Stop before sending when a build's pre-send guard matches. */
export function preSend(text, controls) {
  if (controls.redFlagStop) {
    const hit = controls.redFlagStop.terms.find((t) => new RegExp(`\\b${t}\\b`, 'i').test(text));
    if (hit) return { stop: true, message: controls.redFlagStop.message, reason: `Red-flag symptom: ${hit}` };
  }
  return { stop: false };
}

/** Inspect an answer and return notes to show beside it. */
export function checkOutput(text, controls) {
  const notes = [];
  if (controls.citationCheck) {
    const cites = new Set();
    const caseRe = /\b[A-Z][A-Za-z&.'-]+(?: [A-Z][A-Za-z&.'-]+)* v\.? [A-Z][A-Za-z&.'-]+(?: [A-Z][A-Za-z&.'-]+)*(?: \[\d{4}\][^,.;\n]*| \(\d{4}\)[^,.;\n]*)?/g;
    const actRe = /\b[A-Z][A-Za-z ]+ Act (?:\d{4})(?: \([A-Za-z]+\))?/g;
    for (const m of text.match(caseRe) || []) cites.add(m.trim());
    for (const m of text.match(actRe) || []) cites.add(m.trim());
    if (cites.size) {
      notes.push({ level: 'warn', text: `${cites.size} citation${cites.size > 1 ? 's' : ''} unverified until a lawyer checks ${cites.size > 1 ? 'them' : 'it'}: ${[...cites].slice(0, 4).join('; ')}` });
    }
  }
  if (controls.forbidOutput) {
    for (const rule of controls.forbidOutput) {
      if (new RegExp(rule.re, 'i').test(text)) notes.push({ level: 'block', text: rule.message });
    }
  }
  if (controls.requireOutput) {
    for (const rule of controls.requireOutput) {
      if (!new RegExp(rule.re, 'i').test(text)) notes.push({ level: 'warn', text: rule.message });
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// 5. Audit log

export function audit(entry) {
  const seq = (state.audit[0]?.seq || 0) + 1;
  const record = { seq, at: new Date().toISOString(), ...entry };
  state.audit.unshift(record);
  if (state.audit.length > 2000) state.audit.length = 2000;
  save();
  return record;
}

export function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

export function auditToCsv(rows) {
  const cols = ['seq', 'at', 'event', 'build', 'type', 'tier', 'model', 'outcome', 'redactions', 'tokensIn', 'tokensOut', 'cost', 'actor', 'detail'];
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
