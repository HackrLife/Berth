// Five governed examples, all inside Meridian Bank (a fictional bank).
// Each shows a different build type and set of safeguards, and each answers
// from its own policy document in Knowledge (see api/_samples.js).

const BLIND_SCREENING = [
  { type: 'NAME', re: '\\b(?:candidate name|full name|name)\\s*[:\\-]\\s*([^\\n,;]+)', group: 1 },
  { type: 'AGE', re: '\\bage\\s*[:\\-]\\s*(\\d{1,3})', group: 1 },
  { type: 'AGE', re: '\\b(\\d{2})\\s*(?:years old|yrs old|y\\/o)\\b', group: 1 },
  { type: 'DOB', re: '\\b(?:date of birth|dob|born)\\s*[:\\-]?\\s*([0-9A-Za-z ,/.-]{6,20}\\d{2,4})', group: 1 },
  { type: 'GENDER', re: '\\b(?:gender|sex)\\s*[:\\-]\\s*([^\\n,;]+)', group: 1 },
  { type: 'NATIONALITY', re: '\\b(?:nationality|citizenship)\\s*[:\\-]\\s*([^\\n,;]+)', group: 1 },
  { type: 'PHOTO', re: '\\b(photo(?:graph)? (?:attached|enclosed|included))', group: 1 },
];

export const TEMPLATES = [
  {
    key: 'symptom-guide',
    minutesManual: 5, // estimated minutes a person spends on this task without Berth
    industry: 'Staff health',
    name: 'Staff Health Guide',
    type: 'chatbot',
    modelId: 'claude',
    useDocs: true,
    docScope: ['Meridian Bank · Staff Health and Wellbeing Guide'],
    purpose: 'Gives Meridian Bank staff general guidance about symptoms, when to seek care, and how sick and carer\u2019s leave works.',
    usedBy: 'Clinicians or patients',
    tier: 'high',
    basis: 'Annex I · medical device software',
    rationale: 'Software that gives guidance about symptoms has a medical purpose and can qualify as a medical device, which brings it under Annex I.',
    instructions: `You are Staff Health Guide for Meridian Bank employees.
- Use the bank's Staff Health and Wellbeing Guide in the sources for care pathways, the Health Line, leave rules and certificates. Cite it like [S1].
- Explain possible common causes in plain language and say what kind of care is appropriate: self-care, a GP within days, or urgent care.
- Never give a diagnosis. Never recommend a medicine, a dose or a change to prescribed treatment.
- Always ask about duration, severity and other symptoms if they are missing.
- End every answer with: "This is general information, not medical advice. Please see a doctor or pharmacist."`,
    starters: [
      'I have had a dry cough for ten days and feel tired. Should I see someone?',
      'My son has a fever of 38.2 and a runny nose. What should I watch for, and can I take carer\u2019s leave?',
      'I have been off sick for three days. Do I need a medical certificate?',
      'I get chest pain when I run. It goes away when I stop.',
    ],
    safeguards: {
      redFlagStop: {
        terms: ['chest pain', 'crushing', 'can’t breathe', "can't breathe", 'difficulty breathing', 'face drooping', 'slurred speech', 'unconscious', 'suicidal', 'overdose', 'severe bleeding', 'seizure'],
        message: 'This may be an emergency. Call 000 (Australia), 112 (EU) or your local emergency number now, or go to the nearest emergency department. Berth has not sent this message to the model.',
      },
      requireOutput: [{ label: '"Not medical advice" statement', re: 'not medical advice', message: 'The answer is missing the "not medical advice" statement.' }],
    },
  },
  {
    key: 'loan-checker',
    minutesManual: 20, // estimated minutes a person spends on this task without Berth
    industry: 'Lending',
    name: 'Loan Eligibility Checker',
    type: 'agent',
    modelId: 'gpt',
    models: { router: 'mistral', fast: 'gpt', strong: 'gpt' },
    useDocs: true,
    docScope: ['Meridian Bank · Personal Lending Credit Policy'],
    purpose: 'Assesses a personal loan application against Meridian Bank\u2019s Personal Lending Credit Policy and proposes an outcome for a credit officer.',
    usedBy: 'Lenders or insurers',
    tier: 'high',
    basis: 'Annex III(5)(b) · creditworthiness',
    rationale: 'Evaluating the creditworthiness of natural persons is listed as high risk in Annex III.',
    tools: ['calculator', 'knowledge'],
    instructions: `You are Loan Eligibility Checker, supporting a credit officer.
- Search the bank's Personal Lending Credit Policy before assessing (search_documents, or search_knowledge if that is the tool available) and cite it. Use calculator for every ratio and repayment figure.
- Proposed outcome must be one of: Meets criteria, Refer to credit officer, Does not meet criteria.
- Structure the answer as: Proposed outcome, Reasons (numbered, in plain language the applicant could understand), Figures used, Information missing.
- You propose; the credit officer decides. Never state that an application is approved or declined as final.
- Do not use age, gender, marital status, nationality or postcode as reasons.`,
    knowledge: `Meridian Bank personal loan criteria (summary)

Serviceability: total monthly debt repayments including the new loan must not exceed 35% of gross monthly income.

Loan size: between $5,000 and $50,000. Terms of 1 to 7 years.

Interest rate for assessment: 11.5% per year, repayments calculated as a standard amortising loan.

Employment: at least 6 months in current role, or 2 years self-employed with tax returns.

Credit history: no defaults in the last 3 years. Up to two late payments in 12 months may be accepted with an explanation.

Living expenses: use the declared figure or $2,100 per month for a single applicant, whichever is higher.`,
    starters: [
      'Applicant earns $92,000 a year, has a $450/month car loan, and asks for $25,000 over 5 years. 3 years in current job, no defaults. Assess it.',
      'Self-employed 14 months, income $70,000, wants $40,000 over 3 years.',
    ],
    safeguards: {
      requireOutput: [{ label: 'Plain-language reasons', re: 'reason', message: 'No reasons section found. Every proposed outcome needs reasons the applicant could understand (Art. 86).' }],
      forbidOutput: [{ label: 'No final decision', re: '\\b(?:application (?:is )?(?:approved|declined)|final decision)\\b', message: 'The answer reads as a final decision. Only the credit officer can decide.' }],
    },
  },
  {
    key: 'contract-reviewer',
    minutesManual: 25, // estimated minutes a person spends on this task without Berth
    industry: 'Legal',
    name: 'Contract Reviewer',
    type: 'chatbot',
    modelId: 'mistral',
    useDocs: true,
    docScope: ['Meridian Bank · Supplier Contracting Standards'],
    purpose: 'Reviews supplier contract clauses against Meridian Bank\u2019s Supplier Contracting Standards and suggests redlines for the in-house legal team.',
    usedBy: 'Law firm',
    tier: 'minimal',
    basis: 'No Annex III use for in-house contract review',
    rationale: 'Reviewing supplier contracts for a legal team is not a listed high-risk use. Professional duties still require confidentiality and verified citations.',
    tierByContext: {
      'Court or tribunal': { tier: 'high', basis: 'Annex III(8)(a) · administration of justice', rationale: 'Used by a judicial authority to research and interpret facts and law, which is listed as high risk.' },
    },
    protectedTerms: ['Harbourline Logistics', 'Kestrel Mining'],
    instructions: `You are Contract Reviewer, assisting Meridian Bank's in-house lawyers.
- Check each clause against the bank's Supplier Contracting Standards in the sources and cite the section like [S1].
- For each clause: summarise it, list obligations by party, rate risk (low, medium, high) with a reason, say whether it needs escalation to General Counsel, and suggest a redline.
- Cite legislation or cases only when necessary and say they must be verified.
- Client names appear as placeholders such as [CLIENT_1]. Keep them as placeholders.`,
    starters: [
      'Review this: "Harbourline Logistics shall indemnify the Supplier against all losses arising from or in connection with this Agreement, without limitation."',
      'The supplier wants 60-day payment terms and to host our customer data in Singapore. What do our standards say?',
      'Review: "This Agreement renews automatically for successive 3-year terms unless terminated with 12 months\u2019 notice."',
    ],
    safeguards: {
      citationCheck: true,
    },
  },
  {
    key: 'candidate-screener',
    minutesManual: 15, // estimated minutes a person spends on this task without Berth
    industry: 'Recruitment',
    name: 'Candidate Screener',
    type: 'harness',
    modelId: 'gpt',
    models: { router: 'mistral', fast: 'gpt', strong: 'gpt', reviewer: 'claude' },
    useDocs: true,
    docScope: ['Meridian Bank · Recruitment and Fair Hiring Policy'],
    purpose: 'Assesses CVs against a Meridian Bank job description under its Recruitment and Fair Hiring Policy, and proposes a shortlist for a recruiter.',
    usedBy: 'HR and recruitment',
    tier: 'high',
    basis: 'Annex III(4)(a) · recruitment and selection',
    rationale: 'AI used to filter applications and evaluate candidates is listed as high risk in Annex III.',
    tools: ['knowledge'],
    chosenSafeguards: ['blindScreening', 'noReject'],
    harness: {
      approval: true,
      fullLog: true,
      aiLabel: true,
      review: true,
      retry: true,
      maxSteps: 4,
      toolModes: { knowledge: 'auto' },
    },
    instructions: `You are Candidate Screener, supporting a recruiter.
- First search the bank's Recruitment and Fair Hiring Policy for the job description and shortlisting rules (search_documents, or search_knowledge if that is the tool available), and cite it.
- Assess the CV against each essential and desirable criterion: Met, Partly met or Not evidenced, with the evidence.
- Recommend either "Shortlist" or "Refer to recruiter". You may never reject a candidate.
- Identifying details are removed before you see the CV. Do not guess them.`,
    knowledge: `Job description: Senior Data Analyst, Retail Credit Analytics, Sydney

Essential: 5+ years in analytics; production SQL; Python for analysis; presenting findings to senior stakeholders.

Desirable: cloud data warehouse (BigQuery, Snowflake or Redshift); experience in banking or financial services; experimentation or A/B testing; credit risk models.

Shortlisting: shortlist when all essential criteria are met; refer to the recruiter when one essential criterion is only partly met. Never reject.

Location: hybrid, three days a week in the Sydney office.`,
    starters: [
      'Screen this CV.\nName: Priya Nair\nAge: 34\nNationality: Indian\nEmail: priya.nair@mailbox.com\nPhone: 0412 555 019\n6 years in analytics at a retail bank. Daily SQL and Python. Led a churn model that cut attrition by 9%. Presents monthly to the executive team.',
    ],
    safeguards: {
      extraRedaction: BLIND_SCREENING,
      extraRedactionTitle: 'Blind screening',
      extraRedactionDetail: 'Name, age, date of birth, gender, nationality and photo references removed',
      forbidOutput: [{ label: 'Shortlist only, never reject', re: '\\breject(?:ed|ion)?\\b', message: 'The answer mentions rejection. The screener may only shortlist or refer to a recruiter.' }],
    },
  },
  {
    key: 'policy-assistant',
    minutesManual: 6, // estimated minutes a person spends on this task without Berth
    industry: 'Operations',
    name: 'Policy Assistant',
    type: 'chatbot',
    modelId: 'gpt',
    useDocs: true,
    docScope: ['Meridian Bank · Staff Handbook: Travel, Expenses, Security and AI Use'],
    purpose: 'Answers Meridian Bank staff questions from the Staff Handbook on travel, expenses, gifts, security and AI use, citing the passages it used.',
    usedBy: 'Internal team',
    tier: 'minimal',
    basis: 'No Annex III use: internal policy Q&A',
    rationale: 'Answering staff questions from internal policies is not a listed high-risk use. Answers cite their sources so staff can check them.',
    instructions: `You are Policy Assistant for Meridian Bank staff.
- Answer only from the sources provided with each question, and cite them like [S1].
- If the sources do not cover the question, say so and suggest who to ask. Do not guess.
- Quote exact limits and numbers from the sources. Keep answers short.`,
    starters: [
      'How much can I spend on a hotel in Sydney?',
      'Can I paste a customer\u2019s account details into a public AI chatbot?',
      'A supplier offered me concert tickets worth $200. Can I accept?',
      'I lost my laptop at the airport. What do I do?',
    ],
    safeguards: {},
  },
];
