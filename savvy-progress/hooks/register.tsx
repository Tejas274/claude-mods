import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Agent, Live, Todo } from '../types'

// ════════════════════════════════════════════════════════════════════════════
// 1. STATE: everything the screen shows lives in one value. Writing it redraws.
// ════════════════════════════════════════════════════════════════════════════
const EMPTY: Live = {
  isRunning: false,
  startedAt: 0,
  now: 0,
  steps: 0,
  current: null,
  costUsd: null,
  baseCost: 0,
  window: 200_000,
  agents: [],
  todos: [],
}
// (key 'job': a fresh slot, so values saved by the older version are not mixed in)
const live = atom({ plugin: 'savvy-progress', key: 'job' } as const, EMPTY)

const PANE = 'savvy-agents'
const TICK_MS = 250

// Colours
const ORANGE = '#E8803A'
const AMBER = '#F2B36B'
const GREEN = '#7BC88F'

// ════════════════════════════════════════════════════════════════════════════
// 2. HELPERS: plain functions that only turn data into text (no `$` in here)
// ════════════════════════════════════════════════════════════════════════════

// "claude-opus-5-5-20260101" → "Opus 5.5"
const prettyModel = (id: string): string => {
  const parts = id.replace(/^claude-/, '').split('-').filter(p => !/^\d{8}$/.test(p))
  const name = parts.filter(p => !/^\d+$/.test(p)).join(' ')
  const version = parts.filter(p => /^\d+$/.test(p)).join('.')
  const title = name.replace(/\b\w/g, c => c.toUpperCase())
  return [title, version].filter(Boolean).join(' ') || id
}

// 79_400 → "79k"
const k = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`

const money = (usd: number | null): string => (usd === null ? '—' : `≈$${usd.toFixed(2)}`)

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const pct = (fraction: number): string => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`

// A spinner that turns as time passes
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const spinner = (now: number): string => SPIN[Math.floor(now / TICK_MS) % SPIN.length] ?? '⠋'

// Splits a bar into its filled part (coloured) and empty part (grey)
const bar = (fraction: number, width: number): { filled: string; empty: string } => {
  const n = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  const filled = fraction > 0 && n === 0 ? 1 : n
  return { filled: '━'.repeat(filled), empty: '━'.repeat(Math.max(0, width - filled)) }
}

const fit = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'

// Relative price of a model (input $/MTok), to split the job's cost fairly
const modelWeight = (model: string): number => (/haiku/i.test(model) ? 1 : /sonnet/i.test(model) ? 3 : 5)

// Cost "units" of one request: output costs 5× input, cache reads 0.1×, cache writes 1.25×
const unitsOf = (u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}): number =>
  modelWeight(u.model) *
  (u.input_tokens + 5 * u.output_tokens + 0.1 * u.cache_read_input_tokens + 1.25 * u.cache_creation_input_tokens)

// What this job has cost so far
const jobCost = (p: Live): number | null => (p.costUsd === null ? null : Math.max(0, p.costUsd - p.baseCost))

// One agent's share of the job's cost
const agentCost = (p: Live, a: Agent): number | null => {
  const total = p.agents.reduce((sum, x) => sum + x.units, 0)
  const cost = jobCost(p)
  return cost === null || total === 0 ? null : (cost * a.units) / total
}

const totalTokens = (p: Live): number => p.agents.reduce((sum, a) => sum + a.context, 0)
const main = (p: Live): Agent | undefined => p.agents.find(a => a.id === 'main')
const helpers = (p: Live): Agent[] => p.agents.filter(a => a.id !== 'main')
const anyRunning = (p: Live): boolean => p.agents.some(a => a.isRunning)
const elapsed = (p: Live): string => clock(p.now - p.startedAt)

// Put one agent's change into the list (adds it if new)
const withAgent = (p: Live, id: string, change: (a: Agent) => Agent): Live => {
  const known = p.agents.find(a => a.id === id)
  const base: Agent = known ?? {
    id,
    name: id === 'main' ? 'Main' : 'Helper',
    model: '',
    isRunning: false,
    context: 0,
    units: 0,
    startedAt: p.now,
    endedAt: null,
  }
  const next = change(base)
  const agents = known ? p.agents.map(a => (a.id === id ? next : a)) : [...p.agents, next]
  // main first, then up to 8 helpers (newest kept)
  return { ...p, agents: [...agents.filter(a => a.id === 'main'), ...agents.filter(a => a.id !== 'main').slice(-8)] }
}

// A new job: keep main's model and context, forget last job's helpers and costs
const newJob = (p: Live, now: number, cost: number | null, window: number): Live => {
  const m = main(p)
  return {
    ...p,
    isRunning: true,
    startedAt: now,
    now,
    steps: 0,
    current: null,
    costUsd: cost,
    baseCost: cost ?? 0,
    window,
    agents: m ? [{ ...m, isRunning: true, units: 0, startedAt: now, endedAt: null }] : [],
  }
}

// What Claude is doing right now, e.g. "Bash: npm test"
const describe = (e: { tool: string } & Record<string, unknown>): string => {
  const s = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  if (e.tool === 'Bash') return `Bash: ${s('command')}`
  if (s('file_path')) return `${e.tool}: ${s('file_path').split('/').slice(-2).join('/')}`
  if (s('description')) return `${e.tool}: ${s('description')}`
  if (s('pattern')) return `${e.tool}: ${s('pattern')}`
  return e.tool
}

// Keep Claude's to-do list in sync, from either to-do tool
const nextTodos = (todos: Todo[], tool: string, input: Record<string, any>, result: Record<string, any>): Todo[] => {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) return input.todos as Todo[]
  if (tool === 'TaskCreate' && result.task?.id) {
    return [...todos, { id: String(result.task.id), content: String(input.subject ?? ''), status: 'pending', activeForm: input.activeForm }]
  }
  if (tool === 'TaskUpdate') {
    const id = String(input.taskId)
    if (input.status === 'deleted') return todos.filter(t => t.id !== id)
    return todos.map(t =>
      t.id !== id
        ? t
        : {
            ...t,
            content: typeof input.subject === 'string' ? input.subject : t.content,
            activeForm: typeof input.activeForm === 'string' ? input.activeForm : t.activeForm,
            status: ['pending', 'in_progress', 'completed'].includes(input.status) ? input.status : t.status,
          },
    )
  }
  return todos
}

// What the job is doing, in a few words
const activity = (p: Live): string => {
  const working = helpers(p).filter(a => a.isRunning).length
  if (p.current) return p.current
  if (main(p)?.isRunning) return 'Thinking…'
  if (working > 0) return `Waiting for ${working} helper${working > 1 ? 's' : ''}`
  return 'Done'
}

// The one-line status bar
const statusLine = (p: Live): string => {
  const m = main(p)
  const model = m?.model ? prettyModel(m.model) : 'Claude'
  const working = helpers(p).filter(a => a.isRunning).length
  const crew = working ? ` · ${working} helper${working > 1 ? 's' : ''}` : ''
  const icon = p.isRunning ? spinner(p.now) : '✓'
  return `${icon} ${model}${crew} · ${k(totalTokens(p))} · ${money(jobCost(p))} · ${fit(activity(p), 32)} · ${elapsed(p)}`
}

// ════════════════════════════════════════════════════════════════════════════
// 3. HOOKS: listen to Claude Code's events
// ════════════════════════════════════════════════════════════════════════════
export const register: Register = on => {
  let ticker: Timer | undefined

  // ── Startup: add the /savvy command ─────────────────────────────────────
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'savvy', description: 'Open the Savvy Progress agents panel' })
    return next(e)
  })

  on('command.run', { command: 'savvy' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: 'Agents panel opened.' }
  })

  // ── You press Enter: start a new job (unless helpers are still working) ─
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const cost = usage.cost?.usd ?? null
    const window = usage.context.window || 200_000

    const p = await update($, live, p =>
      anyRunning(p)
        ? withAgent({ ...p, isRunning: true, costUsd: cost ?? p.costUsd }, 'main', a => ({ ...a, isRunning: true }))
        : newJob(p, now, cost, window),
    )
    $.ui.status(statusLine(p))

    // the clock: ticks until the whole job is done
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => {
      void $.clock
        .now()
        .then(t => update($, live, p => (p.isRunning ? { ...p, now: t } : p)))
        .then(p => $.ui.status(statusLine(p)))
    })

    return next(e)
  }).catch(($, e, next) => next(e)) // if this mod breaks, your prompt still goes through

  // ── An agent starts working (main loop or a helper) ─────────────────────
  on('turn.start', async ($, e, next) => {
    const id = e.agentId ?? 'main'
    const now = await $.clock.now()
    let name = id === 'main' ? 'Main' : 'Helper'
    if (e.agentId) {
      const info = (await $.agent.list()).find(a => a.id === e.agentId)
      if (info) name = info.description || info.type
    }
    await update($, live, p =>
      withAgent({ ...p, isRunning: true }, id, a => ({
        ...a,
        name,
        isRunning: true,
        startedAt: a.endedAt === null && a.startedAt ? a.startedAt : now,
        endedAt: null,
      })),
    )

    // a helper appeared → show the panel
    if (e.agentId) void $.ui.open({ id: PANE, title: 'Agents' })

    return next(e)
  })

  // ── Every model request: read its model and token usage (live) ──────────
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      const id = e.agentId ?? 'main'
      const usage = await $.session.usage()
      const p = await update($, live, p =>
        withAgent(
          { ...p, costUsd: usage.cost?.usd ?? p.costUsd, window: usage.context.window || p.window },
          id,
          a => ({
            ...a,
            model: u.model,
            context: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
            units: a.units + unitsOf(u),
          }),
        ),
      )
      $.ui.status(statusLine(p))
    }
    return result
  })

  // ── Every tool call: show it, let it run, count it ──────────────────────
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string } & Record<string, any>
    const before = await update($, live, p => ({ ...p, steps: p.steps + 1, current: describe(input) }))
    $.ui.status(statusLine(before))

    const ran = await next(e) // ← the real tool runs here
    const failed = ran.deny !== undefined || ran.isError === true
    const result = (ran.result ?? {}) as Record<string, any>

    await update($, live, p => ({
      ...p,
      current: null,
      todos: failed ? p.todos : nextTodos(p.todos, e.tool, input, result),
    }))
    return ran
  }).catch(($, e, next) => next(e)) // if this mod breaks, the tool still runs

  // ── An agent finished. The job ends when ALL agents are done. ───────────
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? 'main'
    const now = await $.clock.now()
    const usage = await $.session.usage()

    const p = await update($, live, p => {
      const after = withAgent({ ...p, now, costUsd: usage.cost?.usd ?? p.costUsd }, id, a => ({
        ...a,
        isRunning: false,
        endedAt: now,
      }))
      return { ...after, isRunning: anyRunning(after), current: anyRunning(after) ? after.current : null }
    })
    $.ui.status(statusLine(p))

    // everyone is done → stop the clock and celebrate
    if (!p.isRunning) {
      ticker?.cancel()
      ticker = undefined
      if (p.steps > 0 || helpers(p).length > 0) {
        const crew = helpers(p).length ? ` · ${helpers(p).length + 1} agents` : ''
        $.ui.toast(
          `${e.isAborted ? '■ Stopped' : '✓ All done'} in ${elapsed(p)}${crew} · ${p.steps} steps · ${money(jobCost(p))}`,
        )
      }
    }
    return next(e)
  })

  // ════════════════════════════════════════════════════════════════════════
  // 4. DRAWING
  // ════════════════════════════════════════════════════════════════════════

  // ── Band above the prompt: the "Savvy Progress" card ────────────────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, live)
    const m = main(p)
    if (e.props.hasSurvey || !m) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 4)

    // the bar: to-do progress if Claude has a to-do list, else how full the context is
    const done = p.todos.filter(t => t.status === 'completed').length
    const active = p.todos.find(t => t.status === 'in_progress')
    const hasTodos = p.todos.length > 0
    const fraction = hasTodos ? done / p.todos.length : m.context / p.window
    const barLabel = hasTodos
      ? `${done}/${p.todos.length} tasks${active ? `  ·  ${active.activeForm || active.content}` : ''}`
      : `${pct(fraction)} context`
    const barWidth = Math.min(36, Math.max(10, Math.floor(width / 3)))
    const b = bar(fraction, barWidth)

    const working = helpers(p).filter(a => a.isRunning).length
    const all = helpers(p).length
    const plural = all === 1 ? 'helper' : 'helpers'
    const crew = all ? `  ·  ${working ? `${working} of ${all} ${plural} working` : `${all} ${plural} done`}` : ''

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={p.isRunning ? ORANGE : 'subtle'} paddingX={1}>
        <Box flexDirection="row" gap={3}>
          <Text color={ORANGE} bold>
            ◉ Savvy Progress
          </Text>
          <Text>
            <Text color={ORANGE}>✳ </Text>
            <Text bold>{m.model ? prettyModel(m.model) : '…'}</Text>
          </Text>
          <Text>
            <Text dimColor># </Text>
            <Text bold>{k(totalTokens(p))}</Text>
            <Text dimColor> tokens</Text>
          </Text>
          <Text>
            <Text color={AMBER} bold>
              {money(jobCost(p))}
            </Text>
          </Text>
          <Text>
            <Text dimColor>⏱ </Text>
            <Text bold>{elapsed(p)}</Text>
          </Text>
        </Box>
        <Text>
          <Text color={hasTodos && done === p.todos.length ? GREEN : ORANGE}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text>
          <Text dimColor>  {fit(barLabel, width - barWidth - 3)}</Text>
        </Text>
        <Text>
          <Text color={p.isRunning ? ORANGE : GREEN}>{p.isRunning ? spinner(p.now) : '✓'} </Text>
          <Text>{fit(activity(p), Math.max(10, width - 40))}</Text>
          <Text dimColor>
            {'  ·  '}step {p.steps}
            {crew}
          </Text>
        </Text>
      </Box>
    )
  })

  // ── Side panel: "Agents" (open with /savvy) ─────────────────────────────
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const p = await read($, live)
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 2)
    const barWidth = Math.max(8, width - 24)

    const tile = (key: string, title: string, value: string, color?: string) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} flexGrow={1}>
        <Text dimColor>{title}</Text>
        <Text bold color={color}>
          {value}
        </Text>
      </Box>
    )

    const working = helpers(p).filter(a => a.isRunning).length

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {tile('cost', 'Cost', money(jobCost(p)), AMBER)}
          {tile('tokens', 'Tokens', k(totalTokens(p)))}
          {tile('time', 'Time', elapsed(p), p.isRunning ? ORANGE : undefined)}
        </Box>

        <Text>
          <Text color={p.isRunning ? ORANGE : GREEN}>{p.isRunning ? spinner(p.now) : '✓'} </Text>
          <Text bold>{p.isRunning ? 'Working' : 'Done'}</Text>
          <Text dimColor>
            {'  ·  '}
            {p.agents.length} agent{p.agents.length === 1 ? '' : 's'}
            {working ? `  ·  ${working} running` : ''}
            {'  ·  '}
            {p.steps} steps
          </Text>
        </Text>

        {p.agents.length === 0 && <Text dimColor>No agents yet. Send a prompt.</Text>}

        {p.agents.map(a => {
          const b = bar(a.context / p.window, barWidth)
          const took = clock((a.endedAt ?? p.now) - a.startedAt)
          return (
            <Box key={a.id} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text color={a.isRunning ? ORANGE : GREEN}>{a.isRunning ? `${spinner(p.now)} ` : '✓ '}</Text>
                  <Text bold>{fit(a.name, Math.max(6, width - 26))}</Text>
                  <Text dimColor>{'  '}{a.model ? prettyModel(a.model) : '…'}</Text>
                </Text>
                <Text bold color={AMBER}>
                  {money(agentCost(p, a))}
                </Text>
              </Box>
              <Text>
                <Text color={a.isRunning ? ORANGE : GREEN}>{b.filled}</Text>
                <Text dimColor>{b.empty}</Text>
                <Text dimColor>
                  {'  '}
                  {k(a.context)} · {took}
                </Text>
              </Text>
            </Box>
          )
        })}

        {p.costUsd !== null && (
          <Text dimColor>
            Session total {money(p.costUsd)}
          </Text>
        )}
      </Box>
    )
  })
}
