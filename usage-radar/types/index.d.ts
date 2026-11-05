export type Todo = {
  id?: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

/** One agent: the main loop ("main") or a subagent */
export type Agent = {
  id: string
  name: string
  model: string
  isRunning: boolean
  /** tokens in its context on its latest request */
  context: number
  /** weighted usage this job, used to split the job's cost between agents */
  units: number
  /** new tokens this session (input + cache writes + output) */
  tokens: number
  /** its cost from earlier jobs, and its whole cost frozen when it finished (null: no reading yet) */
  priorCost: number
  cost: number | null
  /** working time of its earlier runs, in ms */
  workedMs: number
  /** the run it's on: when it started and ended */
  startedAt: number
  endedAt: number | null
  /** when $.agent.list() last said it went idle (or waiting), and the paused time of this run */
  pausedAt: number | null
  pausedMs: number
  /** it worked in this job (the job's toast and the band count these) */
  thisJob: boolean
  /** when $.agent.list() last listed it while running (null: not since it started); not saved */
  seenAt: number | null
}

/** A finished helper as kept in the session record */
export type SavedAgent = {
  id: string
  name: string
  model: string
  cost: number | null
  tokens: number
  ms: number
  endedAt: number
}

/** Helpers that no longer have a row: how many, and what they cost and used */
export type Earlier = { agents: number; cost: number; tokens: number }

/** How the session got its name: /rename, a ticket ID in the first prompt, or its first words */
export type NameKind = 'rename' | 'ticket' | 'words'

/** The signed-in account: read from the config file, never saved or drawn beyond the badge */
export type Account = { email: string | null; org: string | null }

/** The account's dollar spend limit, from Anthropic's usage endpoint (major units; never saved) */
export type Spend = { used: number; cap: number; currency: string; pct: number }

/**
 * One plan or spend limit's warning already shown, as shared under the store key `alerts`
 * ({ five_hour, seven_day, spend_limit }), so another terminal in the config dir doesn't warn
 * again: the level (80, 95, or 0 after a reset), the limit's reset time when known, and when it
 * was written. Never dollars, the account or the context.
 */
export type SharedAlert = { level: number; resetsAt?: string; at: number }

/** One forecast sample: working time (ms) and the % that rose while working, up to then */
export type Sample = { at: number; rise: number }

/** One limit's pace: last reading, its reset time, rise so far, recent samples */
export type Track = { pct: number; resetsAt?: string; rise: number; samples: Sample[] }

/** Working-time clock for forecasts; carried across session ids like limits */
export type Pace = { wall: number | null; active: number; kinds: Record<string, Track> }

/** What is kept in $.store per session (key `session:<id>`), so --resume continues the totals */
export type Saved = {
  v: 1
  updatedAt: number
  name: string | null
  nameKind: NameKind | null
  cost: number
  tokens: number
  ms: number
  steps: number
  helperIds: string[]
  /** the session's helpers, and the ones folded away (2.1.0 records have neither: read as none) */
  agents: SavedAgent[]
  earlier: Earlier
  /** the session's budget in USD: absent never set (the default applies), null turned off */
  budget?: number | null
  /** the highest budget warning already shown: 0, 80 or 100 (older records have none: 0) */
  budgetFired: number
}

/**
 * Everything the screen shows. A "job" = from your prompt until the main agent AND every
 * helper agent are done; job fields (steps, costUsd/baseCost, jobTokens, startedAt) start
 * over each job. Session fields (sessionId, name, sessionCost, sessionTokens, priorMs,
 * sessionSteps, helperIds, agents, earlier) add up over the whole session and are saved,
 * with the budget (budget, budgetFired); a session with nothing in it is not saved. Pace,
 * account and spend live only in memory; private mode lives in memory too, and under its own
 * store key (`private`: true or false); the plan and spend limits' warning levels too, under
 * `alerts` (see SharedAlert).
 */
export type Live = {
  isRunning: boolean
  startedAt: number
  now: number
  steps: number
  current: string | null
  /** the engine's cost ledger (L) at its latest reading, and what it was when this job began */
  costUsd: number | null
  baseCost: number
  window: number
  agents: Agent[]
  todos: Todo[]
  /** plan limits: five_hour, seven_day, or a gateway's spend_limit */
  limits: Limit[]
  /** main context fill, 0-100 */
  contextPct: number | null
  /** highest alert level already shown per meter (80 or 95), so each alert pops once; at start the
   *  plan and spend limits' levels another terminal shared (`alerts`) are taken */
  alerted: Record<string, number>
  /** the session these totals belong to (null until we know it) */
  sessionId: string | null
  /** the session's name: /rename, a ticket ID or the first words of the first prompt */
  name: string | null
  nameKind: NameKind | null
  /** what the whole session has cost, summed from ledger changes (saved) */
  sessionCost: number
  /** the ledger at the last reading, to work out the next change (not saved) */
  lastLedger: number | null
  /** new tokens this job (input + cache writes + output) */
  jobTokens: number
  /** new tokens this session */
  sessionTokens: number
  /** working time of the session's earlier jobs, in ms */
  priorMs: number
  /** tool calls this session */
  sessionSteps: number
  /** every helper agent seen this session, each counted once */
  helperIds: string[]
  /** finished helpers past the rows we keep, folded into one line */
  earlier: Earlier
  /** the session's cost budget in USD (null: none), and whether it was set for this session */
  budget: number | null
  budgetChosen: boolean
  /** the highest budget warning already shown: 0, 80 or 100 (saved) */
  budgetFired: number
  /** how fast each limit is filling while working, for the forecast (not saved) */
  pace: Pace
  /** the signed-in account, read at start and again once a minute (null until read; not saved) */
  account: Account | null
  /** the account's spend limit in dollars, read from Anthropic once a minute while working, every
   *  5 minutes while idle (null: none; not saved) */
  spend: Spend | null
  /** the spend reading is over 10 minutes old (checks failing or held back); not saved */
  spendStale: boolean
  /** /radar private: email and session name hidden (global, stored as one boolean, not per session) */
  private: boolean
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    // kept under a shape tag (Shaped, from this module), so state from older code reads as absent
    'usage-radar': { radar: Shaped<Live> }
  }
}
