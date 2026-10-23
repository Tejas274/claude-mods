import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, PromptSubmitInput, Register, Timer } from 'claude-code'

import type { Account, Agent, Earlier, Limit, Live, NameKind, Pace, Saved, SavedAgent, Spend, Todo, Track } from '../types'

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
  earlier: { agents: 0, cost: 0, tokens: 0 },
  budget: null,
  budgetChosen: false,
  budgetFired: 0,
  pace: { wall: null, active: 0, kinds: {} },
  account: null,
  spend: null,
  private: false,
}
const live = atom({ plugin: 'usage-radar', key: 'radar' } as const, EMPTY, { shape: 'v6' })

const PANE = 'radar-agents'
// tiles (4) + summary (2) + the limits block (2 + 2 per meter, when shown) + 3 rows per
// agent + the "+N earlier" line (2, when shown) + session total (2), and the dock width.
// `extra`: the name row, the account row, the budget bar under the cost tile, the Spend
// dollars line and the last request (1 each, when shown)
const paneRows = (agents: number, limits: number, hasMore = false, extra = 0): number =>
  10 + extra + (limits > 0 ? 2 + 2 * limits : 0) + 3 * Math.max(1, agents) + (hasMore ? 2 : 0)
const PANE_COLUMNS = 64
const ROWS = 8 // helper rows on screen; the rest share one line
const TICK_MS = 250
const POLL_MS = 1000 // while working, cost, limits and the engine's agent list are read this often

// The spend limit in dollars: read from Anthropic with Claude Code's own login, once a minute
const SPEND_MS = 60_000
const SPEND_SLACK_MS = 5_000 // checks are at least SPEND_MS minus this apart, so a tick a bit early still counts
const SPEND_URL = 'https://api.anthropic.com/api/oauth/usage'
const SPEND_STUCK_MS = 5 * 60_000 // a reading that never answers stops blocking the next one after this
const SPEND_MISSES = 3 // after this many failed checks in a row, the last reading is dropped

// The limit forecast: how fast each limit fills while working, over the last 10 minutes of work
const WINDOW_MS = 600_000 // pace is measured over this much working time
const MIN_SPAN_MS = 180_000 // no forecast before 3 minutes of working time are measured
const SAMPLE_MS = 10_000 // one sample per 10 s of working time
const GAP_MS = 60_000 // a longer gap between readings counts as idle
const RESET_DROP = 5 // a limit dropping 5 points (or a new reset time) is a new window
const SOON_MS = 30 * 60_000 // ⚠ when the limit is under 30 minutes away at this pace
const URGENT_MS = 10 * 60_000 // ⛔ under 10 minutes
const REARM_MS = 60 * 60_000 // the warnings can come again once it's an hour away (or gone)

// Session totals are saved per session id in $.store, at most every 15 s while working
const SAVE_MS = 15_000
const PRUNE_MS = 90 * 24 * 60 * 60 * 1000 // sessions unused for 90 days are forgotten
const KEY = (id: string): string => `session:${id}`
const PRIVATE_KEY = 'private' // /radar private: true or false, for every session (never the email)

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

// The share of the job's cost that goes with some usage units
const share = (p: Live, units: number): number | null => {
  const total = p.agents.reduce((sum, x) => sum + x.units, 0)
  const cost = jobCost(p)
  return cost === null || total === 0 ? null : (cost * units) / total
}

// One agent's cost: its earlier jobs + its share of this one. Frozen once it finishes.
const liveCost = (p: Live, a: Agent): number | null => {
  const s = share(p, a.units)
  return s === null && a.priorCost === 0 ? null : a.priorCost + (s ?? 0)
}
const agentCost = (p: Live, a: Agent): number | null => (a.isRunning ? liveCost(p, a) : a.cost)

// One agent's working time: its earlier runs + the run it's on (pauses left out)
const agentMs = (p: Live, a: Agent): number =>
  a.workedMs + (a.isRunning ? Math.max(0, (a.pausedAt ?? p.now) - a.startedAt - a.pausedMs) : 0)

const main = (p: Live): Agent | undefined => p.agents.find(a => a.id === 'main')
const helpers = (p: Live): Agent[] => p.agents.filter(a => a.id !== 'main')
const jobHelpers = (p: Live): Agent[] => helpers(p).filter(a => a.thisJob)
const anyRunning = (p: Live): boolean => p.agents.some(a => a.isRunning)

// What every helper of the session cost and used (main's row is the rest of the totals)
const helperCost = (p: Live): number => p.earlier.cost + helpers(p).reduce((s, a) => s + (agentCost(p, a) ?? 0), 0)
const helperTokens = (p: Live): number => p.earlier.tokens + helpers(p).reduce((s, a) => s + a.tokens, 0)

// Helper rows: running ones first, then the latest to finish; the rest go on one "+N earlier" line
// Finished helpers, latest first (on a tie the one added later counts as newer)
const latestFirst = (agents: Agent[]): Agent[] =>
  agents
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (y.a.endedAt ?? 0) - (x.a.endedAt ?? 0) || y.i - x.i)
    .map(x => x.a)
const helperRows = (p: Live): { shown: Agent[]; hidden: Agent[] } => {
  const all = [...helpers(p).filter(a => a.isRunning), ...latestFirst(helpers(p).filter(a => !a.isRunning))]
  return { shown: all.slice(0, ROWS), hidden: all.slice(ROWS) }
}
// "+2 earlier agents · ≈$0.20", and "+1 more running · ≈$0.05" for running ones past the rows
const earlierLine = (p: Live): string | null => {
  const { hidden } = helperRows(p)
  const sum = (list: Agent[]) => list.reduce((s, a) => s + (agentCost(p, a) ?? 0), 0)
  const done = hidden.filter(a => !a.isRunning)
  const running = hidden.filter(a => a.isRunning)
  const agents = p.earlier.agents + done.length
  const parts = [
    agents > 0 ? `+${agents} earlier agent${agents === 1 ? '' : 's'} · ${money(p.earlier.cost + sum(done))}` : '',
    running.length > 0 ? `+${running.length} more running · ${money(sum(running))}` : '',
  ].filter(Boolean)
  return parts.length ? parts.join('  ·  ') : null
}
const panelRows = (p: Live, cfg: Config): number =>
  paneRows(
    (main(p) ? 1 : 0) + helperRows(p).shown.length,
    meters(p).length,
    earlierLine(p) !== null,
    (nameShown(p, cfg) ? 1 : 0) +
      (badgeFor(p, cfg) ? 1 : 0) +
      (p.budget !== null ? 1 : 0) +
      (meters(p).some(m => m.spend) ? 1 : 0) +
      (hasRequest(p) ? 1 : 0),
  )

// The clock stands still when nobody works: the job is over, or every running agent is idle
const isIdle = (p: Live): boolean => {
  const running = p.agents.filter(a => a.isRunning)
  return !p.isRunning || (running.length > 0 && running.every(a => a.pausedAt !== null))
}

// Move the clock to `now`. Time while it stood still doesn't count: the job's start moves along.
const withNow = (p: Live, now: number): Live => ({
  ...p,
  now,
  startedAt: isIdle(p) ? p.startedAt + Math.max(0, now - p.now) : p.startedAt,
})

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

// Main's row: the session's totals minus what its helpers cost and used
const mainCost = (p: Live): number | null => {
  const total = totalCost(p)
  return total === null ? null : Math.max(0, total - helperCost(p))
}
const mainTokens = (p: Live): number => Math.max(0, p.sessionTokens - helperTokens(p))

// Main (once it has done anything) + every helper seen this session
const sessionAgents = (p: Live): number => (main(p) || p.sessionSteps || p.sessionTokens ? 1 : 0) + p.helperIds.length

// 1 → "1 step", 3 → "3 steps"
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// The session made its first model request (until then there's no last request to show)
const hasRequest = (p: Live): boolean => p.sessionTokens > 0

// Just the last request: "last request ≈$0.20 · 11k tokens · 0:05"
const lastRequest = (p: Live): string => `last request ${money(jobCost(p))} · ${k(p.jobTokens)} tokens · ${elapsed(p)}`

// A new reading of the engine's cost ledger: add what changed since the last one.
// The ledger sums every priced response of this session id, so it never goes down; a lower
// reading is an older one that arrived late, and is left out. (A new session id starts
// from its own reading: see freshSession.)
const withLedger = (p: Live, ledger: number | null): Live => {
  if (ledger === null) return p
  const last = p.lastLedger ?? ledger
  if (ledger < last) return p
  return { ...p, costUsd: ledger, lastLedger: ledger, sessionCost: p.sessionCost + (ledger - last) }
}

// A helper's row name: "researcher · Find database config"; a teammate's own name
// (the name part of its "<name>@<team>" address, whatever its type)
const agentLabel = (info: { type?: string; description?: string; name?: string; teammateId?: string }): string => {
  const mate = info.teammateId?.split('@')[0]?.trim()
  if (mate) return mate
  const type = info.type?.trim() ?? ''
  const description = info.description?.trim() ?? ''
  if (type === 'teammate') return info.name?.trim() || description || 'Helper'
  if (!type) return description || 'Helper'
  if (!description || description.toLowerCase() === type.toLowerCase()) return type
  return `${type} · ${description}`
}

// Ticket IDs in a prompt, returned in capitals: "DEMO-142" (no leading 0, so not "WEB-01"),
// "qzx-42" when its letters aren't a plain word like step-2 or python-3, a capitals-only
// word ID like "USAGE-RADAR" (not "CI-CD"), or the ID in a Jira .../browse/ABC-1 link.
// Never inside a word, a path or another URL; never "UTF-8", "GPT-4"...
const JIRA_URL = /https?:\/\/\S*?\/browse\/([A-Za-z][A-Za-z0-9_]+-[1-9]\d*)(?![\w-])/g
const TICKET_NUMBER = /(?<![\w./-])([A-Za-z]{2,})-([1-9]\d*)(?![\w/-])(?!\.\d)/g // not ruby-3.2
const TICKET_WORDS = /(?<![\w./-])[A-Z]{3,}(?:-[A-Z]{3,})+(?![\w/-])/g
const NOT_TICKET = /^(UTF|ISO|SHA|MD|HTTP|HTTPS|TLS|SSL|COVID|GPT|ES|IPV|RFC|AES|RSA|UTC|GMT|TODO|FIXME|WIP)-/i
const NOT_A_KEY = ['step', 'python', 'top', 'web', 'page', 'chapter', 'version', 'phase', 'part', 'day', 'week', 'level', 'round']
const NAME_MAX = 80

// "ABC-1" in capitals is a ticket; in lower case its letters need 3+ and not a plain word
const isTicketNumber = (m: RegExpMatchArray): boolean => {
  const key = m[1] ?? ''
  return key === key.toUpperCase() || (key.length >= 3 && !NOT_A_KEY.includes(key.toLowerCase()))
}

const ticketOf = (text: string): string | null => {
  const found = [
    ...[...text.matchAll(JIRA_URL)].map(m => ({ at: m.index ?? 0, id: m[1] ?? '' })),
    ...[...text.matchAll(TICKET_NUMBER)].filter(isTicketNumber).map(m => ({ at: m.index ?? 0, id: m[0] })),
    ...[...text.matchAll(TICKET_WORDS)].map(m => ({ at: m.index ?? 0, id: m[0] })),
  ]
    .filter(f => f.id && !NOT_TICKET.test(f.id))
    .sort((a, b) => a.at - b.at)[0]
  return found ? found.id.toUpperCase() : null
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
  agents: helpers(p).map(a => ({
    id: a.id,
    name: a.name,
    model: a.model,
    cost: agentCost(p, a),
    tokens: a.tokens,
    ms: agentMs(p, a),
    endedAt: a.endedAt ?? now,
  })),
  earlier: p.earlier,
  budgetFired: p.budgetFired,
  // only a budget set for this session is kept; the default one comes back on its own
  ...(p.budgetChosen && { budget: p.budget }),
})

// A saved helper, checked field by field (a bad one is dropped, not the whole record)
const parseAgent = (raw: unknown): SavedAgent | null => {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const count = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  if (typeof r.id !== 'string' || !r.id || r.id === 'main') return null
  if (typeof r.name !== 'string' || typeof r.model !== 'string') return null
  if (r.cost !== null && !count(r.cost)) return null
  if (![r.tokens, r.ms, r.endedAt].every(count)) return null
  return {
    id: r.id,
    name: r.name,
    model: r.model,
    cost: r.cost as number | null,
    tokens: r.tokens as number,
    ms: r.ms as number,
    endedAt: r.endedAt as number,
  }
}

// The folded helpers' line; missing or odd counts as none
const parseEarlier = (raw: unknown): Earlier => {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const count = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
  return { agents: count(r.agents), cost: count(r.cost), tokens: count(r.tokens) }
}

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
  // the budget: null is turned off, a positive amount is set, anything else counts as never set
  const budget = r.budget === null ? null : count(r.budget) && r.budget > 0 ? r.budget : undefined
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
    agents: Array.isArray(r.agents)
      ? r.agents.map(parseAgent).filter((a): a is SavedAgent => a !== null)
      : [],
    earlier: parseEarlier(r.earlier),
    ...(budget !== undefined && { budget }),
    budgetFired: [0, 80, 100].includes(r.budgetFired as number) ? (r.budgetFired as number) : 0,
  }
}

// Another session (start, --resume, /clear): start from its saved totals, or from zero.
// The ledger now is the starting point, so nothing from before is counted twice.
// /clear keeps the budget; spend and its warnings start over
const freshSession = (p: Live, id: string, saved: Saved | null, ledger: number | null, defaultBudget: number | null): Live => {
  const keep = saved === null && p.sessionId !== null
  const has = saved !== null && saved.budget !== undefined
  return fold({
    ...EMPTY,
    sessionId: id,
    limits: p.limits,
    alerted: p.alerted,
    pace: p.pace,
    account: p.account,
    spend: p.spend,
    private: p.private,
    lastLedger: ledger,
    ...(saved && {
      name: saved.name,
      nameKind: saved.nameKind,
      sessionCost: saved.cost,
      sessionTokens: saved.tokens,
      priorMs: saved.ms,
      sessionSteps: saved.steps,
      helperIds: saved.helperIds,
      agents: saved.agents.filter((a, i, all) => all.findIndex(x => x.id === a.id) === i).map(restored),
      earlier: saved.earlier,
    }),
    budget: has ? (saved.budget ?? null) : keep ? p.budget : defaultBudget,
    budgetChosen: has || (keep && p.budgetChosen),
    budgetFired: saved ? saved.budgetFired : 0,
  })
}

// A saved helper back on screen: finished, with its frozen cost, tokens and time
const restored = (a: SavedAgent): Agent => ({
  id: a.id,
  name: a.name,
  model: a.model,
  isRunning: false,
  context: 0,
  units: 0,
  tokens: a.tokens,
  priorCost: a.cost ?? 0,
  cost: a.cost,
  workedMs: a.ms,
  startedAt: a.endedAt,
  endedAt: a.endedAt,
  pausedAt: null,
  pausedMs: 0,
  thisJob: false,
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
    tokens: 0,
    priorCost: 0,
    cost: null,
    workedMs: 0,
    startedAt: p.now,
    endedAt: null,
    pausedAt: null,
    pausedMs: 0,
    thisJob: true,
  }
  const next = change(base)
  const agents = known ? p.agents.map(a => (a.id === id ? next : a)) : [...p.agents, next]
  // main first, then every helper of the session (the rows on screen are picked when drawing)
  return withHelper({ ...p, agents: [...agents.filter(a => a.id === 'main'), ...agents.filter(a => a.id !== 'main')] }, id)
}

// An agent is done: freeze its cost, tokens and time, so later jobs don't change them.
// Its units stay in this job's split, so the others' shares don't take its part again.
const finished = (p: Live, a: Agent): Agent => ({
  ...a,
  isRunning: false,
  endedAt: p.now,
  workedMs: agentMs(p, a),
  pausedAt: null,
  pausedMs: 0,
  cost: liveCost(p, a),
})

// An agent works again (a new turn or step): its pause ends, and the clock runs again
const withWorking = (p: Live, id: string, now: number): Live => {
  const a = p.agents.find(x => x.id === id)
  if (!a || a.pausedAt === null) return p
  return withAgent(withNow(p, now), id, x => ({
    ...x,
    pausedAt: null,
    pausedMs: x.pausedMs + Math.max(0, now - (x.pausedAt ?? now)),
  }))
}

// Keep the latest finished helpers; fold older ones into the "+N earlier" line, so the
// session's list (and its record) stays small. Only between jobs, when no units are counting.
const fold = (p: Live): Live => {
  const old = latestFirst(helpers(p).filter(a => !a.isRunning)).slice(ROWS)
  if (old.length === 0) return p
  return {
    ...p,
    agents: p.agents.filter(a => !old.includes(a)),
    earlier: {
      agents: p.earlier.agents + old.length,
      cost: p.earlier.cost + old.reduce((s, a) => s + (a.cost ?? 0), 0),
      tokens: p.earlier.tokens + old.reduce((s, a) => s + a.tokens, 0),
    },
  }
}

// A new job: keep main's model and context, and the session's helpers with their frozen
// numbers; this job's split starts over. The last job's working time moves into the
// session's time; the other totals already count.
const newJob = (p: Live, now: number, cost: number | null, window: number): Live => {
  const m = main(p)
  const ended = withNow(p, now)
  const kept = helpers(ended).map(a => {
    const done = a.isRunning ? finished(ended, a) : a
    return { ...done, units: 0, priorCost: done.cost ?? 0, thisJob: false }
  })
  return fold({
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
    agents: [
      ...(m ? [{ ...m, isRunning: true, units: 0, tokens: 0, startedAt: now, endedAt: null, pausedAt: null, pausedMs: 0 }] : []),
      ...kept,
    ],
  })
}

// The engine's list of agents (read while working): names for helpers we couldn't name,
// helpers that ended without a turn.complete, and helpers that went idle or work again.
// A helper that (re)started after the list was read (`readAt`) waits for the next reading.
const DONE = ['completed', 'failed', 'killed']
const IDLE = ['idle', 'waiting']
const withList = (
  p: Live,
  list: readonly { id: string; status: string; type?: string; description?: string; name?: string; teammateId?: string }[],
  now: number,
  readAt: number = now,
): Live =>
  helpers(p).reduce((q, a) => {
    const info = list.find(x => x.id === a.id)
    if (!info || (a.isRunning && a.startedAt > readAt)) return q
    const named = a.name === 'Helper' ? withAgent(q, a.id, x => ({ ...x, name: agentLabel(info) })) : q
    if (!a.isRunning) return named
    if (DONE.includes(info.status)) return withAgent(named, a.id, x => finished(named, x))
    if (IDLE.includes(info.status)) return withAgent(named, a.id, x => ({ ...x, pausedAt: x.pausedAt ?? now }))
    return info.status === 'running' ? withWorking(named, a.id, now) : named
  }, p)

// ── Limits & context ────────────────────────────────────────────────────
const WARN = 80
const DANGER = 95

const limitLabel = (kind: string): string =>
  kind === 'five_hour' ? '5h limit' : kind === 'seven_day' ? 'Weekly' : kind === 'spend_limit' ? 'Spend' : kind.replace(/_/g, ' ')

const levelColor = (pctUsed: number): string => (pctUsed >= DANGER ? RED : pctUsed >= WARN ? AMBER : GREEN)

// 7_800_000 → "2h 10m"; also "3d 4h", "12m"
const duration = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

// How long until a reset time: "2h 10m", or "now" once it's past
const until = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  return !(ms > 0) ? 'now' : duration(ms)
}

// A reset time as ISO text. The engine sends ISO text; epoch seconds or milliseconds (a number,
// or digits in text) are taken too, and anything else is left out
const isoOf = (x: unknown): string | undefined => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && /^\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : NaN
  if (Number.isFinite(n) && n > 0) return new Date(n < 1e12 ? n * 1000 : n).toISOString()
  return typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : undefined
}

// ── The spend limit in dollars (Anthropic's usage endpoint) ─────────────
// Only the numbers are kept; anything odd counts as no spend limit. Never throws.
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
// how many decimals an amount in minor units has (0 to 6), else null
const exp = (x: unknown): number | null => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6 ? (x as number) : null)
// { amount_minor: 1240, exponent: 2 } → 12.40
const amount = (m: unknown): number | null => {
  if (!isObj(m) || !fin(m.amount_minor)) return null
  const e = exp(m.exponent)
  return e === null ? null : m.amount_minor / 10 ** e
}
const cur = (x: unknown): string => (typeof x === 'string' && /^[A-Z]{3}$/.test(x) ? x : 'USD')
// A spend limit from its two amounts: a cap above 0, and nothing used below 0
const validSpend = (used: number | null, cap: number | null, currency: string): Spend | null =>
  used !== null && cap !== null && cap > 0 && used >= 0 ? { used, cap, currency, pct: (used / cap) * 100 } : null

// The answer's spend limit: its `spend` block, else `extra_usage`; null when it has none
const spendOf = (o: Record<string, unknown>): Spend | null => {
  const s = o.spend
  if (isObj(s) && s.enabled === true) {
    const limit = isObj(s.limit) ? s.limit : {}
    const used = isObj(s.used) ? s.used : {}
    const found = validSpend(amount(s.used), amount(s.limit), cur(limit.currency ?? used.currency))
    if (found) return found
  }
  const x = o.extra_usage
  if (isObj(x) && x.is_enabled === true) {
    const d = exp(x.decimal_places)
    if (d !== null && fin(x.used_credits) && fin(x.monthly_limit)) {
      const found = validSpend(x.used_credits / 10 ** d, x.monthly_limit / 10 ** d, cur(x.currency))
      if (found) return found
    }
  }
  return null
}

// The answer's text as a JSON object, or null when it isn't one
const jsonObject = (text: string): Record<string, unknown> | null => {
  try {
    const o: unknown = JSON.parse(text)
    return isObj(o) ? o : null
  } catch {
    return null
  }
}

// 12.404 → "$12.40", 100 → "$100"; another currency: "12.40 EUR"
const cash = (n: number, currency: string): string => {
  const c = Math.round(n * 100) / 100
  const text = Number.isInteger(c) ? `${c}` : c.toFixed(2)
  return currency === 'USD' ? `$${text}` : `${text} ${currency}`
}

// What's left of the spend limit ("Left", "$87.60"), or how much over it ("Over", "$3.50")
const spendLeft = (s: Spend): { title: string; text: string } =>
  s.cap - s.used >= 0 ? { title: 'Left', text: cash(s.cap - s.used, s.currency) } : { title: 'Over', text: cash(s.used - s.cap, s.currency) }
// "$12.40 of $100 used"
const spendUsed = (s: Spend): string => `${cash(s.used, s.currency)} of ${cash(s.cap, s.currency)} used`

// ── The forecast: when a limit runs out at the pace it fills while working ──
// The clock here is working time: a gap of over a minute between two readings, time while
// the job stands idle, or the gap before a job (wall null), adds nothing, and what a limit
// rose meanwhile isn't counted. Two readings at the same moment: the rise still counts.
const withPace = (p: Live, limits: readonly Limit[], now: number): Pace => {
  const wall = p.pace.wall
  const gap = wall === null ? 0 : now - wall
  // a reading older than the last one (it arrived late): the newer one already counted
  if (gap < 0) return p.pace
  const working = wall !== null && !isIdle(p) && gap <= GAP_MS
  const step = working ? gap : 0
  const active = p.pace.active + step
  // no limits in this reading (none reported yet): keep what we measured so far
  if (limits.length === 0) return { wall: now, active, kinds: p.pace.kinds }
  const kinds: Record<string, Track> = {}
  for (const l of limits) {
    const t = p.pace.kinds[l.kind]
    const moved = Math.abs((Date.parse(l.resetsAt ?? '') || 0) - (Date.parse(t?.resetsAt ?? '') || 0)) > 60_000
    if (!t || t.pct - l.percentUsed >= RESET_DROP || moved) {
      // first reading, or the window was reset: start measuring over
      kinds[l.kind] = { pct: l.percentUsed, resetsAt: l.resetsAt, rise: 0, samples: [{ at: active, rise: 0 }] }
      continue
    }
    const rise = t.rise + (working ? Math.max(0, l.percentUsed - t.pct) : 0)
    const last = t.samples[t.samples.length - 1]
    const samples = !last || active - last.at >= SAMPLE_MS ? [...t.samples, { at: active, rise }] : t.samples
    kinds[l.kind] = { pct: l.percentUsed, resetsAt: l.resetsAt, rise, samples: samples.filter(x => x.at >= active - WINDOW_MS) }
  }
  return { wall: now, active, kinds }
}

// How long until a limit is used up at this pace (ms of working time), or null: not working,
// under 3 minutes measured, not rising, already used up, or it resets before then anyway
const forecastMs = (p: Live, l: Limit): number | null => {
  const samples = p.pace.kinds[l.kind]?.samples ?? []
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (isIdle(p) || !l.resetsAt || l.percentUsed >= 100 || !first || !last || samples.length < 2) return null
  const span = last.at - first.at
  if (span < MIN_SPAN_MS) return null
  const rate = (last.rise - first.rise) / span
  if (!(rate > 0)) return null
  const left = (100 - l.percentUsed) / rate
  return left >= Date.parse(l.resetsAt) - p.now ? null : left
}

// "~1h 10m left" (never under a minute)
const leftText = (ms: number): string => `~${duration(Math.max(60_000, ms))} left`

// Every meter we watch: the spend limit first, then the plan limits, then context.
// `left`: the forecast, for limits; `spend`: the dollars, when Anthropic told us them
type Meter = { key: string; label: string; pct: number; resetsAt?: string; left: number | null; spend?: Spend }
const limitMeter = (p: Live, l: Limit): Meter => ({
  key: l.kind,
  label: limitLabel(l.kind),
  pct: l.percentUsed,
  resetsAt: l.resetsAt,
  left: forecastMs(p, l),
})
// The spend limit is one meter: Anthropic's dollars (and percent) win, the reset time and the
// forecast come from Claude Code's own spend_limit, when it reports one
const meters = (p: Live): Meter[] => {
  const engine = p.limits.find(l => l.kind === 'spend_limit')
  const spend: Meter[] = p.spend
    ? [{ key: 'spend_limit', label: 'Spend', pct: p.spend.pct, resetsAt: engine?.resetsAt, left: engine ? forecastMs(p, engine) : null, spend: p.spend }]
    : engine
      ? [limitMeter(p, engine)]
      : []
  return [
    ...spend,
    ...p.limits.filter(l => l.kind !== 'spend_limit').map(l => limitMeter(p, l)),
    ...(p.contextPct === null ? [] : [{ key: 'context', label: 'Context', pct: p.contextPct, left: null }]),
  ]
}

// "⚠ 84%", "⛔ 103%", or just "40%" under 80%
const glyph = (pctUsed: number): string => (pctUsed >= DANGER ? '⛔' : pctUsed >= WARN ? '⚠' : '')
const levelText = (pctUsed: number): string => `${glyph(pctUsed) ? `${glyph(pctUsed)} ` : ''}${Math.round(pctUsed)}%`
// a forecast after a meter: " · ~25m left"
const paceText = (m: Meter): string => (m.left !== null ? ` · ${leftText(m.left)}` : '')

// How wide one meter is on the band: "Spend $87.60 left ⚠ 84%" (the dollars, no bar), else
// "5h limit ━━━━━━━━━━ 84% ⚠"; then its forecast
const BAND_BAR = 10
const bandWidth = (m: Meter): number => {
  const l = m.spend ? spendLeft(m.spend) : null
  const body = l
    ? `${m.label} ${l.text} ${l.title.toLowerCase()} ${levelText(m.pct)}`.length
    : `${m.label} `.length + BAND_BAR + ` ${Math.round(m.pct)}%`.length + (m.pct >= WARN ? 2 : 0)
  return body + paceText(m).length
}

// The meters that fit on the band's one line (3 spaces apart): Spend first, then Context, then
// the fullest. The first always stays; they're drawn in their usual order
const bandMeters = (p: Live, width: number): Meter[] => {
  const all = meters(p)
  const rank = (m: Meter): number => (m.key === 'spend_limit' ? 2 : m.key === 'context' ? 1 : 0)
  const kept: Meter[] = []
  let used = 0
  for (const m of [...all].sort((a, b) => rank(b) - rank(a) || b.pct - a.pct)) {
    const w = bandWidth(m) + (kept.length ? 3 : 0)
    if (kept.length && used + w > width) break
    kept.push(m)
    used += w
  }
  return all.filter(m => kept.includes(m))
}

// Which meters crossed 80% or 95% since the last reading: one alert per level
const meterAlerts = (next: Live, alerted: Record<string, number>, now: number): { alerted: Record<string, number>; alerts: string[] } => {
  const out = { ...alerted }
  const alerts: string[] = []
  for (const m of meters(next)) {
    const level = m.pct >= DANGER ? DANGER : m.pct >= WARN ? WARN : 0
    if (level > (out[m.key] ?? 0)) {
      const reset = m.resetsAt ? ` · resets in ${until(m.resetsAt, now)}` : ''
      const tip = m.key === 'context' ? ' · run /compact soon' : ''
      alerts.push(`${level >= DANGER ? '⛔' : '⚠'} ${m.label} ${Math.round(m.pct)}% used${reset}${tip}`)
    }
    out[m.key] = level // drops back to 0 after a reset or /compact, so it can alert again
  }
  return { alerted: out, alerts }
}

// Save the latest limits and context, and work out which alerts to pop (each once per level).
// Every reading also feeds the forecast, and checks the budget.
const withUsage = (
  p: Live,
  limits: readonly Limit[],
  contextPct: number | undefined,
  now: number,
): { next: Live; alerts: string[] } => {
  const fresh = limits
    .filter(l => typeof l.percentUsed === 'number' && Number.isFinite(l.percentUsed))
    .map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: isoOf(l.resetsAt) }))
  const at = Math.max(p.now, now)
  const next: Live = {
    ...(at > p.now ? withNow(p, at) : p),
    limits: fresh,
    contextPct: contextPct ?? p.contextPct,
    pace: withPace(p, fresh, now),
  }
  const { alerted, alerts } = meterAlerts(next, p.alerted, p.now)
  // the forecast: ⚠ under 30 minutes, ⛔ under 10, each once; again after a reset, or once it's
  // gone or an hour away while working (an idle job keeps what was shown)
  for (const l of isIdle(next) ? [] : next.limits) {
    const f = forecastMs(next, l)
    const key = `pace:${l.kind}`
    const sev = f === null ? 0 : f < URGENT_MS ? 2 : f < SOON_MS ? 1 : 0
    if (f !== null && sev > (alerted[key] ?? 0)) {
      alerts.push(`${sev === 2 ? '⛔' : '⚠'} ${limitLabel(l.kind)}: ${leftText(f)} at this pace · resets in ${until(l.resetsAt, next.now)}`)
      alerted[key] = sev
    } else if (f === null || f >= REARM_MS) alerted[key] = 0
  }
  const b = withBudget({ ...next, alerted })
  return { next: b.next, alerts: [...alerts, ...b.alerts] }
}

// ── The session budget ─────────────────────────────────────────────────
// Which warning a spend has reached: 0, 80 (% of the budget) or 100
const budgetLevel = (spent: number, budget: number): number => (spent >= budget ? 100 : spent >= 0.8 * budget ? 80 : 0)
const budgetColor = (level: number): string => (level >= 100 ? RED : level >= 80 ? AMBER : GREEN)
const dollars = (n: number): string => `$${n.toFixed(2)}`
// "≈$3.20 / $5.00"
const budgetText = (p: Live): string => `${money(totalCost(p))} / ${dollars(p.budget ?? 0)}`

// Past 80% or 100% of the budget: one warning per level
const withBudget = (p: Live): { next: Live; alerts: string[] } => {
  if (p.budget === null) return { next: p, alerts: [] }
  const level = budgetLevel(p.sessionCost, p.budget)
  if (level <= p.budgetFired) return { next: p, alerts: [] }
  const next = { ...p, budgetFired: level }
  return { next, alerts: [level >= 100 ? `⛔ Budget reached · ${budgetText(next)}` : `⚠ Budget 80% used · ${budgetText(next)}`] }
}

// A budget set with /radar budget (null: off). Levels already crossed count as warned.
const withBudgetSet = (p: Live, budget: number | null): Live => ({
  ...p,
  budget,
  budgetChosen: true,
  budgetFired: budget === null ? 0 : budgetLevel(p.sessionCost, budget),
})

// "/radar budget …": "" shows it, off/none/0 turns it off, "5" or "$2.50" sets it; null: can't read it
const parseBudgetArg = (arg: string): number | 'show' | 'off' | null => {
  const a = arg.trim()
  if (!a) return 'show'
  if (/^(off|none|0)$/i.test(a)) return 'off'
  const m = /^\$?(\d+(?:\.\d+)?)$/.exec(a)
  const n = m ? Number(m[1]) : NaN
  return n > 0 && n <= 1_000_000 ? n : null
}

// ── Options and the account badge ───────────────────────────────────────
// The plugin's options (/config or settings.json), read leniently: anything odd counts as unset
type Config = {
  accounts: { domain: string; label: string }[]
  showAccount: boolean
  showEmail: boolean
  showName: boolean
  defaultBudget: number | null
  showSpend: boolean
}
const configOf = (o: PluginOptions): Config => {
  const raw = o.accounts
  // one entry per item, or one text with entries split by commas, semicolons or new lines
  const items: unknown[] = Array.isArray(raw) ? [...raw] : [raw]
  const accounts = items
    .flatMap(x => (typeof x === 'string' ? x.split(/[,;\n]/) : []))
    .map(x => /^\s*@?([^=:\s]+)\s*[=:]\s*(.+?)\s*$/.exec(x))
    .flatMap(m => (m && m[1] && m[2] ? [{ domain: m[1].toLowerCase(), label: m[2] }] : []))
  const budget = o.defaultBudget
  return {
    accounts,
    showAccount: o.showAccount !== false,
    showEmail: o.showEmail !== false,
    showName: o.showName !== false,
    defaultBudget: typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : null,
    showSpend: o.showSpend !== false,
  }
}

// An email's label: its domain or a parent domain matches (case doesn't matter), the longest wins
const labelFor = (email: string, accounts: Config['accounts']): string | null => {
  const d = (email.split('@').pop() ?? '').toLowerCase()
  const hit = accounts
    .filter(a => d === a.domain || d.endsWith(`.${a.domain}`))
    .sort((a, b) => b.domain.length - a.domain.length)[0]
  return hit ? hit.label : null
}

// WORK amber, PERSONAL green, any other label orange
const labelColor = (label: string): string => (/^work$/i.test(label) ? AMBER : /^personal$/i.test(label) ? GREEN : ORANGE)

// The dim hint next to a shown email, when there's room for all of it
const HINT = '(/radar private to hide)'

// The account badge: its text, its colour (a label's; none for a bare email) and whether it shows the email
type Badge = { text: string; color: string | undefined; hasEmail: boolean }

// "[WORK] me@acme.com", or "[WORK]" with no email (showEmail off, private mode, none known).
// No label: just the email, else no badge at all (null). Never the organization or the config
// dir: those can name the company
const badgeOf = (a: Account, cfg: Config, hide: boolean): Badge | null => {
  const email = cfg.showEmail && !hide && !!a.email
  const label = a.email ? labelFor(a.email, cfg.accounts) : null
  if (label) return { text: email ? `[${label}] ${a.email}` : `[${label}]`, color: labelColor(label), hasEmail: email }
  return email && a.email ? { text: a.email, color: undefined, hasEmail: true } : null
}
// The badge the band and the panel draw, or null (showAccount off, no account yet, or nothing to show)
const badgeFor = (p: Live, cfg: Config): Badge | null =>
  cfg.showAccount && p.account ? badgeOf(p.account, cfg, p.private) : null

// The session name the band and the panel draw, or null (showName off, private mode, no name yet)
const nameShown = (p: Live, cfg: Config): string | null => (cfg.showName && !p.private ? p.name : null)

// The two fields we use from Claude Code's account file; anything odd counts as missing
const parseAccountFile = (text: string): { email: string | null; org: string | null } => {
  try {
    const o = (JSON.parse(text) as { oauthAccount?: Record<string, unknown> } | null)?.oauthAccount
    const email = typeof o?.emailAddress === 'string' && o.emailAddress.includes('@') ? o.emailAddress.trim() : null
    const org = typeof o?.organizationName === 'string' && o.organizationName.trim() ? o.organizationName.trim() : null
    return { email, org }
  } catch {
    return { email: null, org: null }
  }
}

// "/Users/me/.claude-work" → "~/.claude-work"; outside home just the folder's name. Never drawn:
// a config folder name can reveal the company (like ~/.claude-acme)
const shortDir = (path: string, home: string | undefined): string => {
  const dir = path.replace(/\/+$/, '') || path
  const h = home?.replace(/\/+$/, '')
  if (h && (dir === h || dir.startsWith(`${h}/`))) return `~${dir.slice(h.length)}`
  return dir.split('/').pop() || dir
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

// Private mode, for every session: on only when the store says true (anything else is off).
// Only that one boolean is kept, never the email or the name
const loadPrivate = async ($: EngineInterface): Promise<void> => {
  try {
    const stored = (await $.store.get(PRIVATE_KEY)) === true
    await update($, live, p => (p.private === stored ? p : { ...p, private: stored }))
  } catch {
    // keep what we have
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

// The signed-in account, from Claude Code's account file: $CLAUDE_CONFIG_DIR/.claude.json,
// else ~/.claude.json. Only the email and organization are kept, and never saved. Never throws.
const detectAccount = async ($: EngineInterface): Promise<Account> => {
  let dir: string | undefined
  let home: string | undefined
  try {
    dir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim() || undefined
  } catch {
    // ignore
  }
  try {
    home = (await $.env.get('HOME'))?.trim() || undefined
  } catch {
    // ignore
  }
  const file = dir ? `${dir.replace(/\/+$/, '')}/.claude.json` : home ? `${home.replace(/\/+$/, '')}/.claude.json` : null
  let found: { email: string | null; org: string | null } = { email: null, org: null }
  if (file) {
    try {
      found = parseAccountFile(String(await $.fs.read(file)))
    } catch {
      // no file (an API key, Bedrock, Vertex...): no email, so no badge unless labelled
    }
  }
  // configDir is kept but never drawn (a config folder name can reveal the company)
  return { ...found, configDir: dir ? shortDir(dir, home) : '~/.claude' }
}

// An open panel takes its new height (a meter or the budget bar came or went); a closed one is
// sized when it opens
const resizeIfOpen = async ($: EngineInterface, p: Live, cfg: Config): Promise<void> => {
  try {
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) {
      await $.ui.open({ id: PANE, title: 'Usage Radar', rows: panelRows(p, cfg), columns: PANE_COLUMNS })
    }
  } catch {
    // ignore: the next open sizes it
  }
}

// An open panel takes its new height only when it changed
const resizeIfChanged = async ($: EngineInterface, before: Live, after: Live, cfg: Config): Promise<void> => {
  if (panelRows(before, cfg) !== panelRows(after, cfg)) await resizeIfOpen($, after, cfg)
}

// /rename: the session gets its name (or a new one), saved; while the name is shown an open panel
// takes the name row when it first comes
const nameSession = async ($: EngineInterface, cfg: Config, name: string, kind: NameKind): Promise<void> => {
  const before = await read($, live)
  const after = await update($, live, p => withName(p, name, kind))
  await save($)
  await resizeIfChanged($, before, after, cfg)
}

// ── The spend limit, read from Anthropic once a minute (also while idle) ──
let spendTimer: Timer | undefined
let spendAt: number | null = null // when the last check started, so checks stay a minute apart
let spendBusyAt: number | null = null // a check on its way since then (null: none)
let spendCheck = 0 // which check is the latest, so a late answer of an older one is dropped
let spendMisses = 0 // failed checks in a row; the last reading is kept until SPEND_MISSES

// The session's login: a claude login's handle, 'none' (an API key, Bedrock, Vertex, a gateway,
// no login: there's no spend limit to read) or 'fail' (asking failed: try again later). Never throws.
const loginOf = async ($: EngineInterface): Promise<{ handle: string } | 'none' | 'fail'> => {
  try {
    const auth = await $.session.authorize()
    return auth && auth.kind === 'bearer' ? { handle: auth.handle } : 'none'
  } catch {
    return 'fail'
  }
}

// One request with that login. `ok: false` when it failed (refused, an error, an odd answer);
// `ok: true` when Anthropic answered, with spend null when the account has no spend limit.
// Only the numbers are kept, nothing is logged. Never throws.
const fetchSpend = async ($: EngineInterface, handle: string): Promise<{ ok: true; spend: Spend | null } | { ok: false }> => {
  try {
    const r = await $.http.fetch(SPEND_URL, { auth: handle, headers: { 'anthropic-beta': 'oauth-2025-04-20' } })
    if (!r.ok) return { ok: false }
    const o = jsonObject(r.text)
    return o ? { ok: true, spend: spendOf(o) } : { ok: false }
  } catch {
    return { ok: false }
  }
}

const sameSpend = (a: Spend | null, b: Spend | null): boolean =>
  a === b || (a !== null && b !== null && a.used === b.used && a.cap === b.cap && a.currency === b.currency)

// Another account than `was`: both name someone (email or organization) and it's someone else.
// A file that names nobody, or can't be read, says nothing.
const named = (a: Account | null): a is Account => a !== null && (a.email !== null || a.org !== null)
const switched = (was: Account | null, now: Account): boolean =>
  named(was) && named(now) && (now.email !== was.email || now.org !== was.org)

// Put a reading (or none) on screen, with its alerts; `account`: the login changed to this one
const putSpend = async ($: EngineInterface, cfg: Config, spend: Spend | null, account?: Account): Promise<void> => {
  const before = await read($, live)
  let alerts: string[] = []
  const after = await update($, live, p => {
    // update may run this more than once: only the last run's outcome counts
    alerts = []
    const base = account ? { ...p, account } : p
    if (sameSpend(p.spend, spend)) return base
    const q: Live = { ...base, spend }
    const r = meterAlerts(q, p.alerted, p.now)
    alerts = r.alerts
    return { ...q, alerted: r.alerted }
  })
  for (const a of alerts) $.ui.toast(a)
  if (after !== before) $.ui.status(statusLine(after))
  // the Spend row or its dollars (or the account's badge) came or went: an open panel takes its new height
  if (panelRows(before, cfg) !== panelRows(after, cfg)) await resizeIfOpen($, after, cfg)
}

// Read the spend limit, at most once a minute (from the minute timer, or an event: start, a prompt,
// a measure) and one check at a time. Nothing drawn (a -p run, an SDK session no client attached
// to yet): no request. A failed check keeps the last reading; the third in a row drops it. An
// answer without a spend limit, or another login (no claude login, another account), drops it at once.
const refreshSpend = async ($: EngineInterface, cfg: Config): Promise<void> => {
  if (!cfg.showSpend) return
  let now: number | null = null
  try {
    if ((await $.session.surfaces()).length === 0) return
    now = await $.clock.now()
    if (spendBusyAt !== null && now - spendBusyAt < SPEND_STUCK_MS) return
    if (spendAt !== null && now >= spendAt && now - spendAt < SPEND_MS - SPEND_SLACK_MS) return
    spendAt = spendBusyAt = now
    const check = ++spendCheck
    const login = await loginOf($)
    if (check !== spendCheck) return
    if (login === 'none') {
      spendMisses = 0
      return await putSpend($, cfg, null)
    }
    let got: { ok: true; spend: Spend | null } | { ok: false } = { ok: false }
    if (login !== 'fail') {
      // another account than the one on screen: its reading goes now, before the new one comes
      const who = await detectAccount($)
      if (switched((await read($, live)).account, who)) {
        spendMisses = 0
        await putSpend($, cfg, null, who)
      }
      got = await fetchSpend($, login.handle)
      // a newer check started meanwhile (this one was stuck): its answer counts, not this one
      if (check !== spendCheck) return
      // the account changed while this one was on its way: its answer is the old account's
      const after = await detectAccount($)
      if (switched(who, after)) {
        spendMisses = 0
        spendAt = null // the next tick or event checks the new account right away
        return await putSpend($, cfg, null, after)
      }
    }
    spendMisses = got.ok ? 0 : spendMisses + 1
    if (!got.ok && spendMisses < SPEND_MISSES) return
    await putSpend($, cfg, got.ok ? got.spend : null)
  } catch {
    // ignore: the next check tries again
  } finally {
    if (now !== null && spendBusyAt === now) spendBusyAt = null
  }
}

const stopSpend = () => {
  spendTimer?.cancel()
  spendTimer = undefined
}

// Check now, then once a minute
const startSpend = ($: EngineInterface, cfg: Config) => {
  if (!cfg.showSpend) return
  stopSpend()
  spendTimer = $.clock.every(SPEND_MS, () => void refreshSpend($, cfg))
  void refreshSpend($, cfg)
}

// Which session are we in? On a new id (start, --resume, /clear) save the old one and
// load the new one's totals, or start them at zero.
const syncSession = async ($: EngineInterface, cfg: Config): Promise<void> => {
  try {
    const id = await $.session.id()
    if (!id) return
    const p = await read($, live)
    // the account is read once, the first time we know the session
    if (!p.account) {
      const a = await detectAccount($)
      await update($, live, q => (q.account ? q : { ...q, account: a }))
    }
    if (p.sessionId === id) return
    if (p.sessionId) await save($)
    const saved = await load($, id)
    let ledger: number | null = null
    try {
      ledger = (await $.session.usage()).cost?.usd ?? null
    } catch {
      // no ledger reading: the first one later becomes the starting point
    }
    await update($, live, q => (q.sessionId === id ? q : freshSession(q, id, saved, ledger, cfg.defaultBudget)))
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
    if (e.command.name === 'radar') return null // /radar budget 5 is no name
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

// ── The clock while working ─────────────────────────────────────────────
let ticker: Timer | undefined // the clock while a job runs
let tickerId = 0 // which ticker is the current one, so a late tick of an old one can't stop it
let polledAt = 0 // when the ticker last read cost, limits and the agent list

const stopTicker = () => {
  ticker?.cancel()
  ticker = undefined
  polledAt = 0 // the next job reads fresh numbers on its first tick
}

// everyone is done → stop the clock, save and celebrate
const finishJob = async ($: EngineInterface, p: Live, isAborted: boolean): Promise<void> => {
  stopTicker()
  await save($)
  const crew = jobHelpers(p).length
  if (p.steps > 0 || crew > 0) {
    $.ui.toast(
      `${isAborted ? '■ Stopped' : '✓ All done'} in ${elapsed(p)}${crew ? ` · ${crew + 1} agents` : ''} · ${p.steps} steps · ${money(jobCost(p))}`,
    )
  }
}

// Every second while working: fresh cost and limits, and what the engine says about each
// helper (no saving here: that stays occasional). If the last running helper is listed as
// finished, the job ends here, since its turn.complete may never come.
const poll = async ($: EngineInterface, now: number): Promise<void> => {
  let usage: Awaited<ReturnType<EngineInterface['session']['usage']>> | undefined
  let list: Awaited<ReturnType<EngineInterface['agent']['list']>> | undefined
  // the list first, then the ledger: the reading is as fresh as it can be when it's applied
  try {
    list = await $.agent.list()
  } catch {
    /* ignore */
  }
  try {
    usage = await $.session.usage()
  } catch {
    /* ignore */
  }
  let alerts: string[] = []
  let ended = false
  const p = await update($, live, p => {
    // update may run this more than once: only the last run's outcome counts
    ended = false
    alerts = []
    if (!p.isRunning) return p
    let q = withLedger(p, usage?.cost?.usd ?? null)
    if (usage) {
      const r = withUsage(q, usage.rateLimits, usage.context.percent, now)
      q = r.next
      alerts = r.alerts
    }
    if (list) {
      q = withList(q, list, Math.max(now, p.now), now)
      if (anyRunning(p) && !anyRunning(q)) {
        ended = true
        q = { ...q, isRunning: false, current: null }
      }
    }
    return q
  })
  for (const a of alerts) $.ui.toast(a)
  $.ui.status(statusLine(p))
  if (ended) await finishJob($, p, false)
}

// The clock: ticks until the whole job is done, and polls every POLL_MS
const tick = async ($: EngineInterface, id: number): Promise<void> => {
  try {
    if (id !== tickerId) return
    const t = await $.clock.now()
    const p = await update($, live, p => (p.isRunning ? withNow(p, t) : p))
    if (id !== tickerId) return
    if (!p.isRunning) return stopTicker()
    $.ui.status(statusLine(p))
    if (t - polledAt >= POLL_MS || t < polledAt) {
      polledAt = t
      await poll($, t)
    }
  } catch {
    /* ignore: the next tick tries again */
  }
}

const startTicker = ($: EngineInterface) => {
  stopTicker()
  const id = ++tickerId
  ticker = $.clock.every(TICK_MS, () => void tick($, id))
}

// ════════════════════════════════════════════════════════════════════════════
// 4. HOOKS: listen to Claude Code's events
// ════════════════════════════════════════════════════════════════════════════
export const register: Register = (on, options) => {
  // the options from /config (or settings.json), read once when the mod loads
  const cfg = configOf(options ?? {})

  // ── Startup: pick up this session's totals, add the /radar command ─────
  on('session.start', async ($, e, next) => {
    await loadPrivate($)
    await syncSession($, cfg)
    startSpend($, cfg)
    await $.command.register({
      name: 'radar',
      description:
        'Open Usage Radar; /radar budget <amount|off> sets a cost budget for this session; /radar private hides your email and session name (/radar private off shows them)',
    })
    return next(e)
  })

  // ── The session ends (exit, /clear, ...): save its totals, stop the clock ─
  on('session.end', async ($, e, next) => {
    stopTicker()
    stopSpend()
    await save($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── Classic hooks carry the session's title: we take session_title as the /rename name ──
  on('classic.SessionStart', async ($, e, next) => {
    await syncSession($, cfg)
    const title = e.session_title?.trim()
    if (title) await nameSession($, cfg, title, 'rename')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await syncSession($, cfg)
    const title = e.session_title?.trim()
    if (title) await nameSession($, cfg, title, 'rename')
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── /rename: the built-in runs as usual, and the radar takes the new name ─
  on('command.run', { command: 'rename' }, async ($, e, next) => {
    const r = await next(e)
    try {
      await syncSession($, cfg)
      const title = e.args.trim()
      if (title) await nameSession($, cfg, title, 'rename')
    } catch {
      // the rename itself already happened
    }
    return r
  }).catch(($, e, next) => next(e))

  // ── /radar opens the panel; /radar budget <amount|off> sets this session's budget;
  //    /radar private [on|off] hides (or shows again) the email and the session name, every session ─
  on('command.run', { command: 'radar' }, async ($, e) => {
    const pm = /^private\b\s*(.*)$/i.exec(e.args.trim())
    if (pm) {
      const a = (pm[1] ?? '').trim().toLowerCase()
      if (a !== '' && a !== 'on' && a !== 'off') return { text: 'Usage Radar: use /radar private or /radar private off' }
      const hide = a !== 'off'
      const before = await read($, live)
      const after = await update($, live, p => (p.private === hide ? p : { ...p, private: hide }))
      try {
        await $.store.set(PRIVATE_KEY, hide)
      } catch {
        // not kept for the next session; this one still changes
      }
      // the name row (and an unlabelled badge) came or went: an open panel takes its new height
      await resizeIfChanged($, before, after, cfg)
      return { text: hide ? 'Private mode on: email and session name hidden.' : 'Private mode off: email and session name shown.' }
    }
    const m = /^budget\b\s*(.*)$/i.exec(e.args.trim())
    if (!m) {
      const p = await read($, live)
      await $.ui.open({ id: PANE, title: 'Usage Radar', rows: panelRows(p, cfg), columns: PANE_COLUMNS })
      return { text: 'Usage Radar opened.' }
    }
    await syncSession($, cfg)
    const arg = parseBudgetArg(m[1] ?? '')
    if (arg === null) return { text: 'Usage Radar: /radar budget takes an amount in dollars (like 5 or 2.50), or off.' }
    if (arg === 'show') {
      const p = await read($, live)
      return {
        text: p.budget === null
          ? 'No budget for this session. Set one with /radar budget 5'
          : `Budget: ${budgetText(p)} (${Math.round((p.sessionCost / p.budget) * 100)}%)`,
      }
    }
    // levels already crossed count as warned: no toast for them now, the reply says so
    const before = (await read($, live)).budget
    const p = await update($, live, q => withBudgetSet(q, arg === 'off' ? null : arg))
    await save($)
    // the budget bar came or went under the cost tile: an open panel takes its new height
    if ((before === null) !== (p.budget === null)) await resizeIfOpen($, p, cfg)
    if (arg === 'off') return { text: 'Budget off for this session.' }
    const past = p.budgetFired > 0 ? ` · already past ${p.budgetFired}%` : ''
    return { text: `Budget set: ${dollars(arg)} for this session · ${money(totalCost(p))} spent so far${past}` }
  })

  // ── You press Enter: start a new job (unless helpers are still working) ─
  on('prompt.submit', async ($, e, next) => {
    // an open panel takes the rows this prompt brings (the name, the Context meter) at once, below
    const before = await read($, live)
    await syncSession($, cfg)
    // the spend limit: checked now (at most once a minute), and from here on if it wasn't yet
    if (!spendTimer) startSpend($, cfg)
    else void refreshSpend($, cfg)
    // the first prompt you type names the session (unless it has a name already)
    if (!(await read($, live)).name) {
      const n = await nameFrom($, e)
      if (n) {
        await update($, live, p => withName(p, n.name, n.kind))
        await save($)
      }
    }

    // slash commands like /radar don't start a new job
    if (e.command) {
      await resizeIfChanged($, before, await read($, live), cfg)
      return next(e)
    }
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const cost = usage.cost?.usd ?? null
    const window = usage.context.window || 200_000

    let alerts: string[] = []
    const p = await update($, live, p => {
      const q = withLedger(p, cost)
      const job = anyRunning(q)
        ? withAgent({ ...withNow(q, now), isRunning: true }, 'main', a => ({ ...a, isRunning: true, thisJob: true }))
        : newJob(q, now, cost, window)
      // from idle: the time since the last reading (you thinking, typing) isn't working time,
      // nor what a limit rose meanwhile; the forecast's clock picks up from here
      const base = isIdle(q) ? { ...job, pace: { ...job.pace, wall: null } } : job
      const r = withUsage(base, usage.rateLimits, usage.context.percent, now)
      alerts = r.alerts
      return r.next
    })
    $.ui.status(statusLine(p))
    for (const a of alerts) $.ui.toast(a)
    await resizeIfChanged($, before, p, cfg)

    // the clock: ticks until the whole job is done
    startTicker($)

    return next(e)
  }).catch(($, e, next) => next(e)) // if this mod breaks, your prompt still goes through

  // ── An agent starts working (main loop or a helper) ─────────────────────
  on('turn.start', async ($, e, next) => {
    const id = e.agentId ?? 'main'
    const now = await $.clock.now()
    const name = (e.agentId && (await agentName($, e.agentId))) || (id === 'main' ? 'Main' : 'Helper')
    const after = await update($, live, p =>
      // a job that had ended (a background helper carries on) or stood idle: the gap doesn't count
      withAgent({ ...withWorking(withNow(p, now), id, now), isRunning: true }, id, a => {
        const goingOn = a.isRunning && a.endedAt === null && a.startedAt
        return {
          ...a,
          name,
          isRunning: true,
          startedAt: goingOn ? a.startedAt : now,
          endedAt: null,
          pausedAt: null,
          pausedMs: goingOn ? a.pausedMs : 0,
          thisJob: true,
        }
      }),
    )
    // the clock ticks again, even if the job had ended
    startTicker($)

    // a helper appeared → show the panel, tall enough for every agent
    if (e.agentId) {
      void $.ui.open({ id: PANE, title: 'Usage Radar', rows: panelRows(after, cfg), columns: PANE_COLUMNS })
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
      const now = await $.clock.now()
      const fresh = freshTokens(u)
      let alerts: string[] = []
      // the first request brings the last request row (and a reading may bring meters): an open panel takes them
      const before = await read($, live)
      const p = await update($, live, p => {
        const counted = withWorking(withLedger({ ...p, window: usage.context.window || p.window }, usage.cost?.usd ?? null), id, now)
        const base = withAgent(
          { ...counted, jobTokens: counted.jobTokens + fresh, sessionTokens: counted.sessionTokens + fresh },
          id,
          a => ({
            ...a,
            name: name ?? a.name,
            model: u.model,
            context: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
            units: a.units + unitsOf(u),
            tokens: a.tokens + fresh,
          }),
        )
        const r = withUsage(base, usage.rateLimits, id === 'main' ? usage.context.percent : undefined, now)
        alerts = r.alerts
        return r.next
      })
      $.ui.status(statusLine(p))
      for (const a of alerts) $.ui.toast(a)
      await resizeIfChanged($, before, p, cfg)
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

    let wasRunning = false
    let alerts: string[] = []
    const p = await update($, live, p => {
      wasRunning = p.isRunning
      alerts = []
      // the last reading of this turn: limits (and the forecast) and the cost, before it ends
      const r = withUsage(withLedger(withNow(p, now), usage.cost?.usd ?? null), usage.rateLimits, undefined, now)
      const q = r.next
      // an agent already finished (the engine listed it so) keeps its frozen numbers; a helper
      // without a row (folded away, or never seen) is only counted, it gets no row
      const known = id === 'main' || q.agents.some(a => a.id === id)
      const after = known
        ? withAgent(q, id, a => (a.isRunning ? finished(q, a) : { ...a, endedAt: a.endedAt ?? now }))
        : withHelper(q, id)
      const b = withBudget({ ...after, isRunning: anyRunning(after), current: anyRunning(after) ? after.current : null })
      alerts = [...r.alerts, ...b.alerts]
      return b.next
    })
    $.ui.status(statusLine(p))
    for (const a of alerts) $.ui.toast(a)

    // everyone is done → stop the clock and celebrate (once: the poll may have ended the job already)
    if (!p.isRunning) {
      if (wasRunning) await finishJob($, p, e.isAborted)
      else {
        stopTicker()
        await save($)
      }
    }
    return next(e)
  })

  // ── The engine measured the session (after a turn, or a limit moved a whole point) ─
  // Limits pushed from here feed the meters and the forecast too, between our own readings
  on('session.measure', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const before = await read($, live)
      let alerts: string[] = []
      const p = await update($, live, p => {
        alerts = []
        const r = withUsage(p, e.rateLimits, e.context.percent, now)
        alerts = r.alerts
        return r.next
      })
      $.ui.status(statusLine(p))
      for (const a of alerts) $.ui.toast(a)
      // a meter came or went (the 5h or weekly limit): an open panel takes its new height
      await resizeIfChanged($, before, p, cfg)
      void refreshSpend($, cfg)
    } catch {
      // ignore: the next reading catches up
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ════════════════════════════════════════════════════════════════════════
  // 5. DRAWING
  // ════════════════════════════════════════════════════════════════════════

  // ── Band above the prompt: the "Usage Radar" card ────────────────────
  // Three lines: the header (with the account and the name), what's going on, and the meters
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, live)
    const m = main(p)
    if (e.props.hasSurvey || !m) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(30, e.props.bodyColumns - 4)

    // the to-do list, if Claude has one: "1/2 tasks", and the task on the go (unless the activity shows it)
    const done = p.todos.filter(t => t.status === 'completed').length
    const active = p.todos.find(t => t.status === 'in_progress')
    const doing = activity(p)
    const task = active ? active.activeForm || active.content : ''
    const tasks = p.todos.length
      ? `  ·  ${done}/${p.todos.length} tasks${task && !doing.includes(task) ? `  ·  ${task}` : ''}`
      : ''

    const working = helpers(p).filter(a => a.isRunning).length
    const all = jobHelpers(p).length
    const helperWord = all === 1 ? 'helper' : 'helpers'
    const crew = all ? `  ·  ${working ? `${working} of ${all} ${helperWord} working` : `${all} ${helperWord} done`}` : ''

    // the budget colours the cost (green, amber past 80%, red past 100%) and, past 80%, the border
    const lvl = p.budget === null ? 0 : budgetLevel(p.sessionCost, p.budget)
    const border = lvl >= 100 ? RED : lvl >= 80 ? AMBER : p.isRunning ? ORANGE : 'subtle'

    // line 1: the header; the badge, then the name (when shown), then the dim private-mode hint get
    // what's left of it, or go (the hint whole or not at all)
    const model = m.model ? prettyModel(m.model) : '…'
    const cost = p.budget === null ? money(totalCost(p)) : budgetText(p)
    // when it doesn't fit, it drops the word "tokens", then the clock, then the model; never the
    // cost or the title, so at the 30-column floor a long budget cost can still run past the band
    const headerAt = (drop: number): string[] =>
      [
        '◉ Usage Radar',
        drop < 3 ? `✳ ${model}` : '',
        `# ${k(p.sessionTokens)}${drop < 1 ? ' tokens' : ''}`,
        cost,
        drop < 2 ? `⏱ ${sessionClock(p)}` : '',
      ].filter(Boolean)
    let drop = 0
    while (drop < 3 && headerAt(drop).join('   ').length > width) drop++
    let room = width - headerAt(drop).join('   ').length - 3
    const badge = badgeFor(p, cfg)
    const badgeText = badge && room >= 6 ? fit(badge.text, room) : null
    if (badgeText !== null) room -= badgeText.length + 3
    const shownName = nameShown(p, cfg)
    const name = shownName && room >= 6 ? fit(shownName, Math.min(28, room)) : null
    const used =
      headerAt(drop).join('   ').length + (badgeText !== null ? 3 + badgeText.length : 0) + (name !== null ? 3 + name.length : 0)
    const hint = !!badge?.hasEmail && badgeText === badge.text && used + 1 + HINT.length <= width

    // line 2: what's going on, then the steps, helpers, tasks and the last request (dim, once there is one)
    const doingText = fit(doing, Math.max(10, width - 40))
    const last = hasRequest(p) ? `  ·  ${lastRequest(p)}` : ''
    const tail = fit(`  ·  ${plural(p.sessionSteps, 'step')}${crew}${tasks}${last}`, Math.max(0, width - 2 - doingText.length))

    // line 3: the meters that fit
    const shown = bandMeters(p, width)

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
        <Box flexDirection="row" gap={3}>
          <Text color={ORANGE} bold>
            ◉ Usage Radar
          </Text>
          {drop < 3 && (
            <Text>
              <Text color={ORANGE}>✳ </Text>
              <Text bold>{model}</Text>
            </Text>
          )}
          <Text>
            <Text dimColor># </Text>
            <Text bold>{k(p.sessionTokens)}</Text>
            {drop < 1 && <Text dimColor> tokens</Text>}
          </Text>
          <Text>
            <Text color={p.budget === null ? AMBER : budgetColor(lvl)} bold>
              {cost}
            </Text>
          </Text>
          {drop < 2 && (
            <Text>
              <Text dimColor>⏱ </Text>
              <Text bold>{sessionClock(p)}</Text>
            </Text>
          )}
          {badge && badgeText !== null && !hint && (
            <Text bold={!!badge.color} color={badge.color} dimColor={!badge.color}>
              {badgeText}
            </Text>
          )}
          {badge && badgeText !== null && hint && (
            <Text>
              <Text bold={!!badge.color} color={badge.color} dimColor={!badge.color}>
                {badgeText}
              </Text>
              <Text dimColor>{` ${HINT}`}</Text>
            </Text>
          )}
          {name !== null && <Text bold>{name}</Text>}
        </Box>
        <Text>
          <Text color={p.isRunning ? ORANGE : GREEN}>{p.isRunning ? spinner(p.now) : '✓'} </Text>
          <Text>{doingText}</Text>
          <Text dimColor>{tail}</Text>
        </Text>
        {shown.length > 0 && (
          <Box flexDirection="row" gap={3}>
            {shown.map(m => {
              // the spend limit with its dollars: what's left (or over), no bar
              const l = m.spend ? spendLeft(m.spend) : null
              if (l) {
                return (
                  <Text key={m.key}>
                    <Text dimColor>{m.label} </Text>
                    <Text bold color={m.pct >= WARN ? levelColor(m.pct) : undefined}>
                      {l.text}
                    </Text>
                    <Text dimColor>{` ${l.title.toLowerCase()} `}</Text>
                    <Text bold color={m.pct >= WARN ? levelColor(m.pct) : undefined}>
                      {levelText(m.pct)}
                    </Text>
                    {m.left !== null && <Text dimColor>{paceText(m)}</Text>}
                  </Text>
                )
              }
              const g = bar(m.pct / 100, BAND_BAR)
              return (
                <Text key={m.key}>
                  <Text dimColor>{m.label} </Text>
                  <Text color={levelColor(m.pct)}>{g.filled}</Text>
                  <Text dimColor>{g.empty}</Text>
                  <Text bold color={m.pct >= WARN ? levelColor(m.pct) : undefined}>
                    {' '}
                    {Math.round(m.pct)}%
                  </Text>
                  {m.pct >= WARN && <Text color={levelColor(m.pct)}> {glyph(m.pct)}</Text>}
                  {m.left !== null && <Text dimColor>{paceText(m)}</Text>}
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

    // a tile: its title, its value, and a small bar under it when given one
    const tile = (key: string, title: string, value: string, color?: string, meter?: { fraction: number; color: string }) => {
      const g = meter ? bar(meter.fraction, 10) : null
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1} flexGrow={1}>
          <Text dimColor>{title}</Text>
          <Text bold color={color}>
            {value}
          </Text>
          {meter && g && (
            <Text>
              <Text color={meter.color}>{g.filled}</Text>
              <Text dimColor>{g.empty}</Text>
            </Text>
          )}
        </Box>
      )
    }

    const working = helpers(p).filter(a => a.isRunning).length
    const m = main(p)
    const rows = helperRows(p)
    const more = earlierLine(p)
    const badge = badgeFor(p, cfg)
    // the dim private-mode hint after a shown email, only when all of it fits on the badge's line
    const hint = !!badge?.hasEmail && badge.text.length + 1 + HINT.length <= width
    const name = nameShown(p, cfg)
    const lvl = p.budget === null ? 0 : budgetLevel(p.sessionCost, p.budget)
    // what's left of the spend limit gets its own tile, when the panel is wide enough for four
    const left = p.spend && width >= 48 ? spendLeft(p.spend) : null

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {badge && !hint && (
            <Text bold={!!badge.color} color={badge.color} dimColor={!badge.color}>
              {fit(badge.text, width)}
            </Text>
          )}
          {badge && hint && (
            <Text>
              <Text bold={!!badge.color} color={badge.color} dimColor={!badge.color}>
                {badge.text}
              </Text>
              <Text dimColor>{` ${HINT}`}</Text>
            </Text>
          )}
          {name ? <Text bold>{fit(name, width)}</Text> : null}
          <Box flexDirection="row" gap={1}>
            {p.budget === null
              ? tile('cost', 'Cost', money(totalCost(p)), AMBER)
              : tile('cost', 'Cost', budgetText(p), budgetColor(lvl), { fraction: p.sessionCost / p.budget, color: budgetColor(lvl) })}
            {tile('tokens', 'Tokens', k(p.sessionTokens))}
            {tile('time', 'Time', sessionClock(p), p.isRunning ? ORANGE : undefined)}
            {p.spend && left && tile('left', left.title, left.text, levelColor(p.spend.pct))}
          </Box>
          {hasRequest(p) && <Text dimColor>{fit(lastRequest(p), width)}</Text>}
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
              const level = levelText(m.pct)
              const pace = m.left !== null ? ` · ${leftText(m.left)} at this pace` : ''
              // the dollars get what's left of the line after the label, the forecast and the percent:
              // "$87.60 left" (or "$3.50 over"), and "$12.40 of $100 used" on a line of its own
              const room = width - m.label.length - 2 - pace.length - level.length - 1
              const l = m.spend ? spendLeft(m.spend) : null
              const word = l ? ` ${l.title.toLowerCase()}` : ''
              return (
                <Box key={`limit-${m.key}`} flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between">
                    <Text>
                      {m.label}
                      {l && room >= l.text.length + word.length && (
                        <Text>
                          {'  '}
                          <Text bold>{l.text}</Text>
                          <Text dimColor>{word}</Text>
                        </Text>
                      )}
                      {l && room > 1 && room < l.text.length + word.length && <Text bold>{'  ' + fit(l.text + word, room)}</Text>}
                      {pace !== '' && <Text dimColor>{pace}</Text>}
                    </Text>
                    <Text bold color={levelColor(m.pct)}>
                      {level}
                    </Text>
                  </Box>
                  {m.spend && <Text dimColor>{fit(spendUsed(m.spend), width)}</Text>}
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

        {[...(m ? [m] : []), ...rows.shown].map(a => {
          // main's row: the session's totals minus its helpers'; a helper's: its own (frozen once done)
          const isMain = a.id === 'main'
          const isPaused = a.isRunning && a.pausedAt !== null
          const isDim = !isMain && !a.isRunning
          const b = bar(a.context / p.window, barWidth)
          const took = isMain ? sessionClock(p) : clock(agentMs(p, a))
          const tokens = isMain ? mainTokens(p) : a.tokens
          const cost = isMain ? mainCost(p) : agentCost(p, a)
          const icon = isPaused ? '⏸ ' : a.isRunning ? `${spinner(p.now)} ` : '✓ '
          return (
            <Box key={a.id} flexDirection="column">
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text color={isPaused ? AMBER : a.isRunning ? ORANGE : GREEN} dimColor={isDim}>{icon}</Text>
                  <Text bold={!isDim} dimColor={isDim}>{fit(a.name, Math.max(6, width - 26))}</Text>
                  <Text dimColor>{'  '}{a.model ? prettyModel(a.model) : '…'}</Text>
                </Text>
                <Text bold={!isDim} color={isDim ? undefined : AMBER} dimColor={isDim}>
                  {money(cost)}
                </Text>
              </Box>
              <Text>
                <Text color={a.isRunning ? ORANGE : GREEN} dimColor={isDim}>{b.filled}</Text>
                <Text dimColor>{b.empty}</Text>
                <Text dimColor>{`  ${k(tokens)} · ${took}${isPaused ? ' · idle' : ''}`}</Text>
              </Text>
            </Box>
          )
        })}
        {more !== null && <Text dimColor>{more}</Text>}

        {totalCost(p) !== null && <Text dimColor>{`Session total ${money(totalCost(p))}`}</Text>}
      </Box>
    )
  })
}
