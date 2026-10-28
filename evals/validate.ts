import { loadGolden } from './lib.js';
const cases = await loadGolden();
console.log(
  `Validated ${cases.length} starter fixtures. Dataset validation does NOT measure model accuracy.`,
);
