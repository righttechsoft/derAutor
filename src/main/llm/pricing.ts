/** USD per million tokens. Cache read = 0.1x input, cache write (5m ephemeral) = 1.25x input. */
const MODEL_PRICES: [prefix: string, inPerM: number, outPerM: number][] = [
  ['claude-fable-5', 10, 50],
  ['claude-opus-4', 5, 25],
  ['claude-sonnet-5', 3, 15],
  ['claude-sonnet-4', 3, 15],
  ['claude-haiku-4-5', 1, 5]
]

export function priceFor(model: string): { inPerM: number; outPerM: number } {
  for (const [prefix, inPerM, outPerM] of MODEL_PRICES) {
    if (model.startsWith(prefix)) return { inPerM, outPerM }
  }
  // Unknown model: assume Opus-tier so the dashboard overestimates rather than hides cost
  return { inPerM: 5, outPerM: 25 }
}

export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number
): number {
  const { inPerM, outPerM } = priceFor(model)
  return (
    (inputTokens * inPerM +
      outputTokens * outPerM +
      cacheReadTokens * inPerM * 0.1 +
      cacheWriteTokens * inPerM * 1.25) /
    1_000_000
  )
}

/** Approximate gpt-image-1 cost per image by quality (portrait/landscape 1536px edge). */
export function imageCostUsd(quality: 'low' | 'medium' | 'high'): number {
  return quality === 'high' ? 0.25 : quality === 'medium' ? 0.07 : 0.02
}
