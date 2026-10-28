export const MAX_MICROS = 9_000_000_000_000_000n;
export function micros(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Amount must be integer USD micros');
  const amount = BigInt(value);
  if (amount > MAX_MICROS) throw new Error('Amount exceeds supported range');
  return amount;
}
export function tokenCost(
  input: number,
  output: number,
  inputRate: bigint,
  outputRate: bigint,
): bigint {
  if (
    !Number.isSafeInteger(input) ||
    input < 0 ||
    !Number.isSafeInteger(output) ||
    output < 0 ||
    inputRate < 0n ||
    outputRate < 0n
  )
    throw new Error('Invalid usage');
  const cost = (BigInt(input) * inputRate + BigInt(output) * outputRate + 999999n) / 1000000n;
  if (cost > MAX_MICROS) throw new Error('Usage amount exceeds supported range');
  return cost;
}
