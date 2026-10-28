import { loadGolden } from './lib.js';
const cases = await loadGolden();
console.log(
  `Validated ${cases.length} agent-reviewed m1-v1 cases (human review pending). Dataset validation does NOT measure model accuracy.`,
);
