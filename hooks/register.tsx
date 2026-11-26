import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import {
  decide,
  familyOf,
  FIVE_MIN_MS,
  HOUR_MS,
  IDS,
  JUDGE_SYSTEM,
  judgePrompt,
  LEVEL_NAMES,
  LEVELS,
  MODEL_NAMES,
  modelLabel,
  money,
  tokenCount,
  cheaperText,
  strongerText,
  addJudge,
  addRequest,
  EMPTY_TALLY,
  netSaving,
  readTally,
  tallyLines,
  type Tally,
  type Usage,
  parsePick,
  RANK,
  type Decision,
  type Family,
  type Level,
  type Pick,
  type WarmMap,
} from './logic'

const JUDGE_MODEL = IDS.haiku
// A new chat's first request carries the system prompt, tools and instructions. Until one has been measured, assume this.
const DEFAULT_START = 100_000
// The measured size of a new chat's first request, kept across chats.
let startTokens = 0
// A new name: values saved by 0.2.0 could come from a reload in a long chat.
const START_KEY = 'chatStartTokens'
// Totals from 0.2.0 have no split between cheaper and stronger models, so counting starts again.
const TOTALS_KEY = 'totalsBySwitch'
// A conversation's first request carries the first message and few others.
const CHAT_START_MESSAGES = 3
// Only these agent types have no model of their own that a rewrite could raise or replace.
const ROUTABLE_AGENTS = ['general-purpose', 'claude']
// Prompt sources that can be a person typing. Notifications, schedules, other sessions and plugins are left alone.
const TYPED_ORIGINS: readonly string[] = ['composer', 'bridge', 'sdk', 'unclassified']

/** ask: confirm every change. auto: set effort alone, still confirm a model change. */
type Mode = 'ask' | 'auto' | 'off'

// A reload starts these over, which drops back to the person's own model and effort.
let mode: Mode = 'ask'
let route: Family | null = null
let effort: Level | null = null
let baseModel = ''
let baseEffort = ''
let held: string | null = null
let warm: WarmMap = {}
let contextTokens = 0
let writeMultiplier = 2
let ttlMs = FIVE_MIN_MS
/** Cheaper models the person turned down: not offered again until reset. */
const declined = new Set<Family>()
let lastDecision = 'none yet'
let lastRequest = 'none yet'

/** What the main chat's latest request used, for the footer label. */
type Live = { model: string; effort: string; changed: boolean }
let live: Live | null = null
const ACCENT = '#d97757'

function liveLabel(l: Live) {
  return `${modelLabel(l.model)}${l.effort ? ` · ${l.effort in LEVEL_NAMES ? LEVEL_NAMES[l.effort as Level] : l.effort}` : ''}`
}

// ---- Savings dashboard: this chat in memory, all chats in the mod's store ----
const PANE = 'model-picker-stats'
const STATS_NOTES = [
  'Not your bill. On a subscription, usage is not billed this way.',
  '"Your own models" assumes the same tokens and answers, reading their cache where it was still warm.',
  'Effort-only changes are not credited. Clear counts with /model-picker stats clear.',
]
type Scope = 'chat' | 'all'
let scope: Scope = 'chat'
let chatTally: Tally = { ...EMPTY_TALLY }
let allTally: Tally = { ...EMPTY_TALLY }
/** Subagents the picker started on a cheaper model, with the model they would have used. */
const movedAgents = new Map<string, Family>()

async function tally($: EngineInterface, add: (t: Tally) => Tally) {
  chatTally = add(chatTally)
  try {
    // Read again first, so another open chat's counts are not overwritten.
    allTally = add(readTally(await $.store.get(TOTALS_KEY)))
    await $.store.set(TOTALS_KEY, allTally)
  } catch (err) {
    await log($, `totals not saved: ${err instanceof Error ? err.message : String(err)}`)
  }
  redraw($)
}

function warmTokens(family: Family | null, now: number) {
  const w = family ? warm[family] : undefined
  return w && now - w.at < w.ttlMs ? w.tokens : 0
}

function reset() {
  route = null
  effort = null
  held = null
  declined.clear()
}

function redraw($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The next redraw picks it up.
  }
}

async function log($: EngineInterface, line: string) {
  try {
    const home = $.plugin.root.replace(/\\/g, '/').split('/.claude/')[0] ?? ''
    const path = `${home}/.claude/mods-logs/model-picker.log`
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    await $.fs.write(path, `${old.slice(-20_000)}${new Date(await $.clock.now()).toISOString()} ${line}\n`)
  } catch {
    // A log is never worth failing a request for.
  }
}

async function judge($: EngineInterface, task: string, previousReply: string): Promise<Pick | null> {
  const r = await $.model.complete({
    model: JUDGE_MODEL,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(task, previousReply),
    maxTokens: 800,
    effort: 'low',
    timeoutMs: 20_000,
  })
  if (r.usage) await tally($, t => addJudge(t, r.usage as Usage, 'haiku'))
  if (!r.isAnswered) throw new Error(`judge gave no answer: ${r.reason}`)
  return parsePick(r.text)
}

async function previousReply($: EngineInterface) {
  const messages = await $.session.messages()
  return [...messages].reverse().find(m => m.role === 'assistant' && m.text.trim())?.text ?? ''
}

async function ask($: EngineInterface, question: string, options: string[]) {
  try {
    return await $.ui.ask(question, { options, header: 'Routing' })
  } catch {
    // Dismissed, or nobody to ask: nothing changes.
    return ''
  }
}

function setRoute(target: Family, base: Family) {
  route = target === base ? null : target
}

// Judges the held prompt and updates the route and effort, asking where the mode says to.
async function choose($: EngineInterface, task: string, runsEffort: Level | null) {
  const base = familyOf(baseModel)
  if (!base) {
    lastDecision = `your model ${baseModel} is not one the picker knows, nothing changed`
    await log($, lastDecision)
    return
  }
  const p = await judge($, task, await previousReply($))
  if (!p) {
    lastDecision = 'the judge reply could not be read, nothing changed'
    return
  }
  if (p.keep) {
    lastDecision = 'follow-up, kept as it was'
    return
  }

  const current = route ?? base
  let tokens = contextTokens
  // A chat with no request yet: its first one will carry the usual start plus this prompt (about 4 characters per token).
  if (!tokens) tokens = (await $.session.usage()).context.tokens ?? (startTokens || DEFAULT_START) + Math.ceil(task.length / 4)
  const d: Decision = decide({
    base,
    current,
    need: p.model,
    risky: p.risky,
    requests: p.requests,
    contextTokens: tokens,
    warm,
    now: await $.clock.now(),
    writeMultiplier,
  })
  lastDecision =
    `needs ${MODEL_NAMES[p.model]}, ${LEVEL_NAMES[p.effort]} effort, ${p.risky ? 'risky' : 'not risky'}, ` +
    `about ${p.requests} requests. Model result: ${d.kind}` +
    (d.target === current ? '' : ` (${MODEL_NAMES[d.target]} ${money(d.switchUsd)}, staying ${money(d.stayUsd)})`)
  await log($, lastDecision)

  // Going back to the person's own model needs no question.
  if (d.kind === 'return') {
    setRoute(d.target, base)
    $.ui.toast(`Back to your model, ${MODEL_NAMES[base]}`)
  }

  const offersModel = d.kind === 'upgrade' || (d.kind === 'downgrade' && !declined.has(d.target))
  // With no effort on the request there is nothing to compare with or set.
  const offersEffort = runsEffort !== null && p.effort !== runsEffort

  if (mode === 'auto' && runsEffort !== null) effort = p.effort

  const asksEffort = mode === 'ask' && offersEffort
  if (!offersModel && !asksEffort) {
    redraw($)
    return
  }

  const now = route ?? base
  const reason = p.why ? ` Why: ${p.why}.` : ''
  if (!offersModel) {
    const yes = `Use ${LEVEL_NAMES[p.effort]} effort`
    const answer = await ask(
      $,
      `${LEVEL_NAMES[p.effort]} effort fits this task better than ${LEVEL_NAMES[runsEffort!]}.${reason} Change it?`,
      [yes, 'Keep current'],
    )
    if (answer === yes) effort = p.effort
    redraw($)
    return
  }

  const estimate =
    ` Estimate for this task: ${MODEL_NAMES[d.target]} ${money(d.switchUsd)}, ` +
    `${MODEL_NAMES[now]} ${money(d.stayUsd)}.`
  const both = asksEffort ? `Use both` : `Switch model`
  const effortOnly = 'Effort only'
  const keep = 'Keep current'
  const what = asksEffort ? ` with ${LEVEL_NAMES[p.effort]} effort` : ''
  const answer = await ask(
    $,
    `${d.kind === 'upgrade' ? 'This task needs a stronger model.' : 'A cheaper model should handle this.'}` +
      ` Use ${MODEL_NAMES[d.target]}${what} instead of ${MODEL_NAMES[now]}?${reason}${estimate}`,
    asksEffort ? [both, effortOnly, keep] : [both, keep],
  )
  if (answer === both) {
    setRoute(d.target, base)
    if (asksEffort) effort = p.effort
  } else {
    if (answer === effortOnly) effort = p.effort
    if (answer && d.kind === 'downgrade') declined.add(d.target)
  }
  redraw($)
}

async function record($: EngineInterface, asked: string, usage: TurnUsage, isChatStart: boolean) {
  const now = await $.clock.now()
  const read = usage.cache_read_input_tokens
  const written = usage.cache_creation_input_tokens
  if ((usage.ephemeral_1h_input_tokens ?? 0) > 0) {
    ttlMs = HOUR_MS
    writeMultiplier = 2
  } else if ((usage.ephemeral_5m_input_tokens ?? 0) > 0) {
    ttlMs = FIVE_MIN_MS
    writeMultiplier = 1.25
  }
  // Only a conversation's real first request shows what a new chat costs. After a reload,
  // the mod's memory is empty, but the chat is not, so an empty memory is not enough.
  if (isChatStart) {
    startTokens = usage.input_tokens + read + written
    await $.store.set(START_KEY, startTokens)
  }
  contextTokens = usage.input_tokens + read + written + usage.output_tokens
  const family = familyOf(usage.model)
  if (family) warm[family] = { at: now, tokens: contextTokens, ttlMs }
  lastRequest = `asked ${asked}, answered by ${usage.model}, cache read ${read}, cache written ${written}`
  await log($, lastRequest)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'model-picker',
      description: 'Model and effort routing. ask, auto, off, reset, stats, or no word for status',
      argumentHint: '[ask|auto|off|reset|stats|stats close|stats clear]',
    })
    const saved = await $.store.get('mode')
    mode = saved === 'auto' || saved === 'off' ? saved : 'ask'
    allTally = readTally(await $.store.get(TOTALS_KEY))
    const start = Number(await $.store.get(START_KEY))
    startTokens = Number.isFinite(start) && start > 0 ? start : 0
    return next(e)
  })

  // /clear starts an empty conversation.
  on('session.end', async (_, e, next) => {
    if (e.reason === 'clear') {
      reset()
      live = null
      chatTally = { ...EMPTY_TALLY }
      movedAgents.clear()
      warm = {}
      contextTokens = 0
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    // A host app may label a typed message `sdk` or `unclassified`, so those count too.
    if (!TYPED_ORIGINS.includes(kind)) {
      await log($, `prompt not judged: it came from "${kind}"`)
      return next(e)
    }
    // Notes the app adds around the first message are not the task.
    const text = e.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    held = mode === 'off' || !text || text.startsWith('/') ? null : text
    await log($, `prompt from "${kind}": ${held === null ? 'not judged' : 'will be judged'}`)
    return next(e)
  }).catch((_, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    // Subagents are routed when they start, not here. Only the ones the picker moved are counted.
    if (e.agentId !== undefined) {
      const own = movedAgents.get(e.agentId)
      const result = yield* next(e)
      const ran = result.usage ? familyOf(result.usage.model) : null
      if (own && ran && result.usage) {
        const usage = result.usage
        await tally($, t => addRequest(t, { usage, ran, own, effortChanged: false, ownWarmTokens: 0 }))
      }
      return result
    }

    const runs = typeof e.effort === 'string' ? e.effort : ''
    // The person changed the model or effort by hand: their choice wins.
    if (baseModel && e.model !== baseModel) {
      route = null
      declined.clear()
    }
    if (baseEffort && runs && runs !== baseEffort) effort = null
    baseModel = e.model
    if (runs) baseEffort = runs

    if (mode !== 'off' && held !== null && e.index === 0) {
      const task = held
      held = null
      const level = LEVELS.find(l => l === (effort ?? runs)) ?? null
      try {
        await choose($, task, runs ? level : null)
      } catch (err) {
        lastDecision = `failed, nothing changed: ${err instanceof Error ? err.message : String(err)}`
        await log($, lastDecision)
      }
    }

    const base = familyOf(e.model)
    const model = mode !== 'off' && route && base && route !== base ? IDS[route] : e.model
    const level = mode !== 'off' && effort && runs ? effort : e.effort
    const changed = model !== e.model || level !== e.effort
    live = { model, effort: typeof level === 'string' ? level : '', changed }
    redraw($)
    // What your own model still had cached before this request, for the comparison.
    const ownWarm = warmTokens(base, await $.clock.now())
    const result = yield* next(changed ? { ...e, model, ...(level === undefined ? {} : { effort: level }) } : e)
    const ran = result.usage ? familyOf(result.usage.model) : null
    if (result.usage && ran && base) {
      const usage = result.usage
      const effortChanged = level !== e.effort
      await tally($, t => addRequest(t, { usage, ran, own: base, effortChanged, ownWarmTokens: ownWarm }))
    }
    if (result.usage) {
      // The model that really answered, in case a fallback stepped in.
      if (live && result.usage.model && result.usage.model !== model) {
        live = { ...live, model: result.usage.model, changed: result.usage.model !== e.model || live.changed }
        redraw($)
      }
      await record($, model, result.usage, e.index === 0 && e.messageCount <= CHAT_START_MESSAGES)
    }
    return result
  })

  // A new subagent starts with its own short context, so a cheaper model costs no old cache.
  on('agent.spawn', async ($, e, next) => {
    const parent = familyOf(e.parentModel)
    if (mode === 'off' || e.model !== undefined || !parent || !ROUTABLE_AGENTS.includes(e.subagentType)) {
      return next(e)
    }
    let target: Family | null = null
    try {
      const p = await judge($, e.prompt, '')
      if (p && !p.keep && !p.risky && RANK[p.model] < RANK[parent]) target = p.model
    } catch (err) {
      await log($, `subagent left as it was: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!target) return next(e)
    await log($, `subagent "${e.description}" on ${IDS[target]} instead of ${e.parentModel}`)
    $.ui.toast(`Subagent on ${MODEL_NAMES[target]}: ${e.description}`)
    const started = await next({ ...e, model: IDS[target] })
    if (!started.deny && started.agentId) movedAgents.set(started.agentId, parent)
    return started
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'model-picker' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg === 'stats clear') {
      chatTally = { ...EMPTY_TALLY }
      allTally = { ...EMPTY_TALLY }
      await $.store.set(TOTALS_KEY, allTally)
      redraw($)
      return { text: 'Model picker: savings counts cleared for this chat and all chats.' }
    }
    if (arg === 'stats close') {
      await $.ui.close({ id: PANE })
      return { text: 'Model picker: savings dashboard closed.' }
    }
    if (arg === 'stats') {
      allTally = readTally(await $.store.get(TOTALS_KEY))
      const opened = await $.ui.open({ id: PANE, title: 'Model picker savings', closeOnEscape: true })
      if (opened.isPlaced) {
        return { text: 'Model picker: savings dashboard opened. Close it with its Close button or /model-picker stats close.' }
      }
      // No panel here: give the same figures as text.
      return {
        text: [
          'This chat',
          ...tallyLines(chatTally),
          '',
          'All chats',
          ...tallyLines(allTally),
          '',
          ...STATS_NOTES,
        ].join('\n'),
      }
    }
    if (arg === 'ask' || arg === 'auto' || arg === 'off') {
      mode = arg
      await $.store.set('mode', mode)
      if (mode === 'off') reset()
      redraw($)
      const says = {
        ask: 'ask. It asks before changing the model or the effort.',
        auto: 'auto. It sets effort by itself and still asks before changing your model.',
        off: 'off. Your own model and effort are in use.',
      }
      return { text: `Model picker: ${says[mode]}` }
    }
    if (arg === 'reset') {
      reset()
      redraw($)
      return { text: 'Model picker: back to your own model and effort. Declined offers are forgotten.' }
    }
    const own = familyOf(baseModel)
    return {
      text: [
        `Mode: ${mode}`,
        `Your model: ${baseModel || 'not seen yet'}${baseModel && !own ? ' (not recognised, so it is never changed)' : ''}`,
        `Model override: ${route ? MODEL_NAMES[route] : 'none'}`,
        `Effort override: ${effort ? LEVEL_NAMES[effort] : 'none'}`,
        `Last decision: ${lastDecision}`,
        `Last request: ${lastRequest}`,
        'Type /model-picker ask, auto, off or reset, or /model-picker stats for the savings dashboard.',
      ].join('\n'),
    }
  })

  // The savings dashboard: opened only by /model-picker stats.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const t = scope === 'chat' ? chatTally : allTally
    const net = netSaving(t)
    const tone = net >= 0 ? 'success' : 'warning'
    const headline = net >= 0 ? money(net) : `+${money(-net)}`

    // Minimized on the desktop: one line that reads at a glance.
    if (e.props.placement === 'widget') {
      return <Text color={tone}>{net >= 0 ? `Saved ~${money(net)}` : `Extra ~${money(-net)}`}</Text>
    }

    const pick = (next: Scope) => () => {
      scope = next
      redraw($)
    }
    const card = (label: string, value: string, note: string) => (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="subtle"
        paddingX="sm"
        paddingY="xs"
        flexGrow={1}
        minWidth={16}
      >
        <Text size="caption" color="subtle">
          {label}
        </Text>
        <Text size="heading" weight="semibold" tabular>
          {value}
        </Text>
        <Text size="footnote" color="subtle">
          {note}
        </Text>
      </Box>
    )

    const row = (label: string, count: string, amount: string, color: 'success' | 'warning' | 'subtle') => (
      <Box flexDirection="row" justifyContent="space-between" gap="sm">
        <Box flexDirection="row" gap="xs">
          <Text>{label}</Text>
          <Text size="footnote" color="subtle">
            {count}
          </Text>
        </Box>
        <Text weight="semibold" color={color} tabular>
          {amount}
        </Text>
      </Box>
    )

    const header = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap="sm">
        <Box flexDirection="column">
          <Text size="heading" weight="bold">
            Model picker
          </Text>
          <Text size="caption" color="subtle">
            Estimated savings at API list prices
          </Text>
        </Box>
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          <Button key="scope-chat" label="This chat" variant={scope === 'chat' ? 'primary' : 'secondary'} onPress={pick('chat')} />
          <Button key="scope-all" label="All chats" variant={scope === 'all' ? 'primary' : 'secondary'} onPress={pick('all')} />
          <Button key="close" label="Close" variant="secondary" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )

    const notes = (
      <Box flexDirection="column">
        {STATS_NOTES.map(n => (
          <Text size="caption" color="subtle">
            {n}
          </Text>
        ))}
      </Box>
    )

    if (!t.requests && !t.judgeCalls) {
      return (
        <Box flexDirection="column" gap="md" padding="sm">
          {header}
          <Box flexDirection="column" borderStyle="round" borderColor="subtle" padding="md" alignItems="center">
            <Text weight="semibold">Nothing counted yet</Text>
            <Text size="footnote" color="subtle">
              {scope === 'chat' ? 'Send a prompt in this chat, then look again.' : 'No chat has been counted yet.'}
            </Text>
          </Box>
          {notes}
        </Box>
      )
    }

    const withPicker = t.actualUsd + t.judgeUsd
    const top = Math.max(t.ownUsd, withPicker, 1e-9)
    const share = t.ownUsd > 0 ? Math.round((Math.abs(net) / t.ownUsd) * 100) : 0

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        {header}

        <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX="md" paddingY="sm">
          <Text size="caption" color="subtle">
            {net >= 0 ? 'Estimated saving' : 'Estimated extra cost'}
          </Text>
          <Text size="title" weight="bold" color={tone} tabular>
            {headline}
          </Text>
          <Text size="footnote" color="subtle">
            {share ? `${share}% ${net >= 0 ? 'less' : 'more'} than on your own models` : 'Same as on your own models'}
          </Text>
        </Box>

        <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="subtle" paddingX="md" paddingY="sm">
          <Text size="caption" color="subtle">
            Where it comes from
          </Text>
          {row(
            'Cheaper models',
            `${t.cheaper} ${t.cheaper === 1 ? 'request' : 'requests'}`,
            cheaperText(t),
            !t.cheaper ? 'subtle' : t.cheaperSavedUsd >= 0 ? 'success' : 'warning',
          )}
          {row(
            'Stronger models',
            `${t.stronger} ${t.stronger === 1 ? 'request' : 'requests'}`,
            strongerText(t),
            t.stronger ? 'warning' : 'subtle',
          )}
          {row('Judge', `${t.judgeCalls} ${t.judgeCalls === 1 ? 'call' : 'calls'}`, money(t.judgeUsd), 'subtle')}
        </Box>

        <Box flexDirection="row" flexWrap="wrap" gap="sm">
          {card('Requests', String(t.requests), `${t.cheaper} cheaper · ${t.stronger} stronger`)}
          {card('Tokens', tokenCount(t.tokens), `${tokenCount(t.switchedTokens)} on another model`)}
        </Box>

        <Box flexDirection="column" gap="xs" borderStyle="round" borderColor="subtle" paddingX="md" paddingY="sm">
          <Text size="caption" color="subtle">
            Cost comparison
          </Text>
          <Text size="footnote">Your own models</Text>
          <Progress label="Your own models" value={t.ownUsd} max={top} valueText={money(t.ownUsd)} color="inactive" />
          <Text size="footnote">With the picker, judge included</Text>
          <Progress label="With the picker" value={withPicker} max={top} valueText={money(withPicker)} color={tone} />
          {t.effortOnly ? (
            <Text size="footnote" color="subtle">
              {`${t.effortOnly} effort-only ${t.effortOnly === 1 ? 'change' : 'changes'}, not credited`}
            </Text>
          ) : null}
        </Box>

        {notes}
      </Box>
    )
  })

  // The app's own model menu keeps showing your choice, so the footer names what the last request really used:
  // orange when the picker changed it, dim when it is your own choice.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (mode === 'off' || !live) return next(e)
    const label = `${live.changed ? 'Picker' : 'Running'}: ${liveLabel(live)}`
    if (e.surface === 'desktop') {
      const { Box, Text } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" gap={1}>
          {e.props.modes.length ? <Text dimColor>{e.props.modes.join(' & ')}</Text> : null}
          {live.changed ? <Text color={ACCENT}>{label}</Text> : <Text dimColor>{label}</Text>}
        </Box>
      )
    }
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
  })
}
