/**
 * Sidebar text for the usage tokens. Herdr sidebars render these beside the
 * equivalents other agents publish, so the shapes deliberately match: a `Σ`
 * cumulative total and a `⊙` context meter.
 */

/** Cumulative provider usage for a whole session log. */
export interface TokenUsage {
  readonly uncachedInputTokens?: number
  readonly outputTokens?: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

/** Prompt-side occupancy of the model's context window. */
export interface ContextPressure {
  readonly contextWindow?: number
  readonly pressureTokens?: number
  readonly projectedTokens?: number
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** 999 · 575k · 128M — the magnitudes a sidebar row has room for. */
export function humanizeTokens(total: number): string {
  if (total < 1_000) return String(Math.round(total))
  if (total < 1_000_000) return `${Math.round(total / 1_000)}k`
  return `${Math.round(total / 1_000_000)}M`
}

export function formatTokenTotal(usage: TokenUsage | null | undefined): string | undefined {
  if (usage === null || usage === undefined) return undefined
  const buckets = [
    finite(usage.uncachedInputTokens),
    finite(usage.outputTokens),
    finite(usage.cacheReadTokens),
    finite(usage.cacheWriteTokens),
  ].filter((value): value is number => value !== undefined)
  if (buckets.length === 0) return undefined
  return `Σ ${humanizeTokens(buckets.reduce((sum, value) => sum + value, 0))}`
}

/**
 * DSH stores no percentage, so derive it. Without a context window only the
 * raw token count is honest — a percentage of an unknown budget is not.
 */
export function formatContextPressure(
  pressure: ContextPressure | null | undefined,
): string | undefined {
  if (pressure === null || pressure === undefined) return undefined
  const used = finite(pressure.projectedTokens) ?? finite(pressure.pressureTokens)
  if (used === undefined) return undefined
  const window = finite(pressure.contextWindow)
  if (window === undefined || window === 0) return `⊙ ${humanizeTokens(used)}`
  // Scale before dividing: (575000 / 1e6) * 100 lands on 57.499999999999996,
  // which rounds the wrong way.
  return `⊙ ${Math.round((used * 100) / window)}% (${humanizeTokens(used)})`
}
