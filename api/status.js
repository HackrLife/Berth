// GET /api/status — tells the front end what this deployment can do.

import { env, send, dbConfigured, LIMITS, EMBED_MODEL } from './_lib.js';
import { allowedModels } from './proxy.js';

export default function handler(req, res) {
  const providers = {
    anthropic: Boolean(env('ANTHROPIC_API_KEY')),
    openai: Boolean(env('OPENAI_API_KEY')),
    google: Boolean(env('GEMINI_API_KEY')),
    xai: Boolean(env('XAI_API_KEY')),
    openrouter: Boolean(env('OPENROUTER_API_KEY')),
  };
  send(res, 200, {
    demo: Object.values(providers).some(Boolean),
    providers,
    models: allowedModels(),
    retrieval: dbConfigured() && providers.openai,
    embedding: EMBED_MODEL,
    storage: 'Supabase · Sydney (ap-southeast-2)',
    limits: LIMITS,
    // Names only, never values: helps confirm the deployment sees its settings.
    deployment: {
      env: env('VERCEL_ENV', 'unknown'),
      commit: env('VERCEL_GIT_COMMIT_SHA').slice(0, 7) || null,
      database: dbConfigured(),
      berthVars: Object.keys(process.env).filter((k) => /^(BERTH_|DEMO_)|_API_KEY$/.test(k)).sort(),
    },
  });
}
