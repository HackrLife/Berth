// Model catalogue. Each entry is one selectable model in the builder.
// `provider` decides which API adapter and which API key is used.
// `defaultModel` is only a starting point: Settings can load the provider's
// live model list and store a different model id per entry.

export const PROVIDERS = {
  anthropic: { label: 'Anthropic', keyLabel: 'Anthropic API key', keyHint: 'sk-ant-…', docs: 'https://console.anthropic.com/settings/keys' },
  openai: { label: 'OpenAI', keyLabel: 'OpenAI API key', keyHint: 'sk-…', docs: 'https://platform.openai.com/api-keys' },
  google: { label: 'Google', keyLabel: 'Gemini API key', keyHint: 'AIza…', docs: 'https://aistudio.google.com/apikey' },
  xai: { label: 'xAI', keyLabel: 'xAI API key', keyHint: 'xai-…', docs: 'https://console.x.ai' },
  openrouter: { label: 'OpenRouter', keyLabel: 'OpenRouter API key (open-weight models)', keyHint: 'sk-or-…', docs: 'https://openrouter.ai/keys' },
};

export const MODELS = [
  {
    id: 'claude', name: 'Claude', maker: 'Anthropic', provider: 'anthropic',
    weights: 'closed', region: 'US', defaultModel: 'claude-sonnet-5',
    note: 'Strong reasoning and long documents',
  },
  {
    id: 'gpt', name: 'GPT', maker: 'OpenAI', provider: 'openai',
    weights: 'closed', region: 'US', defaultModel: 'gpt-5-mini',
    note: 'General purpose, broad tool support',
  },
  {
    id: 'gemini', name: 'Gemini', maker: 'Google', provider: 'google',
    weights: 'closed', region: 'US', defaultModel: 'gemini-2.5-flash',
    note: 'Fast, large context window',
  },
  {
    id: 'grok', name: 'Grok', maker: 'xAI', provider: 'xai',
    weights: 'closed', region: 'US', defaultModel: 'grok-3-mini',
    openrouterModel: 'x-ai/grok-3-mini',
    note: 'Direct or routed through OpenRouter',
  },
  {
    id: 'mistral', name: 'Mistral', maker: 'Mistral AI', provider: 'openrouter',
    weights: 'open', region: 'EU', defaultModel: 'mistralai/mistral-small-3.2-24b-instruct',
    note: 'European open-weight model',
  },
  {
    id: 'llama', name: 'Llama', maker: 'Meta', provider: 'openrouter',
    weights: 'open', region: 'Any', defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    note: 'Open weights, self-hostable',
  },
  {
    id: 'qwen', name: 'Qwen', maker: 'Alibaba', provider: 'openrouter',
    weights: 'open', region: 'Any', defaultModel: 'qwen/qwen-2.5-72b-instruct',
    note: 'Open weights, strong multilingual',
  },
];

export function modelById(id) {
  return MODELS.find((m) => m.id === id);
}

export function provenance(m) {
  return `${m.region} · ${m.weights === 'open' ? 'open weights' : 'closed weights'}`;
}
