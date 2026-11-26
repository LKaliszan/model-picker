import { describe, expect, test } from 'claude-code/testing'

import {
  addJudge,
  addRequest,
  costOn,
  decide,
  EMPTY_TALLY,
  familyOf,
  HOUR_MS,
  modelLabel,
  netSaving,
  parsePick,
  readTally,
  tallyLines,
  usageUsd,
  type DecideInput,
} from './logic'

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

describe('savings', () => {
  const u = { input_tokens: 0, output_tokens: 1000, cache_read_input_tokens: 44_685, cache_creation_input_tokens: 60_268 }

  test('prices a request like the cost estimate does', () => {
    // Haiku above 100,000 tokens: reads 0.05, writes 0.5 x 1.25, output 2.5 per million.
    expect(usageUsd('haiku', u).toFixed(4)).toBe('0.0424')
  })

  test('a switch in a new chat compares with writing the same cache on your model', () => {
    const t = addRequest(EMPTY_TALLY, { usage: u, ran: 'haiku', own: 'opus', effortChanged: true, ownWarmTokens: 0 })
    expect(t.switched).toBe(1)
    expect(t.effortOnly).toBe(0)
    expect(t.ownUsd.toFixed(4)).toBe('0.3303')
    expect(netSaving(t) > 0.28).toBe(true)
  })

  test('a switch away from a warm cache compares with reading it instead', () => {
    const warm = addRequest(EMPTY_TALLY, { usage: u, ran: 'haiku', own: 'opus', effortChanged: false, ownWarmTokens: 200_000 })
    // All 104,953 prompt tokens read on Opus at 0.2, plus 1,000 output at 20.
    expect(warm.ownUsd.toFixed(4)).toBe('0.0410')
    // Rebuilding the cache on Haiku cost a little more than reading Opus's for this one request.
    expect(netSaving(warm) < 0).toBe(true)
  })

  test('a switch up to a stronger model counts as extra cost, not lost saving', () => {
    const t = addRequest(EMPTY_TALLY, { usage: u, ran: 'opus', own: 'sonnet', effortChanged: false, ownWarmTokens: 200_000 })
    expect(t.stronger).toBe(1)
    expect(t.cheaper).toBe(0)
    expect(t.cheaperSavedUsd).toBe(0)
    // Opus writes the cache (0.3303) where Sonnet would have read it (0.0205).
    expect(t.strongerExtraUsd.toFixed(4)).toBe('0.3098')
    expect(tallyLines(t)).toContain('Stronger models: $0.31 extra')
    expect(tallyLines(t)).toContain('Cheaper models: none used')
  })

  test('an effort-only change is counted but not credited', () => {
    const t = addRequest(EMPTY_TALLY, { usage: u, ran: 'opus', own: 'opus', effortChanged: true, ownWarmTokens: 0 })
    expect(t.effortOnly).toBe(1)
    expect(netSaving(t)).toBe(0)
  })

  test('judge calls are paid out of the saving', () => {
    const t = addJudge(EMPTY_TALLY, { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'haiku')
    expect(netSaving(t).toFixed(2)).toBe('-0.50')
    expect(tallyLines(t).at(-1)).toBe('Overall estimated extra cost: $0.50')
  })

  test('a stored tally with bad values reads as empty fields', () => {
    expect(readTally({ requests: 3, actualUsd: 'x', ownUsd: -1, cheaperSavedUsd: -0.2 })).toEqual({ ...EMPTY_TALLY, requests: 3, cheaperSavedUsd: -0.2 })
    expect(readTally(null)).toEqual(EMPTY_TALLY)
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
