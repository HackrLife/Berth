# Berth — Product Requirements Document

**Version:** 0.3 (draft)
**Author:** Dev Das
**Status:** In development
**Last updated:** September 2026

---

## 1. Summary

Berth is a minimal, model-agnostic AI workspace in which every prompt passes through a governance layer before it reaches a model. A user chooses one of seven models (four with closed weights, three with open weights), chooses whether to build a chatbot, an agent or a harness, and deploys it within the same workspace. Berth adds two levels of control to this pattern. At the workspace level, it applies personal-data redaction, policy enforcement and an exportable audit log to every request. At the assistant level, it assigns each assistant a risk tier based on its intended purpose and deployment context, and applies safeguards specific to that tier and domain.

Berth was built as part of preparatory work for doctoral research on AI governance. The research question it makes concrete is how governance obligations that are usually written as organisational policy or regulation can be implemented as product behaviour that an ordinary employee encounters in the flow of work.

## 2. Problem

Organisations adopting generative AI face a gap between policy and practice.

1. **Data leaves the organisation unnoticed.** Employees paste customer emails, phone numbers and account details into AI tools. Acceptable-use policies prohibit this, but nothing in the tool prevents it at the moment of submission.
2. **Model choice is uncontrolled.** Teams use whichever model is convenient, while procurement and legal have approved only some providers.
3. **There is no record of use.** When a question arises about what was sent to which model, most teams cannot answer it. Record-keeping requirements such as Article 12 of the EU AI Act (for high-risk systems) and the accountability principle in GDPR Article 5(2) assume that such a record exists.
4. **Governance is uniform while risk is not.** Most AI workspaces apply one set of rules to every use. The EU AI Act instead assigns obligations according to intended purpose, so a screening assistant used in recruitment carries obligations that a summarising assistant does not. Professional duties, such as legal privilege, create further obligations that the Act does not address.
5. **Good prompts are not reused.** Effective instructions stay in individual chat histories and are rewritten each time.

Enterprise AI platforms address the first three problems at scale. Berth is a deliberately small implementation of the same idea, and it extends the idea to the fourth problem by making governance specific to each assistant.

## 3. Target users

| User | Need |
|---|---|
| **Knowledge worker** (primary) | Complete tasks with AI without having to remember the data policy or the regulatory status of the task. |
| **Workspace admin** | Decide which models are allowed and which terms must never be sent, confirm each assistant's risk tier, and see a record of use. |
| **Evaluator** (interviewer, researcher) | Understand the governance model within two minutes of opening the link. |

## 4. Goals and non-goals

### Goals (v0.1)
- A person can open the public link, add an API key and complete a useful task in under two minutes.
- Every request is checked for personal data before sending, and the user sees what was redacted.
- Every assistant carries a risk tier, and the tier visibly changes the controls that apply.
- Every request produces an audit-log entry that can be exported.
- The product works with at least two model providers, to demonstrate model-agnosticism.

### Non-goals (v0.1)
- User accounts, authentication or multi-user workspaces.
- A server-side backend or hosted API keys.
- Retrieval over large document collections (RAG), agents with tools, or workflows.
- Formal compliance with any regulation. Berth illustrates controls and does not certify them, and its risk classification is indicative rather than a legal assessment.

## 5. Core features

### 5.1 Model picker (home screen)
The home screen is a two-step builder. Step one is the choice of model.

| Model | Maker | Weights | Route |
|---|---|---|---|
| Claude | Anthropic | Closed | Direct |
| GPT | OpenAI | Closed | Direct |
| Gemini | Google | Closed | Direct |
| Grok | xAI | Closed | Direct, or through OpenRouter |
| Mistral | Mistral AI | Open | OpenRouter |
| Llama | Meta | Open | OpenRouter |
| Qwen | Alibaba | Open | OpenRouter |

- Each model card shows a provenance tag (hosting region, open or closed weights) and its status: ready, API key missing, or not allowed by policy.
- The specific model version for each entry is configurable in Settings, where Berth can load the provider's current list of models, so the catalogue does not go out of date.

### 5.2 Build types
Step two is the choice of what to build. The three types form a progression, each adding a layer to the one before.

| Type | What it is | What the user configures |
|---|---|---|
| **Chatbot** | A model with instructions, answering in conversation | Instructions, starter prompts, reference text |
| **Agent** | A chatbot that can plan and use tools over several steps | Everything above, plus tools and a step limit |
| **Harness** | An agent wrapped in controls the user sets explicitly | Everything above, plus per-tool permissions (run automatically, ask first, blocked), approval gates, record-keeping, AI labelling and a library of safeguards |

In a chatbot or an agent, the controls follow from the risk tier. In a harness, the tier sets defaults and the user decides each control, which makes the harness the unit in which governance is designed rather than inherited. v0.1 agents can use four browser-safe tools: a calculator, the current date and time, a Wikipedia lookup and a search over the build's reference text.

Every build records its intended purpose and its deployment context ("used by"), which together determine its risk tier (5.4).

v0.1 ships with four governed examples, one for each of four regulated industries and together covering all three build types:

| Example | Industry | Type | Model | Job |
|---|---|---|---|---|
| **Symptom Guide** | Health | Chatbot | Claude | Gives general guidance on symptoms and when to seek care. |
| **Loan Eligibility Checker** | Finance | Agent | GPT | Assesses a loan application against stated lending criteria, using the calculator and the criteria text. |
| **Contract Reviewer** | Legal | Chatbot | Mistral | Reviews contract clauses and identifies obligations and risks. |
| **Candidate Screener** | HR | Harness | Claude | Assesses CVs against a job description and proposes a shortlist. |

### 5.3 Governance layer (workspace level)
The governance layer runs on every outgoing prompt, in this order:

1. **PII detection and redaction.** Pattern-based detection of email addresses, phone numbers, payment card numbers, IBANs and Australian Tax File Numbers. Matches are replaced with typed placeholders (for example `[EMAIL_1]`) before sending. The user sees a notice that lists what was redacted and can review the redacted prompt.
2. **Policy check.** The admin can maintain a list of allowed models and a list of blocked terms (for example a confidential project name). A prompt that contains a blocked term is stopped with an explanation, and a disallowed model cannot be selected.
3. **Assistant safeguards.** The controls attached to the assistant's risk tier and domain (5.4) are applied.
4. **Audit log.** Each request records a timestamp, assistant, risk tier, model, redaction counts by type, policy outcome (sent, blocked or held for approval) and approximate token counts. The prompt text itself is not stored by default, in keeping with data minimisation under GDPR Article 5(1)(c). For high-risk assistants the prompt and output are also stored, because record-keeping for high-risk systems requires them. The log can be viewed in the app and exported as CSV or JSON.

### 5.4 Risk-tiered assistants (assistant level)
When an assistant is created or edited, Berth sends its intended purpose and deployment context to the selected model and receives a proposed risk tier with a short rationale referenced to the EU AI Act. The admin confirms or overrides the tier, and the override is logged. The tier and the assistant's domain together determine its safeguards.

| Tier | Meaning in Berth | Baseline controls |
|---|---|---|
| **Minimal** | No specific obligations under the Act | Workspace controls only |
| **Limited** | Transparency obligations (Art. 50) | Outputs labelled as AI-generated |
| **High** | Annex I or Annex III use | Full logging of prompt and output; output held until a named person approves it |
| **Prohibited** | Practice banned under Art. 5 | The assistant cannot be saved |

The four preset assistants are classified and safeguarded as follows:

| Assistant | Tier and basis | Domain safeguards |
|---|---|---|
| **Symptom Guide** | High: software with a medical purpose can qualify as a medical device, which brings it under Annex I | Red-flag symptoms (for example chest pain, stroke signs) stop the response and show an emergency message; no diagnosis or dosage is given; every answer carries a "not medical advice" label |
| **Loan Eligibility Checker** | High: creditworthiness assessment, Annex III(5)(b) | Every assessment must state plain-language reasons that the applicant could understand (see the right to explanation in Art. 86); a human signs off before any outcome is final |
| **Contract Reviewer** | Minimal when used by a law firm; High when the deployment context is a court or tribunal, Annex III(8)(a) | Client names are redacted to protect privilege; every cited case or statute is flagged "unverified" until a lawyer confirms it; lawyer sign-off on outputs |
| **Candidate Screener** | High: recruitment and selection, Annex III(4)(a) | Blind screening removes name, age, gender, photo references and nationality before the model reads a CV; the assistant may shortlist but may not reject a candidate |

The Contract Reviewer demonstrates two points. Changing its deployment context from *law firm* to *court or tribunal* changes its tier from Minimal to High, which shows that the Act classifies by use rather than by technology. Its safeguards at the Minimal tier show that professional obligations can require governance where regulation does not.

### 5.5 Settings
- API key entry for each provider, stored only in the browser's local storage, with a clear statement of where the key goes.
- Governance settings: allowed models, blocked terms, and a redaction toggle for each PII type.

## 6. User flow (first use)

1. The user opens the GitHub Pages link and sees the builder: seven models and three build types, with the four governed examples below.
2. They add an API key in Settings.
3. They open the **Candidate Screener** harness and send a CV that includes the candidate's name, age, email address and phone number. The composer shows what will be removed before they press send.
4. Berth removes the identifying details, the harness searches the job description, and the shortlist is marked "held for approval". The user approves it, and the audit log records the request, the tier, the tool use and the approver.
5. In the Contract Reviewer, the user changes the deployment context to *court or tribunal* and sees the tier change to High and the controls tighten.
6. They return to the builder, choose a model and a build type, describe what it is for, and save. The model proposes a risk tier, the user confirms or overrides it, and the new build opens with its controls in force.

## 7. Architecture

- **Type:** a static single-page application with no build step, served by GitHub Pages.
- **Stack:** HTML, CSS and plain JavaScript ES modules: `models` (catalogue), `providers` (API adapters), `governance` (redaction, policy, output checks, audit), `risk` (tiers and controls), `tools`, `templates`, `store` and `app` (interface).
- **Model calls:** made directly from the browser to each provider's API with the user's own key. Three adapters cover all seven models: the Anthropic Messages API, the OpenAI-compatible Chat Completions API (OpenAI, xAI and OpenRouter) and the Gemini API. No Berth server exists, so no request passes through the author.
- **Storage:** browser `localStorage` for keys, assistants, settings, chat history and the audit log.
- **Risk classification:** a single structured model call on assistant save, returning a tier, the legal basis and a rationale as JSON. The tier-to-control mapping is a fixed table in code, so the controls are deterministic even though the classification is model-assisted.
- **Security note:** a key held in the browser suits a personal demo and is not suitable for a shared deployment. The production design would move model calls behind a server-side proxy that holds keys centrally, which is the pattern enterprise platforms use.

## 8. Mapping to governance principles

| Berth control | Principle it illustrates |
|---|---|
| PII redaction before send | Data minimisation (GDPR Art. 5(1)(c)); privacy by design (GDPR Art. 25) |
| Visible redaction notice | Transparency to the user; human oversight (EU AI Act Art. 14) |
| Allowed-model list with provenance tags | Organisational control over approved providers; data-sovereignty choices (EU-hosted or open-weight models) |
| Blocked-term policy | Enforcement of confidentiality obligations at the point of use |
| Risk tier assigned by intended purpose and deployment context | The risk-based structure of the EU AI Act (Art. 5, Art. 6, Annex I, Annex III) |
| Admin confirmation of the proposed tier | Human accountability for classification decisions |
| Approval hold on high-risk outputs | Human oversight (EU AI Act Art. 14) |
| AI-generated label on limited-tier outputs | Transparency obligations (EU AI Act Art. 50) |
| Plain-language reasons on credit assessments | Right to explanation of individual decisions (EU AI Act Art. 86) |
| Blind screening in recruitment | Non-discrimination and bias mitigation in data used by high-risk systems (EU AI Act Art. 10) |
| Citation verification and privilege redaction in legal review | Professional obligations that apply independently of AI regulation |
| Audit log, with full content for high-risk assistants only | Record-keeping (EU AI Act Art. 12) balanced against data minimisation |

## 9. Success criteria

- Time from opening the link to the first completed task is under two minutes.
- Redaction catches every supported PII type in the bundled test prompts.
- The risk classifier assigns the expected tier to each preset assistant, and to a test assistant that describes a prohibited practice.
- Each preset assistant's safeguards trigger on its bundled test prompt.
- The audit log exports cleanly and opens in a spreadsheet.
- The demo runs on current desktop and mobile browsers.

## 10. Milestones

| # | Milestone | Output |
|---|---|---|
| M1 | PRD and repository | This document, repository, README, GitHub Pages enabled |
| M2 | Builder and chat | Model picker for seven models, chatbot, agent and harness types, streaming, API key settings |
| M3 | Governed examples | Four industry examples, create and edit |
| M4 | Governance | Redaction, policy check, audit log with export |
| M4b | Risk tiers | Classifier on save, tier-to-control mapping, domain safeguards, deployment-context switch |
| M5 | Polish and launch | Conversation branching, demo script, screenshots, live link |

## 11. Future work (beyond v0.1)

- Knowledge attachments: attach a text or PDF file to an assistant.
- Named-entity PII detection with a small local model, alongside the pattern rules.
- A server-side proxy with central key management and single sign-on.
- Role-based admin and user views.
- Conversation branching and navigation between branches.
- Additional open-weight models through OpenRouter.
- Further regulatory frameworks alongside the EU AI Act, such as Australia's voluntary AI safety standard and sector rules for health and financial services.
