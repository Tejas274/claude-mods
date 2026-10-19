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

/** A "job" = from your prompt until the main agent AND every helper agent are done */
export type Live = {
  isRunning: boolean
  startedAt: number
  now: number
  steps: number
  current: string | null
  /** session cost so far, and what it was when this job began */
  costUsd: number | null
  baseCost: number
  window: number
  agents: Agent[]
  todos: Todo[]
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': { job: Live }
  }
}
