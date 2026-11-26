import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type World = {
  sent: { model: string; effort: unknown }[]
  spawned: (string | undefined)[]
  asked: string[]
  judged: string[]
  stored: Record<string, unknown>
}

// newChat: no request yet. stored: what earlier chats saved. usage: what each request reports.
type Options = { newChat?: boolean; stored?: Record<string, unknown>; usage?: object }

// Stands for the engine: records what reaches it.
function engine(on: On, verdict: object, answer: (options: string[]) => string, opts: Options = {}): World {
  const world: World = { sent: [], spawned: [], asked: [], judged: [], stored: { ...opts.stored } }
  on('command.register', () => ({ value: { command: 'model-picker' } }))
  on('store.get', (_, e) => ({ value: world.stored[e.key] as never }))
  on('store.set', (_, e) => {
    world.stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: opts.newChat ? undefined : 25_000, window: 1_000_000 }, rateLimits: [] } }))
  on('clock.now', () => ({ value: 1_000 }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', (_, e) => {
    world.judged.push(e.prompt)
    return { value: { isAnswered: true, text: JSON.stringify(verdict), usage: ZERO } }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    const labels = q.options.map(o => o.label)
    world.asked.push(q.question)
    return { result: { questions: e.questions, answers: { [q.question]: answer(labels) } } }
  })
  on('turn.step', async function* (_, e) {
    world.sent.push({ model: e.model, effort: e.effort })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: (opts.usage ?? null) as never }
  })
  on('agent.spawn', (_, e) => {
    world.spawned.push(e.model)
    return { model: e.model ?? e.parentModel }
  })
  return world
}

async function prompt($: Engine, text: string) {
  await $.prompt.submit({ text, origin: { kind: 'composer' } })
}

async function step($: Engine, index = 0) {
  const stream = $.turn.step({ turnId: 't', index, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 })
  for (;;) if ((await stream.next()).done) return
}

const SIMPLE = { keep: false, model: 'haiku', effort: 'low', risky: false, requests: 1, why: 'A short rewrite' }

test('a yes switches model and effort on every step of the task', async ($, on) => {
  const world = engine(on, SIMPLE, labels => labels[0]!)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'make this friendlier')
  await step($, 0)
  await step($, 1)
  expect(world.asked.length).toBe(1)
  expect(world.sent).toEqual([
    { model: 'claude-haiku-5-5', effort: 'low' },
    { model: 'claude-haiku-5-5', effort: 'low' },
  ])
})

test('keeping changes nothing, and a declined model is not offered again', async ($, on) => {
  const world = engine(on, SIMPLE, () => 'Keep current')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'make this friendlier')
  await step($)
  await prompt($, 'and this one')
  await step($)
  expect(world.sent.every(s => s.model === 'claude-opus-5-5' && s.effort === 'high')).toBe(true)
  expect(world.asked[1]!.includes('Haiku')).toBe(false)
})

test('a desktop message is judged without the app notes, and a notification is not', async ($, on) => {
  const world = engine(on, SIMPLE, labels => labels[0]!)
  const judged = world.judged
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'a task finished', origin: { kind: 'task-notification' } })
  await step($)
  await $.prompt.submit({
    text: '<system-reminder>long app note</system-reminder>\nmake this friendlier',
    origin: { kind: 'sdk' },
  })
  await step($)
  expect(judged.length).toBe(1)
  expect(judged[0]!.includes('long app note')).toBe(false)
  expect(judged[0]!.includes('make this friendlier')).toBe(true)
  expect(world.sent[1]!.model).toBe('claude-haiku-5-5')
})

test('a new chat is priced from the size its first request had', async ($, on) => {
  engine(on, SIMPLE, () => 'Keep current', { newChat: true, stored: { startTokens: 105_000 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'make this friendlier')
  await step($)
  const status = await $.command.run({ command: 'model-picker', args: '' })
  expect(String(status.text).includes('Haiku 5.5 $0.11, staying $0.86')).toBe(true)
})

test('the first request of a chat is remembered for the next one', async ($, on) => {
  const usage = { ...ZERO, input_tokens: 5, cache_read_input_tokens: 44_685, cache_creation_input_tokens: 60_260, model: 'claude-opus-5-5' }
  const world = engine(on, SIMPLE, () => 'Keep current', { newChat: true, usage })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'make this friendlier')
  await step($, 0)
  await step($, 1)
  expect(world.stored['startTokens']).toBe(104_950)
})

test('a risky task keeps your model', async ($, on) => {
  const world = engine(on, { ...SIMPLE, risky: true }, labels => labels[0]!)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'delete the old customer records')
  await step($)
  expect(world.sent[0]!.model).toBe('claude-opus-5-5')
})

test('auto sets effort by itself and still asks before changing the model', async ($, on) => {
  const world = engine(on, SIMPLE, () => 'Keep current')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'model-picker', args: 'auto' })
  await prompt($, 'make this friendlier')
  await step($)
  expect(world.asked.length).toBe(1)
  expect(world.sent[0]).toEqual({ model: 'claude-opus-5-5', effort: 'low' })
})

test('off leaves everything alone', async ($, on) => {
  const world = engine(on, SIMPLE, labels => labels[0]!)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'model-picker', args: 'off' })
  await prompt($, 'make this friendlier')
  await step($)
  expect(world.asked.length).toBe(0)
  expect(world.sent[0]).toEqual({ model: 'claude-opus-5-5', effort: 'high' })
})

const FOOTER = { plugin: 'model-picker', component: 'SessionMode', props: { modes: [] } } as const

test('the footer shows the switched model and effort, on both surfaces', async ($, on) => {
  engine(on, SIMPLE, labels => labels[0]!)
  // Stands for Claude Code's own footer, which draws the labels it is handed.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.modes.join(' & ')}</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'make this friendlier')
  await step($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...FOOTER, surface })
    expect((await ui.find({ type: 'Text', text: /Picker: Haiku 5\.5 · Low/ }))?.text).toBe('Picker: Haiku 5.5 · Low')
    await ui.unmount()
  }
})

test('the footer shows your own choice when nothing was changed', async ($, on) => {
  engine(on, SIMPLE, () => 'Keep current')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await prompt($, 'make this friendlier')
  await step($)
  const ui = await $.ui.mount({ ...FOOTER, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Running/ }))?.text).toBe('Running: Opus 5.5 · High')
  await ui.unmount()
})

const SPAWN = {
  tool_use_id: 'a',
  prompt: 'list the files',
  description: 'List files',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5-5',
} as const

test('a simple subagent gets a cheaper model', async ($, on) => {
  const world = engine(on, SIMPLE, () => '')
  await $.agent.spawn(SPAWN)
  expect(world.spawned).toEqual(['claude-haiku-5-5'])
})

test('subagents with a chosen model, their own type, or risk are left alone', async ($, on) => {
  const world = engine(on, SIMPLE, () => '')
  await $.agent.spawn({ ...SPAWN, model: 'opus' })
  await $.agent.spawn({ ...SPAWN, subagentType: 'Explore' })
  expect(world.spawned).toEqual(['opus', undefined])
})
