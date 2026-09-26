// Browser-only persistence. Nothing here leaves the device except API keys,
// which are sent only to the provider they belong to.

import { MODELS } from './models.js';

const KEY = 'berth.v1';

const DEFAULT_STATE = {
  keys: { anthropic: '', openai: '', google: '', xai: '', openrouter: '' },
  modelIds: {}, // catalogue id -> provider model id override
  grokRoute: 'direct', // 'direct' | 'openrouter'
  policy: {
    allowedModels: MODELS.map((m) => m.id),
    blockedTerms: ['Project Nightjar'],
    redact: { EMAIL: true, PHONE: true, CARD: true, IBAN: true, TFN: true },
  },
  builds: [],
  chats: {}, // buildId -> [{ role, content, meta }]
  audit: [],
  seeded: false,
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULT_STATE),
      ...parsed,
      keys: { ...DEFAULT_STATE.keys, ...parsed.keys },
      policy: {
        ...DEFAULT_STATE.policy,
        ...parsed.policy,
        redact: { ...DEFAULT_STATE.policy.redact, ...(parsed.policy?.redact || {}) },
      },
    };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export const state = read();

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('Berth could not save to local storage', err);
  }
}

export function uid(prefix = 'b') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  location.hash = '#/';
  location.reload();
}
