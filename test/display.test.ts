import assert from 'node:assert/strict'
import test from 'node:test'

import { formatContextPressure, formatTokenTotal, humanizeTokens } from '../src/display.ts'

test('token magnitudes collapse to sidebar width', () => {
  assert.equal(humanizeTokens(0), '0')
  assert.equal(humanizeTokens(999), '999')
  assert.equal(humanizeTokens(1_000), '1k')
  assert.equal(humanizeTokens(575_432), '575k')
  assert.equal(humanizeTokens(999_999), '1000k')
  assert.equal(humanizeTokens(128_000_000), '128M')
})

test('the cumulative total sums every usage bucket', () => {
  assert.equal(
    formatTokenTotal({
      uncachedInputTokens: 1_000,
      outputTokens: 2_000,
      cacheReadTokens: 120_000_000,
      cacheWriteTokens: 8_000_000,
    }),
    'Σ 128M',
  )

  // A partially reported projection still yields an honest subtotal.
  assert.equal(formatTokenTotal({ outputTokens: 500 }), 'Σ 500')
})

test('an absent or empty usage projection reports nothing', () => {
  assert.equal(formatTokenTotal(undefined), undefined)
  assert.equal(formatTokenTotal(null), undefined)
  assert.equal(formatTokenTotal({}), undefined)
  // Negatives and non-finite values are dropped rather than rendered.
  assert.equal(formatTokenTotal({ outputTokens: Number.NaN }), undefined)
  assert.equal(formatTokenTotal({ outputTokens: -5 }), undefined)
})

test('the context meter derives the percentage DSH does not store', () => {
  assert.equal(
    formatContextPressure({ contextWindow: 1_000_000, projectedTokens: 575_000 }),
    '⊙ 58% (575k)',
  )
  // pressureTokens stands in when no projection delta has been recorded.
  assert.equal(
    formatContextPressure({ contextWindow: 200_000, pressureTokens: 100_000 }),
    '⊙ 50% (100k)',
  )
})

test('without a context window the meter shows tokens, not a false percentage', () => {
  assert.equal(formatContextPressure({ projectedTokens: 12_500 }), '⊙ 13k')
  assert.equal(formatContextPressure({ projectedTokens: 12_500, contextWindow: 0 }), '⊙ 13k')
})

test('an absent context projection reports nothing', () => {
  assert.equal(formatContextPressure(undefined), undefined)
  assert.equal(formatContextPressure(null), undefined)
  assert.equal(formatContextPressure({}), undefined)
  assert.equal(formatContextPressure({ contextWindow: 200_000 }), undefined)
})
