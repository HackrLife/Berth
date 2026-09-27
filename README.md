# Berth

**A governed AI workspace.** Choose a model, build a chatbot, an agent or a harness, and Berth governs it according to what it is used for.

Berth is a small, working prototype built as preparatory work for doctoral research on AI governance. The question it makes concrete is how obligations usually written as policy or regulation can be implemented as product behaviour that a person meets while working.

**Live demo:** https://hackrlife.github.io/Berth/
**Product requirements:** [PRD.md](PRD.md)

---

## What it does

1. **Say what you are building.**
   - **Chatbot:** one model with instructions and reference text.
   - **Agent:** a cheap router model sorts each request as simple or complex and sends it to a fast model or a strong model. The model doing the work can use tools (calculator, date and time, Wikipedia, search over its reference text).
   - **Harness:** the agent pipeline plus an independent reviewer model that checks every draft against the rules, one revision on the strong model if the reviewer finds issues, per-tool permissions and human approval.
2. **Assign models to roles.** Seven models are available: Claude, GPT, Gemini and Grok (closed weights), and Mistral, Llama and Qwen (open weights, through OpenRouter). A chatbot uses one. An agent uses a router, a fast model and a strong model. A harness adds a reviewer, ideally from a different vendor.
3. **Get a risk tier.** When you save, the model proposes a tier under the EU AI Act based on the build's purpose and who uses it. You confirm or override it, and the tier switches on the matching controls.
4. **Use it with governance and cost in view.**
   - Personal data (emails, phone numbers, card numbers, IBANs, Australian Tax File Numbers) is replaced with placeholders **before** the prompt leaves the browser. The composer shows what will be removed while you type.
   - Blocked terms and a list of allowed models apply across the workspace.
   - High-risk answers are held until a person approves them.
   - Every answer shows its pipeline (which model did which stage), its token use and cost, and what the same run would have cost on the strong model alone.
   - Every request, route, review, block, approval and tier decision goes into an audit log you can export as CSV or JSON.

## How it works: architecture patterns

The site's **How it works** page documents ten industry-agnostic patterns, each with an architecture diagram in one shared notation (models, tools, governance checkpoints, decisions, people and audit records):

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

| Example | Industry | Type | Tier | Safeguards |
|---|---|---|---|---|
| Symptom Guide | Health | Chatbot | High (medical device software, Annex I) | Emergency stop on red-flag symptoms, no diagnosis or dosage, "not medical advice" check |
| Loan Eligibility Checker | Finance | Agent: Mistral routes, Gemini or GPT works | High (credit scoring, Annex III) | Plain-language reasons required, no final decisions, human sign-off |
| Contract Reviewer | Legal | Chatbot | Minimal for a law firm, High for a court | Client names redacted, citations flagged unverified |
| Candidate Screener | HR | Harness: Mistral routes, Gemini or Claude works, GPT reviews | High (recruitment, Annex III) | Blind screening, shortlist only, independent review, human approval |

Try this: open **Contract Reviewer** and change *Used by* to *Court or tribunal*. The same assistant moves from Minimal to High risk, because the AI Act classifies by use rather than by technology.

## Running it

Berth is a static site with no build step and no server.

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
js/templates.js     the four governed examples
js/store.js         local persistence
js/app.js           interface, routing and the send pipeline
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
