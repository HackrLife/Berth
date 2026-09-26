// Multi-model execution.
//
//   Chatbot  one model answers.
//   Agent    a router model sorts each request as simple or complex, then a
//            fast model or a strong model does the work (with tools).
//   Harness  the agent pipeline plus an independent reviewer model that checks
//            the draft against the build's rules, with one revision if needed.
//            Human approval, when on, follows the reviewer.
//
// Every stage records its model, token usage and estimated cost, so each
// answer can show what routing saved against using the strong model for all.

import { MODELS, modelById } from './models.js';
import { state } from './store.js';
import { runTurn, complete, parseJson } from './providers.js';

export const ROLES = {
  router: { label: 'Router', stage: 'Triage', blurb: 'Sorts each request as simple or complex. Choose a cheap, fast model.' },
  fast: { label: 'Fast model', stage: 'Work', blurb: 'Handles simple requests.' },
  strong: { label: 'Strong model', stage: 'Work', blurb: 'Handles complex requests and anything the router is unsure about.' },
  reviewer: { label: 'Reviewer', stage: 'Review', blurb: 'Checks each draft against the rules. A different vendor from the workers gives an independent check.' },
};

export function rolesFor(type) {
  if (type === 'agent') return ['router', 'fast', 'strong'];
  if (type === 'harness') return ['router', 'fast', 'strong', 'reviewer'];
  return [];
}

export function defaultModels(type, primary = 'claude') {
  if (type === 'chatbot') return {};
  const m = { router: 'mistral', fast: 'gemini', strong: primary };
  if (type === 'harness') m.reviewer = primary === 'gpt' ? 'claude' : 'gpt';
  return m;
}

export function priceOf(modelId) {
  const m = modelById(modelId);
  return state.prices[modelId] || m?.price || { in: 0, out: 0 };
}

export function costOf(modelId, usage) {
  const p = priceOf(modelId);
  return ((usage?.in || 0) * p.in + (usage?.out || 0) * p.out) / 1e6;
}

export function formatCost(usd) {
  if (!usd) return '$0';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(3)}`;
}

/** Every model a build uses, for key checks and display. */
export function modelsUsed(build) {
  if (build.type === 'chatbot') return [build.modelId];
  const m = build.models || {};
  const roles = rolesFor(build.type).filter((r) => r !== 'router' || build.routing !== false);
  return [...new Set(roles.map((r) => m[r]).filter(Boolean))];
}

const ROUTER_SYSTEM = `You route requests for an AI assistant. Decide whether a request is simple or complex.
simple: a short factual answer, rewording, formatting, a single lookup or a single calculation.
complex: several steps, judgement, assessment of a person or a document, legal, medical or financial reasoning, or anything ambiguous.
When unsure, choose complex. Reply with JSON only: {"route":"simple"|"complex","reason":"a few words"}`;

const REVIEWER_SYSTEM = `You are an independent reviewer in an AI governance harness. You check a draft answer before a person sees it.
Check the draft against the assistant's instructions and the rules listed. Look for: instructions not followed, rules broken, unsupported claims, missing required content, and decisions the assistant is not allowed to make.
Reply with JSON only: {"verdict":"pass"|"revise","issues":["short, specific issue", ...]}. Use "pass" with an empty list when there is nothing material to fix.`;

/**
 * Run a build against the conversation.
 * `hooks.onStage(stage)` is called as each stage starts or finishes so the UI
 * can show progress. Returns { text, stages, steps, cost, baseline, notes }.
 */
export async function execute(build, { system, history, tools, onText, onToolCall, onStage, rulesText, signal }) {
  const stages = [];
  const push = (s) => { stages.push(s); onStage?.(stages); return s; };
  const lastUser = [...history].reverse().find((h) => h.role === 'user')?.content || '';

  // Chatbot: one model.
  if (build.type === 'chatbot') {
    const st = push({ stage: 'Answer', role: 'model', modelId: build.modelId, status: 'running' });
    const r = await runTurn({ modelId: build.modelId, system, history, onText, signal });
    Object.assign(st, { status: 'done', usage: r.usage, cost: costOf(build.modelId, r.usage) });
    onStage?.(stages);
    return finish(build, { text: r.text, stages, steps: [], stepLimitHit: false });
  }

  const m = build.models || defaultModels(build.type, build.modelId);

  // 1. Triage: route to the fast or strong model.
  let route = 'complex';
  let routeReason = 'Routing off';
  if (build.routing !== false) {
    const st = push({ stage: 'Triage', role: 'router', modelId: m.router, status: 'running' });
    try {
      const out = await complete({
        modelId: m.router,
        system: ROUTER_SYSTEM,
        prompt: `Assistant purpose: ${build.purpose || build.name}\n\nRequest:\n"""\n${lastUser.slice(0, 3000)}\n"""`,
        signal,
      });
      const j = parseJson(out.text);
      route = j.route === 'simple' ? 'simple' : 'complex';
      routeReason = j.reason || '';
      Object.assign(st, { status: 'done', usage: out.usage, cost: costOf(m.router, out.usage), note: `${route} · ${routeReason}` });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      Object.assign(st, { status: 'done', note: `complex · router failed (${err.message.slice(0, 60)}), defaulted to strong` });
    }
    onStage?.(stages);
  }

  // 2. Work: fast or strong model, with tools.
  let workerId = route === 'simple' ? m.fast : m.strong;
  const work = async (hist, label) => {
    const st = push({ stage: label, role: route === 'simple' ? 'fast' : 'strong', modelId: workerId, status: 'running' });
    const r = await runTurn({ modelId: workerId, system, history: hist, tools, maxSteps: build.maxSteps || 6, onText, onToolCall, signal });
    Object.assign(st, { status: 'done', usage: r.usage, cost: costOf(workerId, r.usage), note: r.steps.length ? `${r.steps.length} tool call${r.steps.length > 1 ? 's' : ''}` : '' });
    onStage?.(stages);
    return r;
  };
  let result = await work(history, 'Work');
  let steps = [...result.steps];

  // 3. Review (harness only), with one revision on the strong model.
  let review = null;
  if (build.type === 'harness' && m.reviewer && build.harness?.review !== false) {
    const doReview = async (draft) => {
      const st = push({ stage: 'Review', role: 'reviewer', modelId: m.reviewer, status: 'running' });
      try {
        const out = await complete({
          modelId: m.reviewer,
          system: REVIEWER_SYSTEM,
          prompt: `Assistant instructions:\n"""\n${(build.instructions || '').slice(0, 4000)}\n"""\n\nRules in force:\n${rulesText || '- none beyond the instructions'}\n\nUser request:\n"""\n${lastUser.slice(0, 4000)}\n"""\n\nDraft answer:\n"""\n${draft.slice(0, 8000)}\n"""`,
          signal,
        });
        const j = parseJson(out.text);
        const verdict = j.verdict === 'revise' ? 'revise' : 'pass';
        const issues = Array.isArray(j.issues) ? j.issues.map(String).slice(0, 6) : [];
        Object.assign(st, { status: 'done', usage: out.usage, cost: costOf(m.reviewer, out.usage), note: verdict === 'pass' ? 'passed' : `${issues.length} issue${issues.length === 1 ? '' : 's'}` });
        onStage?.(stages);
        return { verdict, issues };
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        Object.assign(st, { status: 'done', note: `review failed: ${err.message.slice(0, 60)}` });
        onStage?.(stages);
        return { verdict: 'error', issues: [`The reviewer could not complete: ${err.message}`] };
      }
    };

    review = await doReview(result.text);
    if (review.verdict === 'revise' && build.harness?.retry !== false) {
      workerId = m.strong;
      route = 'complex';
      onText?.('');
      const feedback = `A reviewer found these issues with your previous answer:\n- ${review.issues.join('\n- ')}\n\nWrite a corrected, complete answer to my request.`;
      const revised = await work([...history, { role: 'assistant', content: result.text }, { role: 'user', content: feedback }], 'Revise');
      result = revised;
      steps = steps.concat(revised.steps);
      review = await doReview(result.text);
    }
  }

  return finish(build, { text: result.text, stages, steps, review, stepLimitHit: result.stepLimitHit, strongId: m.strong });
}

function finish(build, out) {
  const cost = out.stages.reduce((s, st) => s + (st.cost || 0), 0);
  // What the same token volume would cost if the strong model did every stage.
  const strongId = out.strongId || build.modelId;
  const baseline = out.stages.reduce((s, st) => s + costOf(strongId, st.usage), 0);
  const estimated = out.stages.some((st) => st.usage?.estimated);
  return { ...out, cost, baseline, estimated };
}

export function roleOptions() {
  return MODELS;
}
