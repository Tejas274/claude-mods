/** One line per tool on the receipt */
export type ToolLine = { tool: string; calls: number; ms: number; tokens: number; failed: number }

/** One line per agent (main + helpers) */
export type AgentLine = {
  id: string
  name: string
  model: string
  startedAt: number
  endedAt: number | null
  isRunning: boolean
  /** weighted usage, to split the job's cost between agents */
  units: number
  tokens: number
}

/** A single notable step: the slowest one, the biggest read */
export type Step = { label: string; ms: number; tokens: number }

export type Receipt = {
  number: number
  prompt: string
  startedAt: number
  endedAt: number | null
  isRunning: boolean
  costStart: number | null
  costEnd: number | null
  steps: number
  agents: AgentLine[]
  tools: ToolLine[]
  slowest: Step | null
  biggest: Step | null
  files: string[]
  cacheRead: number
  inputTotal: number
}

declare module 'claude-code' {
  interface PluginState {
    'turn-receipt': { current: Receipt | null; count: number }
  }
}
