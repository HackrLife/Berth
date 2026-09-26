# Berth

**A governed AI workspace.** Choose a model, build a chatbot, an agent or a harness, and Berth governs it according to what it is used for.

Berth is a small, working prototype built as preparatory work for doctoral research on AI governance. The question it makes concrete is how obligations usually written as policy or regulation can be implemented as product behaviour that a person meets while working.

**Live demo:** https://hackrlife.github.io/berth/
**Product requirements:** [PRD.md](PRD.md)

---

## What it does

1. **Choose a model.** Seven models: Claude, GPT, Gemini and Grok (closed weights), and Mistral, Llama and Qwen (open weights, through OpenRouter). Each shows where it is hosted and whether its weights are open.
2. **Choose what to build.**
   - **Chatbot:** a model with instructions and reference text.
   - **Agent:** a chatbot that plans and uses tools (calculator, date and time, Wikipedia, search over its reference text).
   - **Harness:** an agent wrapped in controls you set yourself: per-tool permissions, approval gates, record-keeping and safeguards.
3. **Get a risk tier.** When you save, the model proposes a tier under the EU AI Act based on the build's purpose and who uses it. You confirm or override it, and the tier switches on the matching controls.
4. **Use it with governance in the loop.**
   - Personal data (emails, phone numbers, card numbers, IBANs, Australian Tax File Numbers) is replaced with placeholders **before** the prompt leaves the browser. The composer shows what will be removed while you type.
   - Blocked terms and a list of allowed models apply across the workspace.
   - High-risk answers are held until a person approves them.
   - Every request, block, approval and tier decision goes into an audit log you can export as CSV or JSON.

## Governed examples

| Example | Industry | Type | Tier | Safeguards |
|---|---|---|---|---|
| Symptom Guide | Health | Chatbot | High (medical device software, Annex I) | Emergency stop on red-flag symptoms, no diagnosis or dosage, "not medical advice" check |
| Loan Eligibility Checker | Finance | Agent | High (credit scoring, Annex III) | Plain-language reasons required, no final decisions, human sign-off |
| Contract Reviewer | Legal | Chatbot | Minimal for a law firm, High for a court | Client names redacted, citations flagged unverified |
| Candidate Screener | HR | Harness | High (recruitment, Annex III) | Blind screening, shortlist only, human approval |

Try this: open **Contract Reviewer** and change *Used by* to *Court or tribunal*. The same assistant moves from Minimal to High risk, because the AI Act classifies by use rather than by technology.

## Running it

Berth is a static site with no build step and no server.

```bash
git clone https://github.com/HackrLife/berth.git
cd berth
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
js/risk.js          risk tiers, tier-to-control mapping, model-assisted classification
js/tools.js         browser-safe agent tools
js/templates.js     the four governed examples
js/store.js         local persistence
js/app.js           interface, routing and the send pipeline
```

Design choices worth noting:

- **Classification is model-assisted and enforcement is deterministic.** A model proposes the tier, a person confirms it, and a fixed table in code decides the controls.
- **Only redacted text is stored or sent.** The original message never leaves the composer.
- **Full prompts are logged only where the tier or harness requires it**, balancing record-keeping (Art. 12) against data minimisation (GDPR Art. 5(1)(c)).

## Limits

- Pattern-based redaction catches structured data and labelled fields, not every name in free text.
- The risk tier is indicative, not a legal assessment.
- Some providers may block direct browser calls. Grok can be routed through OpenRouter in Settings if that happens.

## Author

Dev Das · [dev-das.com](https://dev-das.com)
