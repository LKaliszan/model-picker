import { describe, expect, test } from 'claude-code/testing'

import { costOn, decide, familyOf, HOUR_MS, modelLabel, parsePick, type DecideInput } from './logic'

const NOW = 10_000_000

// An existing Opus chat with 100,000 tokens cached.
const chat = (over: Partial<DecideInput> = {}): DecideInput => ({
  base: 'opus',
  current: 'opus',
  need: 'sonnet',
  risky: false,
  requests: 1,
  contextTokens: 100_000,
  warm: { opus: { at: NOW, tokens: 100_000, ttlMs: HOUR_MS } },
  now: NOW,
  writeMultiplier: 1.25,
  ...over,
})

describe('cost', () => {
  test('matches the worked example', () => {
    expect(costOn('opus', chat()).toFixed(3)).toBe('0.040')
    expect(costOn('sonnet', chat()).toFixed(3)).toBe('0.260')
    expect(costOn('haiku', chat()).toFixed(3)).toBe('0.013')
  })

  test('an expired cache has to be written again', () => {
    const later = chat({ now: NOW + HOUR_MS + 1 })
    expect(costOn('opus', later) > 0.5).toBe(true)
  })
})

describe('decide', () => {
  test('one request mid-chat does not pay for a Sonnet switch', () => {
    expect(decide(chat()).kind).toBe('blocked')
  })

  test('a long enough task does', () => {
    const d = decide(chat({ requests: 20 }))
    expect(d.kind).toBe('downgrade')
    expect(d.target).toBe('sonnet')
  })

  test('Haiku pays at 100,000 tokens and not at 200,000', () => {
    expect(decide(chat({ need: 'haiku' })).target).toBe('haiku')
    const big = chat({
      need: 'haiku',
      contextTokens: 200_000,
      warm: { opus: { at: NOW, tokens: 200_000, ttlMs: HOUR_MS } },
    })
    expect(decide(big).kind).toBe('blocked')
  })

  test('a new chat has no cache to lose', () => {
    const d = decide(chat({ warm: {}, contextTokens: 25_000 }))
    expect(d.kind).toBe('downgrade')
  })

  test('a risky task never goes below your own model', () => {
    const d = decide(chat({ need: 'haiku', risky: true }))
    expect(d.kind).toBe('same')
    expect(d.target).toBe('opus')
  })

  test('a risky task brings a downgraded chat back', () => {
    const d = decide(chat({ current: 'haiku', need: 'haiku', risky: true }))
    expect(d.kind).toBe('return')
    expect(d.target).toBe('opus')
  })

  test('needing more than your own model is an upgrade', () => {
    const d = decide(chat({ base: 'sonnet', current: 'sonnet', need: 'opus' }))
    expect(d.kind).toBe('upgrade')
  })

  test('an upgrade ends once it is no longer needed', () => {
    const d = decide(chat({ base: 'sonnet', current: 'opus', need: 'haiku' }))
    expect(d.kind).toBe('return')
    expect(d.target).toBe('sonnet')
  })
})

describe('parsing', () => {
  test('reads a pick and treats unclear risk as risky', () => {
    const p = parsePick('ok {"keep":false,"model":"haiku","effort":"low","requests":99,"why":"x"}')
    expect(p).toEqual({ keep: false, model: 'haiku', effort: 'low', risky: true, requests: 40, why: 'x' })
  })

  test('refuses a model or effort outside the lists', () => {
    expect(parsePick('{"model":"gpt","effort":"low"}')).toBeNull()
    expect(parsePick('not json')).toBeNull()
  })

  test('names models with their own version', () => {
    expect(modelLabel('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelLabel('claude-haiku-5-5[1m]')).toBe('Haiku 5.5')
    expect(modelLabel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(modelLabel('claude-fable-5')).toBe('Fable 5')
    expect(modelLabel('custom-model')).toBe('custom-model')
  })

  test('knows model families', () => {
    expect(familyOf('claude-opus-5-5[1m]')).toBe('opus')
    expect(familyOf('something-else')).toBeNull()
  })
})
