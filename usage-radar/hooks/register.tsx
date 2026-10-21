import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register, Timer } from 'claude-code'

import type { Agent, Limit, Live, NameKind, Saved, Todo } from '../types'

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
  limits: [],
  contextPct: null,
  alerted: {},
  sessionId: null,
  name: null,
  nameKind: null,
  sessionCost: 0,
  lastLedger: null,
  jobTokens: 0,
  sessionTokens: 0,
  priorMs: 0,
  sessionSteps: 0,
  helperIds: [],
}
const live = atom({ plugin: 'usage-radar', key: 'radar' } as const, EMPTY, { shape: 'v2' })

const PANE = 'radar-agents'
// name (1) + tiles (4) + this request (1) + summary (2) + 3 rows per agent + session total (2), and the dock width
const paneRows = (agents: number, limits: number): number => 12 + 2 * limits + 3 * Math.max(1, agents)
const PANE_COLUMNS = 64
const TICK_MS = 250

// Session totals are saved per session id in $.store, at most every 15 s while working
const SAVE_MS = 15_000
const PRUNE_MS = 90 * 24 * 60 * 60 * 1000 // sessions unused for 90 days are forgotten
const KEY = (id: string): string => `session:${id}`

// Colours: theme keys, not raw hex, so they stay readable on light and dark terminals
const ORANGE = 'claude'
const AMBER = 'warning'
const GREEN = 'success'
const RED = 'error'

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

const main = (p: Live): Agent | undefined => p.agents.find(a => a.id === 'main')
const helpers = (p: Live): Agent[] => p.agents.filter(a => a.id !== 'main')
const anyRunning = (p: Live): boolean => p.agents.some(a => a.isRunning)

// New tokens of one request: input + cache writes + output. Cache reads are left out:
// they re-read the same history on every step, so they would count it again and again.
const freshTokens = (u: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number }): number =>
  u.input_tokens + u.cache_creation_input_tokens + u.output_tokens

// Working time: this job, and the whole session (earlier jobs + this one; idle gaps don't count)
const jobMs = (p: Live): number => Math.max(0, p.now - p.startedAt)
const elapsed = (p: Live): string => clock(jobMs(p))
const sessionClock = (p: Live): string => clock(p.priorMs + jobMs(p))

// What the whole session has cost ("—" until the engine reports a cost)
const totalCost = (p: Live): number | null => (p.costUsd === null && p.sessionCost === 0 ? null : p.sessionCost)

// Main (once it has done anything) + every helper seen this session
const sessionAgents = (p: Live): number => (main(p) || p.sessionSteps || p.sessionTokens ? 1 : 0) + p.helperIds.length

// 1 → "1 step", 3 → "3 steps"
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// The dim line under the totals: just the current request
const thisRequest = (p: Live): string =>
  `this request: ${money(jobCost(p))} · ${k(p.jobTokens)} · ${elapsed(p)} · ${plural(p.steps, 'step')}`

// A new reading of the engine's cost ledger: add what changed since the last one.
// If the ledger went down (it started over), the whole new reading is new cost.
const withLedger = (p: Live, ledger: number | null): Live => {
  if (ledger === null) return p
  const last = p.lastLedger ?? ledger
  const delta = ledger >= last ? ledger - last : ledger
  return { ...p, costUsd: ledger, lastLedger: ledger, sessionCost: p.sessionCost + delta }
}

// A helper's row name: "researcher · Find database config"; a teammate's own name
const agentLabel = (info: { type?: string; description?: string; name?: string }): string => {
  const type = info.type?.trim() ?? ''
  const description = info.description?.trim() ?? ''
  if (type === 'teammate') return info.name?.trim() || description || 'Helper'
  if (!type) return description || 'Helper'
  if (!description || description.toLowerCase() === type.toLowerCase()) return type
  return `${type} · ${description}`
}

// Ticket IDs in a prompt. "MRKRR-142" (any case, returned in capitals), or a capitals-only
// word ID like "USAGE-RADAR". Never inside a word, a path or a URL; never "UTF-8", "GPT-4"...
const TICKET_NUMBER = /(?<![\w./-])[A-Za-z]{2,}-\d+(?![\w/-])/g
const TICKET_WORDS = /(?<![\w./-])[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+(?![\w/-])/g
const NOT_TICKET = /^(UTF|ISO|SHA|MD|HTTP|HTTPS|TLS|SSL|COVID|GPT|ES|IPV|RFC|AES|RSA|UTC|GMT|TODO|FIXME|WIP)-/i
const NAME_MAX = 80

const ticketOf = (text: string): string | null => {
  const found = [...text.matchAll(TICKET_NUMBER), ...text.matchAll(TICKET_WORDS)]
    .filter(m => !NOT_TICKET.test(m[0]))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))[0]
  return found ? found[0].toUpperCase() : null
}

// "please refactor the payment service retry logic" → "please refactor the payment service"
const firstWords = (text: string, n: number): string | null => {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, n).join(' ')
  return words.replace(/[.,:;!?-]+$/, '') || null
}

// A session name from the first prompt: a ticket ID if it has one, else its first 5 words
const autoName = (text: string): { name: string; kind: NameKind } | null => {
  const ticket = ticketOf(text)
  if (ticket) return { name: ticket.slice(0, NAME_MAX), kind: 'ticket' }
  const words = firstWords(text, 5)
  return words ? { name: words.slice(0, NAME_MAX), kind: 'words' } : null
}

// /rename always wins; an automatic name only fills an empty one
const withName = (p: Live, name: string, kind: NameKind): Live =>
  kind === 'rename' || !p.name ? { ...p, name: name.slice(0, NAME_MAX), nameKind: kind } : p

// Count each helper once per session, by its id
const withHelper = (p: Live, id: string): Live =>
  id === 'main' || p.helperIds.includes(id) ? p : { ...p, helperIds: [...p.helperIds, id] }

// What we keep in the store for this session
const toSaved = (p: Live, now: number): Saved => ({
  v: 1,
  updatedAt: now,
  name: p.name,
  nameKind: p.nameKind,
  cost: p.sessionCost,
  tokens: p.sessionTokens,
  ms: p.priorMs + jobMs(p),
  steps: p.sessionSteps,
  helperIds: p.helperIds,
})

// Read a stored record back; anything odd counts as missing
const parseSaved = (raw: unknown): Saved | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const count = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  const kinds: unknown[] = ['rename', 'ticket', 'words']
  if (r.v !== 1) return null
  if (![r.cost, r.tokens, r.ms, r.steps, r.updatedAt].every(count)) return null
  if (r.name !== null && typeof r.name !== 'string') return null
  if (r.nameKind !== null && !kinds.includes(r.nameKind)) return null
  if (!Array.isArray(r.helperIds) || !r.helperIds.every(x => typeof x === 'string')) return null
  return {
    v: 1,
    updatedAt: r.updatedAt as number,
    name: r.name as string | null,
    nameKind: r.nameKind as NameKind | null,
    cost: r.cost as number,
    tokens: r.tokens as number,
    ms: r.ms as number,
    steps: r.steps as number,
    helperIds: r.helperIds as string[],
  }
}

// Another session (start, --resume, /clear): start from its saved totals, or from zero.
// The ledger now is the starting point, so nothing from before is counted twice.
const freshSession = (p: Live, id: string, saved: Saved | null, ledger: number | null): Live => ({
  ...EMPTY,
  sessionId: id,
  limits: p.limits,
  alerted: p.alerted,
  lastLedger: ledger,
  ...(saved && {
    name: saved.name,
    nameKind: saved.nameKind,
    sessionCost: saved.cost,
    sessionTokens: saved.tokens,
    priorMs: saved.ms,
    sessionSteps: saved.steps,
    helperIds: saved.helperIds,
  }),
})

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
  // main first, then up to 8 helpers on screen (newest kept); every helper is still counted
  return withHelper(
    { ...p, agents: [...agents.filter(a => a.id === 'main'), ...agents.filter(a => a.id !== 'main').slice(-8)] },
    id,
  )
}

// A new job: keep main's model and context, forget last job's helpers and costs.
// The last job's working time moves into the session's time; the other totals already count.
const newJob = (p: Live, now: number, cost: number | null, window: number): Live => {
  const m = main(p)
  return {
    ...p,
    priorMs: p.priorMs + jobMs(p),
    jobTokens: 0,
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

// ── Limits & context ────────────────────────────────────────────────────
const WARN = 80
const DANGER = 95

const limitLabel = (kind: string): string =>
  kind === 'five_hour' ? '5h limit' : kind === 'seven_day' ? 'Weekly' : kind === 'spend_limit' ? 'Spend' : kind.replace(/_/g, ' ')

const levelColor = (pctUsed: number): string => (pctUsed >= DANGER ? RED : pctUsed >= WARN ? AMBER : GREEN)

// "2h 10m", "3d 4h", "12m"
const until = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// Every meter we watch: plan limits first, then context
type Meter = { key: string; label: string; pct: number; resetsAt?: string }
const meters = (p: Live): Meter[] => [
  ...p.limits.map(l => ({ key: l.kind, label: limitLabel(l.kind), pct: l.percentUsed, resetsAt: l.resetsAt })),
  ...(p.contextPct === null ? [] : [{ key: 'context', label: 'Context', pct: p.contextPct }]),
]

// Save the latest limits and context, and work out which alerts to pop (each once per level)
const withUsage = (
  p: Live,
  limits: readonly Limit[],
  contextPct: number | undefined,
): { next: Live; alerts: string[] } => {
  const next: Live = {
    ...p,
    limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    contextPct: contextPct ?? p.contextPct,
  }
  const alerted = { ...p.alerted }
  const alerts: string[] = []
  for (const m of meters(next)) {
    const level = m.pct >= DANGER ? DANGER : m.pct >= WARN ? WARN : 0
    if (level > (alerted[m.key] ?? 0)) {
      const reset = m.resetsAt ? ` · resets in ${until(m.resetsAt, p.now)}` : ''
      const tip = m.key === 'context' ? ' · run /compact soon' : ''
      alerts.push(`${level >= DANGER ? '⛔' : '⚠'} ${m.label} ${Math.round(m.pct)}% used${reset}${tip}`)
    }
    alerted[m.key] = level // drops back to 0 after a reset or /compact, so it can alert again
  }
  return { next: { ...next, alerted }, alerts }
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
  const worst = [...meters(p)].sort((a, b) => b.pct - a.pct)[0]
  const gauge = worst ? ` · ${worst.label} ${Math.round(worst.pct)}%` : ''
  return `${icon} ${model}${crew} · ${k(p.sessionTokens)} · ${money(totalCost(p))}${gauge} · ${fit(activity(p), 28)} · ${sessionClock(p)}`
}

// ════════════════════════════════════════════════════════════════════════════
// 3. SESSION: totals are saved per session id in $.store, so --resume continues them.
//    Every `$` call here is wrapped: if saving breaks, the radar keeps going.
// ════════════════════════════════════════════════════════════════════════════
let savedAt = 0 // when we last saved, so saving while working stays occasional

const save = async ($: EngineInterface): Promise<void> => {
  try {
    const p = await read($, live)
    if (!p.sessionId) return
    const now = await $.clock.now()
    savedAt = now
    await $.store.set(KEY(p.sessionId), toSaved(p, now))
  } catch {
    // not saved this time; the next save catches up
  }
}

// save while working, but not on every step
const saveSoon = async ($: EngineInterface): Promise<void> => {
  try {
    const now = await $.clock.now()
    if (now - savedAt >= SAVE_MS || now < savedAt) await save($) // (a clock behind us: save, start over)
  } catch {
    // ignore
  }
}

const load = async ($: EngineInterface, id: string): Promise<Saved | null> => {
  try {
    return parseSaved(await $.store.get(KEY(id)))
  } catch {
    return null
  }
}

// Forget sessions not used for 90 days (and records we can't read). Other keys are left alone.
const prune = async ($: EngineInterface, current: string): Promise<void> => {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith('session:') || key === KEY(current)) continue
      try {
        const saved = parseSaved(await $.store.get(key))
        if (!saved || now - saved.updatedAt > PRUNE_MS) await $.store.delete(key)
      } catch {
        // try again next time
      }
    }
  } catch {
    // ignore
  }
}

// Which session are we in? On a new id (start, --resume, /clear) save the old one and
// load the new one's totals, or start them at zero.
const syncSession = async ($: EngineInterface): Promise<void> => {
  try {
    const id = await $.session.id()
    if (!id) return
    const p = await read($, live)
    if (p.sessionId === id) return
    if (p.sessionId) await save($)
    const saved = await load($, id)
    let ledger: number | null = null
    try {
      ledger = (await $.session.usage()).cost?.usd ?? null
    } catch {
      // no ledger reading: the first one later becomes the starting point
    }
    await update($, live, q => (q.sessionId === id ? q : freshSession(q, id, saved, ledger)))
    await prune($, id)
  } catch {
    // no session id: keep counting as before
  }
}

// A helper's row name, from the engine's list of agents
const agentName = async ($: EngineInterface, agentId: string): Promise<string | undefined> => {
  try {
    const info = (await $.agent.list()).find(a => a.id === agentId)
    return info ? agentLabel(info) : undefined
  } catch {
    return undefined
  }
}

// A session name from a prompt you typed (not a notification, a schedule or a built-in command)
const nameFrom = async ($: EngineInterface, e: PromptSubmitInput): Promise<{ name: string; kind: NameKind } | null> => {
  if (e.isMeta) return null
  if (e.origin && !['composer', 'bridge', 'sdk', 'coordinator'].includes(e.origin.kind)) return null
  if (e.command) {
    const name = e.command.name
    try {
      const info = (await $.command.list()).find(c => c.name === name)
      return info?.source === 'builtin' ? null : autoName(e.command.args)
    } catch {
      return null
    }
  }
  return autoName(e.text)
}

// ════════════════════════════════════════════════════════════════════════════
// 4. HOOKS: listen to Claude Code's events
// ════════════════════════════════════════════════════════════════════════════
export const register: Register = on => {
  let ticker: Timer | undefined

  // ── Startup: pick up this session's totals, add the /radar command ─────
  on('session.start', async ($, e, next) => {
    await syncSession($)
    await $.command.register({ name: 'radar', description: 'Open Usage Radar: limits, context, cost and agents' })
    return next(e)
  })

  // ── The session ends (exit, /clear, ...): save its totals ───────────────
  on('session.end', async ($, e, next) => {
    await save($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── Classic hooks carry the session's title. We treat session_title as the /rename
  //    name; if it turns out to be filled in for sessions nobody renamed, drop this. ──
  on('classic.SessionStart', async ($, e, next) => {
    await syncSession($)
    const title = e.session_title?.trim()
    if (title) {
      await update($, live, p => withName(p, title, 'rename'))
      await save($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await syncSession($)
    const title = e.session_title?.trim()
    if (title) {
      await update($, live, p => withName(p, title, 'rename'))
      await save($)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── /rename: the built-in runs as usual, and the radar takes the new name ─
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const r = await next(e)
    try {
      await syncSession($)
      const title = e.args.trim()
      if (title) {
        await update($, live, p => withName(p, title, 'rename'))
        await save($)
      }
    } catch {
      // the rename itself already happened
    }
    return r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'radar' }, async $ => {
    const p = await read($, live)
    await $.ui.open({ id: PANE, title: 'Usage Radar', rows: paneRows(p.agents.length, meters(p).length), columns: PANE_COLUMNS })
    return { text: 'Usage Radar opened.' }
  })

  // ── You press Enter: start a new job (unless helpers are still working) ─
  on('prompt.submit', async ($, e, next) => {
    await syncSession($)
    // the first prompt you type names the session (unless it has a name already)
    if (!(await read($, live)).name) {
      const n = await nameFrom($, e)
      if (n) {
        await update($, live, p => withName(p, n.name, n.kind))
        await save($)
      }
    }

    if (e.command) return next(e) // slash commands like /radar don't start a new job
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const cost = usage.cost?.usd ?? null
    const window = usage.context.window || 200_000

    let alerts: string[] = []
    const p = await update($, live, p => {
      const q = withLedger(p, cost)
      const base = anyRunning(q)
        ? withAgent({ ...q, isRunning: true }, 'main', a => ({ ...a, isRunning: true }))
        : newJob(q, now, cost, window)
      const r = withUsage(base, usage.rateLimits, usage.context.percent)
      alerts = r.alerts
      return r.next
    })
    $.ui.status(statusLine(p))
    for (const a of alerts) $.ui.toast(a)

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
    const name = (e.agentId && (await agentName($, e.agentId))) || (id === 'main' ? 'Main' : 'Helper')
    const after = await update($, live, p =>
      withAgent({ ...p, isRunning: true }, id, a => ({
        ...a,
        name,
        isRunning: true,
        startedAt: a.endedAt === null && a.startedAt ? a.startedAt : now,
        endedAt: null,
      })),
    )

    // a helper appeared → show the panel, tall enough for every agent
    if (e.agentId) {
      void $.ui.open({ id: PANE, title: 'Usage Radar', rows: paneRows(after.agents.length, meters(after).length), columns: PANE_COLUMNS })
    }

    return next(e)
  })

  // ── Every model request: read its model and token usage (live) ──────────
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      const id = e.agentId ?? 'main'
      // a helper we couldn't name at its start: ask again (it may be listed by now)
      const known = (await read($, live)).agents.find(a => a.id === id)
      const name = e.agentId && (!known || known.name === 'Helper') ? await agentName($, e.agentId) : undefined
      const usage = await $.session.usage()
      const fresh = freshTokens(u)
      let alerts: string[] = []
      const p = await update($, live, p => {
        const counted = withLedger({ ...p, window: usage.context.window || p.window }, usage.cost?.usd ?? null)
        const base = withAgent(
          { ...counted, jobTokens: counted.jobTokens + fresh, sessionTokens: counted.sessionTokens + fresh },
          id,
          a => ({
            ...a,
            name: name ?? a.name,
            model: u.model,
            context: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
            units: a.units + unitsOf(u),
          }),
        )
        const r = withUsage(base, usage.rateLimits, id === 'main' ? usage.context.percent : undefined)
        alerts = r.alerts
        return r.next
      })
      $.ui.status(statusLine(p))
      for (const a of alerts) $.ui.toast(a)
      await saveSoon($)
    }
    return result
  })

  // ── Every tool call: show it, let it run, count it ──────────────────────
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as { tool: string } & Record<string, any>
    const before = await update($, live, p => ({
      ...p,
      steps: p.steps + 1,
      sessionSteps: p.sessionSteps + 1,
      current: describe(input),
    }))
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
      const after = withAgent(withLedger({ ...p, now }, usage.cost?.usd ?? null), id, a => ({
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
      await save($)
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
  // 5. DRAWING
  // ════════════════════════════════════════════════════════════════════════

  // ── Band above the prompt: the "Usage Radar" card ────────────────────
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
    const helperWord = all === 1 ? 'helper' : 'helpers'
    const crew = all ? `  ·  ${working ? `${working} of ${all} ${helperWord} working` : `${all} ${helperWord} done`}` : ''

    // the session's name (bold), then this request's own numbers (dim)
    const name = p.name ? fit(p.name, Math.min(28, Math.floor(width / 3))) : null
    const request = name
      ? fit(`  ·  ${thisRequest(p)}`, Math.max(10, width - name.length))
      : fit(thisRequest(p), width)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={p.isRunning ? ORANGE : 'subtle'} paddingX={1}>
        <Box flexDirection="row" gap={3}>
          <Text color={ORANGE} bold>
            ◉ Usage Radar
          </Text>
          <Text>
            <Text color={ORANGE}>✳ </Text>
            <Text bold>{m.model ? prettyModel(m.model) : '…'}</Text>
          </Text>
          <Text>
            <Text dimColor># </Text>
            <Text bold>{k(p.sessionTokens)}</Text>
            <Text dimColor> tokens</Text>
          </Text>
          <Text>
            <Text color={AMBER} bold>
              {money(totalCost(p))}
            </Text>
          </Text>
          <Text>
            <Text dimColor>⏱ </Text>
            <Text bold>{sessionClock(p)}</Text>
          </Text>
        </Box>
        <Text>
          {name !== null && <Text bold>{name}</Text>}
          <Text dimColor>{request}</Text>
        </Text>
        <Text>
          <Text color={hasTodos && done === p.todos.length ? GREEN : ORANGE}>{b.filled}</Text>
          <Text dimColor>{b.empty}</Text>
          <Text dimColor>  {fit(barLabel, width - barWidth - 3)}</Text>
        </Text>
        <Text>
          <Text color={p.isRunning ? ORANGE : GREEN}>{p.isRunning ? spinner(p.now) : '✓'} </Text>
          <Text>{fit(activity(p), Math.max(10, width - 40))}</Text>
          <Text dimColor>{`  ·  ${plural(p.sessionSteps, 'step')}${crew}`}</Text>
        </Text>
        {meters(p).length > 0 && (
          <Box flexDirection="row" gap={3}>
            {meters(p).map(m => {
              const g = bar(m.pct / 100, 10)
              return (
                <Text key={m.key}>
                  <Text dimColor>{m.label} </Text>
                  <Text color={levelColor(m.pct)}>{g.filled}</Text>
                  <Text dimColor>{g.empty}</Text>
                  <Text bold color={m.pct >= WARN ? levelColor(m.pct) : undefined}>
                    {' '}
                    {Math.round(m.pct)}%
                  </Text>
                  {m.pct >= WARN && <Text color={levelColor(m.pct)}> {m.pct >= DANGER ? '⛔' : '⚠'}</Text>}
                </Text>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  // ── Side panel: "Usage Radar" (open with /radar) ───────────────────────
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
        <Box flexDirection="column">
          {p.name ? <Text bold>{fit(p.name, width)}</Text> : null}
          <Box flexDirection="row" gap={1}>
            {tile('cost', 'Cost', money(totalCost(p)), AMBER)}
            {tile('tokens', 'Tokens', k(p.sessionTokens))}
            {tile('time', 'Time', sessionClock(p), p.isRunning ? ORANGE : undefined)}
          </Box>
          <Text dimColor>{fit(thisRequest(p), width)}</Text>
        </Box>

        <Text>
          <Text color={p.isRunning ? ORANGE : GREEN}>{p.isRunning ? spinner(p.now) : '✓'} </Text>
          <Text bold>{p.isRunning ? 'Working' : 'Done'}</Text>
          <Text dimColor>
            {`  ·  ${plural(sessionAgents(p), 'agent')}${working ? `  ·  ${working} running` : ''}  ·  ${plural(p.sessionSteps, 'step')}`}
          </Text>
        </Text>

        {meters(p).length > 0 && (
          <Box flexDirection="column">
            <Text bold>Limits</Text>
            {meters(p).map(m => {
              const g = bar(m.pct / 100, barWidth)
              const reset = m.resetsAt ? ` · resets in ${until(m.resetsAt, p.now)}` : ''
              return (
                <Box key={`limit-${m.key}`} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text>{m.label}</Text>
                    <Text bold color={levelColor(m.pct)}>
                      {Math.round(m.pct)}%{m.pct >= WARN ? (m.pct >= DANGER ? ' ⛔' : ' ⚠') : ''}
                    </Text>
                  </Box>
                  <Text>
                    <Text color={levelColor(m.pct)}>{g.filled}</Text>
                    <Text dimColor>{g.empty}</Text>
                    <Text dimColor>{fit(reset, 24)}</Text>
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {p.agents.length > 0 && <Text bold>Agents</Text>}
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

        {totalCost(p) !== null && <Text dimColor>{`Session total ${money(totalCost(p))}`}</Text>}
      </Box>
    )
  })
}
