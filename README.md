# Berth

**Build agents that increase productivity, prove compliance and drive governance.** Multi-model agentic AI with governance and compliance logs.

Berth is a small, working prototype built as preparatory work for doctoral research on AI governance. The question it makes concrete is how obligations usually written as policy or regulation can be implemented as product behaviour that a person meets while working.

**Live demo:** https://berth-pearl.vercel.app
**Product requirements:** [PRD.md](PRD.md)

---

## What it does

Berth is organised around four outcomes, one tab each.

1. **Build agents.** Design an agent as a pipeline of steps: Input, Protect, Route, Work, Review and Approve. Click a step to set it up in a side sheet. Adding a Route step turns a chatbot into an agent; adding a Review step turns an agent into a harness. Seven models are available: Claude, GPT, Gemini and Grok (closed weights), and Mistral, Llama and Qwen (open weights, through OpenRouter). A test run executes the real pipeline and lights up each step as it completes.
2. **Increase productivity.** In Work, staff use the agents. Answers cite the company documents they came from, routing sends simple requests to cheaper models, and every answer shows its cost, the saving against a single large model, and the estimated minutes of manual work saved.
3. **Prove compliance.** Each agent is classified under the EU AI Act by its purpose and who uses it. A model proposes the tier, a person confirms it, and the tier switches on the required controls. High risk locks human approval (Art. 14) and record-keeping (Art. 12) on. Each agent exports an **evidence pack**: purpose, tier, legal basis, models, controls, documents, outcomes and audit records in one Markdown file.
4. **Drive governance.** Answers from high-risk agents wait in an **Approvals** inbox for the right person. Workspace policy sets allowed models, the personal data to remove and blocked terms. Every request, route, review, block, approval and tier decision goes into an audit log exportable as CSV or JSON.

Personal data (emails, phone numbers, card numbers, IBANs, Australian Tax File Numbers) is replaced with placeholders **before** a prompt leaves the browser, and the composer shows what will be removed while you type.

## How it works: architecture patterns

The **Build › Architecture patterns** page documents ten industry-agnostic patterns, each with an architecture diagram in one shared notation (models, tools, governance checkpoints, decisions, people and audit records):

| Group | Pattern | In Berth today |
|---|---|---|
| Agents | Single model | Runs |
| Agents | Routed (router, fast and strong models) | Runs |
| Agents | Cascade (fast first, escalate on failure) | Reference design |
| Agents | Tool loop | Runs |
| Agents | Orchestrator and workers | Reference design |
| Harnesses | Review and revise (independent reviewer) | Runs |
| Harnesses | Approval-gated | Runs |
| Harnesses | Consensus (two vendors and a judge) | Reference design |
| Foundations | Router | Runs |
| Foundations | Governance layer | Runs |

Each pattern links directly, for example `#/how/routed`.

## Governed examples

All five examples run inside **Meridian Bank**, a fictional Australian bank, so one organisation shows how different uses of AI carry different risks. Each example answers from its own policy document, which is preloaded in Knowledge and cited in every answer.

| Example | Bank function | Policy it answers from | Type | Tier | Safeguards |
|---|---|---|---|---|---|
| Staff Health Guide | Staff health | Staff Health and Wellbeing Guide | Chatbot: Claude | High (medical device software, Annex I) | Emergency stop on red-flag symptoms, no diagnosis or dosage, "not medical advice" check |
| Loan Eligibility Checker | Lending | Personal Lending Credit Policy | Agent: Mistral routes, GPT works | High (credit scoring, Annex III) | Plain-language reasons required, no final decisions, human sign-off |
| Contract Reviewer | Legal | Supplier Contracting Standards | Chatbot: Mistral | Minimal in-house, High for a court | Supplier names redacted, citations flagged unverified |
| Candidate Screener | Recruitment | Recruitment and Fair Hiring Policy | Harness: Mistral routes, GPT works, Claude reviews | High (recruitment, Annex III) | Blind screening, shortlist only, independent review, human approval |
| Policy Assistant | Operations | Staff Handbook: travel, expenses, security and AI use | Chatbot: GPT | Minimal | Answers only from cited sources |

Try this: open **Contract Reviewer** and change *Used by* to *Court or tribunal*. The same assistant moves from Minimal to High risk, because the AI Act classifies by use rather than by technology.

## Knowledge: governed retrieval

Visitors can upload PDF, Word, text, Markdown, CSV or JSON files on the **Knowledge** page and ask builds to answer from them.

1. Text is extracted **in the browser** and personal data is redacted there. The original file never leaves the device.
2. The redacted text is split into chunks, embedded with OpenAI `text-embedding-3-small` (512 dimensions) and stored in Supabase Postgres with pgvector, in Sydney.
3. Each visitor's rows are isolated by **row-level security**. The API connects as a restricted role (`berth_app`) that can use only the `berth` schema, so it cannot read other data in the project.
4. Chatbots retrieve passages before answering; agents and harnesses get a document-search tool. Every answer lists the sources it used.
5. Uploads, searches and deletions are logged, and **Delete all my data** erases documents, chunks and server-side records together.

Five Meridian Bank policies are shared read-only so retrieval works on first visit, one for each example. They are defined in [`api/_samples.js`](api/_samples.js) and indexed automatically the first time they are needed. The schema is in [`supabase/migrations/0001_berth.sql`](supabase/migrations/0001_berth.sql).

## Demo mode

On the hosted deployment, visitors need no API keys. A server function (`supabase/functions/berth-api`) forwards model requests with the deployment's own keys, accepts only known provider endpoints and an allow-list of models, caps output length, and limits requests per visitor and per day. Anyone who adds their own keys in Settings calls the providers directly instead.

## Running it

The front end is a static site with no build step. The hosted version runs on **Vercel**, deployed from this repository on every push, with four small Vercel Functions in `api/` pinned to the Sydney region. Without them the site still runs with your own API keys.

Vercel environment variables:

| Name | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY` | Demo-mode model access; OpenAI also creates embeddings |
| `BERTH_DB_PASSWORD` | Password of the restricted `berth_app` database role (or set `BERTH_DATABASE_URL` in full) |
| `DEMO_VISITOR_LIMIT`, `DEMO_DAILY_LIMIT` | Optional request caps (defaults 40 and 400 per day) |

An equivalent Supabase Edge Function (`supabase/functions/berth-api`) serves copies of the site hosted on static hosts such as GitHub Pages.

```bash
git clone https://github.com/HackrLife/Berth.git
cd Berth
python3 -m http.server 8000   # any static server works
# open http://localhost:8000
```

Add API keys under **Settings & API keys**. You need a key only for the providers you want to use; the open-weight models all use one OpenRouter key.

**About keys:** keys are saved in your browser's local storage and sent only to their own provider. Nothing passes through a Berth server, because there is none. This suits a personal demo. A production deployment would hold keys centrally behind a server-side proxy.

## How it is built

```
index.html          entry point
css/berth.css       design tokens and components
js/models.js        the seven-model catalogue
js/providers.js     three API adapters (Anthropic, OpenAI-compatible, Gemini), streaming and tool loops
js/governance.js    redaction, policy checks, pre-send guards, output checks, audit log
js/pipeline.js      multi-model execution: routing, review, revision, cost per stage
js/diagrams.js      architecture patterns and the SVG diagram renderer
js/risk.js          risk tiers, tier-to-control mapping, model-assisted classification
js/tools.js         browser-safe agent tools
js/templates.js     the five governed examples (Meridian Bank)
js/store.js         local persistence
js/app.js           interface, routing and the send pipeline
js/api.js           client for the server functions
js/extract.js       in-browser text extraction (PDF, Word, text)
api/proxy.js                    demo mode: key-holding proxy with limits
api/docs.js                     index, list and delete documents
api/search.js                   vector search under row-level security
api/status.js                   what this deployment supports
supabase/functions/berth-api/   the same API as a Supabase Edge Function
supabase/migrations/            database schema, restricted role and policies
```

Design choices worth noting:

- **Classification is model-assisted and enforcement is deterministic.** A model proposes the tier, a person confirms it, and a fixed table in code decides the controls.
- **Routing is governed too.** The router sees only the redacted request, defaults to the strong model when unsure, and its decision is logged with every answer.
- **Only redacted text is stored or sent.** The original message never leaves the composer.
- **Full prompts are logged only where the tier or harness requires it**, balancing record-keeping (Art. 12) against data minimisation (GDPR Art. 5(1)(c)).

## Limits

- Pattern-based redaction catches structured data and labelled fields, not every name in free text.
- The risk tier is indicative, not a legal assessment.
- Costs are estimates from the editable price table in Settings, not provider invoices.
- Some providers may block direct browser calls. Grok can be routed through OpenRouter in Settings if that happens.

## Author

Dev Das · [dev-das.com](https://dev-das.com)
