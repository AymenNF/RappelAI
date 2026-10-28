import type { ModelTransport } from './model.js';

// Explicit offline plumbing test. This does not interpret text or measure AI accuracy.
export const fixtureTransport: ModelTransport = {
  provider: 'fixture',
  model: 'fixed-clarify-v1',
  async generate() {
    return {
      text: JSON.stringify({ behavior: 'clarify', calls: [] }),
      model: 'fixed-clarify-v1',
      responseId: null,
      inputTokens: 0,
      outputTokens: 0,
    };
  },
};
