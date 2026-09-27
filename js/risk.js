// Risk tiers and the controls each tier switches on.
// The model proposes a tier; a person confirms it; this table decides the
// controls. Classification is model-assisted, enforcement is deterministic.

import { complete, parseJson } from './providers.js';

export const TIERS = {
  minimal: { label: 'Minimal', short: 'MIN', order: 0, summary: 'No specific obligations under the EU AI Act.' },
  limited: { label: 'Limited', short: 'LTD', order: 1, summary: 'Transparency obligations (Art. 50).' },
  high: { label: 'High', short: 'HIGH', order: 2, summary: 'Annex I or Annex III use. Human oversight and record-keeping apply.' },
  prohibited: { label: 'Prohibited', short: 'BAN', order: 3, summary: 'A practice banned under Art. 5. It cannot be deployed.' },
};

export const USED_BY = [
  'Internal team',
  'Customers or the public',
  'HR and recruitment',
  'Lenders or insurers',
  'Clinicians or patients',
  'Law firm',
  'Court or tribunal',
  'Schools or universities',
  'Public authority',
];

/** Controls that follow from the tier alone. */
export function tierControls(tier) {
  return {
    aiLabel: tier === 'limited' || tier === 'high',
    approval: tier === 'high',
    fullLog: tier === 'high',
  };
}

/**
 * The full set of controls in force for a build: tier controls, then any
 * domain safeguards from its template, then (for a harness) the user's own
 * overrides.
 */
export function controlsFor(build) {
  const base = tierControls(build.tier);
  const merged = { ...base, ...(build.safeguards || {}) };
  if (build.type === 'harness' && build.harness) {
    merged.approval = build.harness.approval ?? merged.approval;
    merged.fullLog = build.harness.fullLog ?? merged.fullLog;
    merged.aiLabel = build.harness.aiLabel ?? merged.aiLabel;
  }
  return merged;
}

/** Human-readable list of controls for the governance panel. */
export function describeControls(build) {
  const c = controlsFor(build);
  const list = [{ on: true, title: 'Personal data redaction', detail: 'Emails, phones, cards, IBANs and TFNs removed before sending' }];
  if (c.extraRedaction?.length) list.push({ on: true, title: c.extraRedactionTitle || 'Additional redaction', detail: c.extraRedactionDetail || '' });
  if (c.protectedTerms?.length || build.protectedTerms?.length) list.push({ on: true, title: 'Protected names', detail: 'Listed names replaced before sending' });
  if (c.redFlagStop) list.push({ on: true, title: 'Emergency stop', detail: 'Red-flag symptoms stop the request and show emergency advice' });
  if (c.citationCheck) list.push({ on: true, title: 'Citation check', detail: 'Cases and statutes flagged unverified until a lawyer confirms them' });
  if (c.forbidOutput?.length) list.push({ on: true, title: 'Output limits', detail: c.forbidOutput.map((r) => r.label).join(', ') });
  if (c.requireOutput?.length) list.push({ on: true, title: 'Required content', detail: c.requireOutput.map((r) => r.label).join(', ') });
  if (build.useDocs) list.push({ on: true, title: 'Cited sources', detail: 'Answers draw on Knowledge documents and list the passages used' });
  list.push({ on: c.aiLabel, title: 'AI-generated label', detail: 'Art. 50 transparency' });
  list.push({ on: c.approval, title: 'Human approval', detail: 'Art. 14 · answers held until a person signs off' });
  list.push({ on: c.fullLog, title: 'Full record-keeping', detail: 'Art. 12 · prompt and answer kept in the audit log' });
  return list;
}

const CLASSIFIER_SYSTEM = `You classify AI assistants under the EU AI Act (Regulation (EU) 2024/1689).
Return only JSON: {"tier":"minimal|limited|high|prohibited","basis":"short legal basis, e.g. Annex III(4)(a)","rationale":"one or two plain sentences"}.
Rules:
- prohibited: Art. 5 practices, e.g. emotion recognition in the workplace or education, social scoring, untargeted scraping of facial images, manipulative techniques causing harm, predicting crime from profiling alone.
- high: Annex III uses (biometrics, critical infrastructure, education access or grading, employment and worker management, access to essential services including credit scoring and life or health insurance pricing, law enforcement, migration, administration of justice, democratic processes) or a safety component or medical purpose under Annex I (e.g. medical device software).
- limited: interacts directly with people who may not know it is AI, or generates content published to inform the public.
- minimal: everything else.
Classify by intended purpose AND who uses it. A tool is high risk when the deployment context is an Annex III use, even if the same tool elsewhere would be minimal.`;

/** Ask the build's model to propose a tier. */
export async function classify(build) {
  const prompt = `Assistant name: ${build.name}
Type: ${build.type}
Intended purpose: ${build.purpose || '(not stated)'}
Used by: ${build.usedBy}
Instructions (excerpt): ${(build.instructions || '').slice(0, 1500)}`;
  const { text } = await complete({ modelId: build.modelId, system: CLASSIFIER_SYSTEM, prompt });
  const j = parseJson(text);
  const tier = String(j.tier || '').toLowerCase();
  if (!TIERS[tier]) throw new Error(`Unrecognised tier "${j.tier}".`);
  return { tier, basis: j.basis || '', rationale: j.rationale || '' };
}
