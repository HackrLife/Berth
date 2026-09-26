// Tools an agent or harness can use. All run in the browser.

function safeCalc(expr) {
  const src = String(expr).replace(/\s+/g, '');
  if (!/^[0-9+\-*/().,%^]+$/.test(src)) throw new Error('Only numbers and + - * / ^ % ( ) are allowed.');
  const js = src.replace(/,/g, '').replace(/\^/g, '**').replace(/(\d+(?:\.\d+)?)%/g, '($1/100)');
  // Expression is restricted to digits and arithmetic operators above.
  const value = Function(`"use strict"; return (${js});`)();
  if (!Number.isFinite(value)) throw new Error('The result is not a finite number.');
  return Math.round(value * 1e10) / 1e10;
}

function searchKnowledge(knowledge, query) {
  if (!knowledge?.trim()) return 'This build has no knowledge text attached.';
  const words = String(query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const paras = knowledge.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const scored = paras
    .map((p) => ({ p, score: words.reduce((s, w) => s + (p.toLowerCase().includes(w) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return scored.length ? scored.map((x) => x.p).join('\n\n') : 'No matching passage found.';
}

export const TOOLS = {
  calculator: {
    label: 'Calculator',
    blurb: 'Exact arithmetic, e.g. repayments and ratios',
    def: {
      name: 'calculator',
      description: 'Evaluate an arithmetic expression exactly. Use for any calculation. Supports + - * / ^ % and parentheses.',
      parameters: { type: 'object', properties: { expression: { type: 'string', description: 'For example (5200*12)/85000' } }, required: ['expression'] },
    },
    run: (args) => String(safeCalc(args.expression)),
    describe: (args, result) => `${args.expression} = ${result}`,
  },
  datetime: {
    label: 'Date and time',
    blurb: 'Today’s date and time in a time zone',
    def: {
      name: 'current_datetime',
      description: 'Return the current date and time. Optionally pass an IANA time zone such as Australia/Sydney.',
      parameters: { type: 'object', properties: { timezone: { type: 'string' } } },
    },
    run: (args) => {
      const tz = args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      return new Date().toLocaleString('en-AU', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }) + ` (${tz})`;
    },
    describe: (args, result) => result,
  },
  wikipedia: {
    label: 'Wikipedia lookup',
    blurb: 'Summary of a topic from Wikipedia',
    def: {
      name: 'wikipedia_summary',
      description: 'Look up a topic on English Wikipedia and return the summary paragraph.',
      parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    },
    run: async (args) => {
      const title = encodeURIComponent(String(args.topic).trim().replace(/ /g, '_'));
      const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
      if (!res.ok) return `No Wikipedia article found for "${args.topic}".`;
      const j = await res.json();
      return `${j.title}: ${j.extract} (Source: ${j.content_urls?.desktop?.page || 'Wikipedia'})`;
    },
    describe: (args) => `Looked up "${args.topic}"`,
  },
  knowledge: {
    label: 'Knowledge search',
    blurb: 'Search the text attached to this build',
    def: {
      name: 'search_knowledge',
      description: 'Search the reference text attached to this assistant (policies, criteria, job descriptions) and return the most relevant passages.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    run: (args, build) => searchKnowledge(build.knowledge, args.query),
    describe: (args) => `Searched knowledge for "${args.query}"`,
  },
};

export function toolDefs(names) {
  return names.filter((n) => TOOLS[n]).map((n) => TOOLS[n].def);
}

export function toolByFunctionName(fn) {
  return Object.entries(TOOLS).find(([, t]) => t.def.name === fn);
}
