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
  startedAt: number
  endedAt: number | null
}

/** How the session got its name: /rename, a ticket ID in the first prompt, or its first words */
export type NameKind = 'rename' | 'ticket' | 'words'

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
}

/**
 * Everything the screen shows. A "job" = from your prompt until the main agent AND every
 * helper agent are done; job fields (steps, agents, costUsd/baseCost, jobTokens, startedAt)
 * start over each job. Session fields (sessionId, name, sessionCost, sessionTokens, priorMs,
 * sessionSteps, helperIds) add up over the whole session and are saved.
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
  /** highest alert level already shown per meter (80 or 95), so each alert pops once */
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
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    // kept under a shape tag (Shaped, from this module), so state from older code reads as absent
    'usage-radar': { radar: Shaped<Live> }
  }
}
