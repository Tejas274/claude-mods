import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentLine, Receipt, Step, ToolLine } from '../types'

// ════════════════════════════════════════════════════════════════════════════
// 1. STATE: the receipt being "printed" right now (and how many we've printed)
// ════════════════════════════════════════════════════════════════════════════
const current = atom({ plugin: 'turn-receipt', key: 'current' } as const, null)
const count = atom({ plugin: 'turn-receipt', key: 'count' } as const, 0)

const PANE = 'turn-receipt'
const WIDTH = 44 // characters, like a till roll

const INK = '#E8803A' // orange: title, headers, highlights
const AMBER = '#F2B36B' // money
const GREEN = '#7BC88F'
const RED = '#E5616B'

// ════════════════════════════════════════════════════════════════════════════
// 2. HELPERS: plain functions, data → text (no `$` in here)
// ════════════════════════════════════════════════════════════════════════════
const prettyModel = (id: string): string => {
  const parts = id.replace(/^claude-/, '').split('-').filter(p => !/^\d{8}$/.test(p))
  const name = parts.filter(p => !/^\d+$/.test(p)).join(' ')
  const version = parts.filter(p => /^\d+$/.test(p)).join('.')
  return [name.replace(/\b\w/g, c => c.toUpperCase()), version].filter(Boolean).join(' ') || id
}

const k = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`

const money = (usd: number | null): string => (usd === null ? '—' : `$${usd.toFixed(2)}`)

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const fit = (text: string, max: number): string =>
  text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const stamp = (ms: number): string => {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} · ${hh}:${mm}`
}

// Cost "units": output costs 5× input, cache reads 0.1×, cache writes 1.25×, scaled by model price
const modelWeight = (model: string): number => (/haiku/i.test(model) ? 1 : /sonnet/i.test(model) ? 3 : 5)
type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}
const unitsOf = (u: Usage): number =>
  modelWeight(u.model) *
  (u.input_tokens + 5 * u.output_tokens + 0.1 * u.cache_read_input_tokens + 1.25 * u.cache_creation_input_tokens)

const jobCost = (r: Receipt): number | null =>
  r.costStart === null || r.costEnd === null ? null : Math.max(0, r.costEnd - r.costStart)

const agentCost = (r: Receipt, a: AgentLine): number | null => {
  const total = r.agents.reduce((s, x) => s + x.units, 0)
  const cost = jobCost(r)
  return cost === null || total === 0 ? null : (cost * a.units) / total
}

const cacheHit = (r: Receipt): number | null => (r.inputTotal > 0 ? r.cacheRead / r.inputTotal : null)

// What a tool call was about, e.g. "Bash: npm test", "Read: src/app.ts"
const describe = (e: { tool: string } & Record<string, unknown>): string => {
  const s = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : '')
  if (e.tool === 'Bash') return `Bash: ${s('command')}`
  if (s('file_path')) return `${e.tool}: ${s('file_path').split('/').slice(-2).join('/')}`
  if (s('pattern')) return `${e.tool}: ${s('pattern')}`
  if (s('url')) return `${e.tool}: ${s('url')}`
  if (s('description')) return `${e.tool}: ${s('description')}`
  return e.tool
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Bookkeeping tools: launching helpers, helpers reporting back, to-do lists, tool lookup.
// They're not "work", so they never count as the slowest step or the biggest read.
const META_TOOLS = new Set(['Agent', 'Task', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'ToolSearch'])
// Claude Code's internal "helper reports back" step: hidden from the receipt entirely
const HIDDEN_TOOLS = new Set(['SubagentHandback'])

const newReceipt = (number: number, prompt: string, now: number, cost: number | null): Receipt => ({
  number,
  prompt,
  startedAt: now,
  endedAt: null,
  isRunning: true,
  costStart: cost,
  costEnd: cost,
  steps: 0,
  agents: [],
  tools: [],
  slowest: null,
  biggest: null,
  files: [],
  cacheRead: 0,
  inputTotal: 0,
})

const withAgent = (r: Receipt, id: string, now: number, change: (a: AgentLine) => AgentLine): Receipt => {
  const known = r.agents.find(a => a.id === id)
  const base: AgentLine = known ?? {
    id,
    name: id === 'main' ? 'Main' : 'Helper',
    model: '',
    startedAt: now,
    endedAt: null,
    isRunning: true,
    units: 0,
    tokens: 0,
  }
  const next = change(base)
  const agents = known ? r.agents.map(a => (a.id === id ? next : a)) : [...r.agents, next]
  return { ...r, agents: [...agents.filter(a => a.id === 'main'), ...agents.filter(a => a.id !== 'main')] }
}

const withTool = (r: Receipt, tool: string, ms: number, tokens: number, failed: boolean): Receipt => {
  const known = r.tools.find(t => t.tool === tool)
  const line: ToolLine = known ?? { tool, calls: 0, ms: 0, tokens: 0, failed: 0 }
  const next = { ...line, calls: line.calls + 1, ms: line.ms + ms, tokens: line.tokens + tokens, failed: line.failed + (failed ? 1 : 0) }
  return { ...r, tools: known ? r.tools.map(t => (t.tool === tool ? next : t)) : [...r.tools, next] }
}

// ── The receipt, as coloured pieces (the panel draws them; /receipt copy copies the plain text) ──
type Tone = 'title' | 'head' | 'text' | 'dim' | 'rule' | 'money' | 'good' | 'bad' | 'total' | 'ink'
type Seg = { text: string; tone: Tone }
type Line = Seg[]

const plain = (l: Line): string => l.map(s => s.text).join('')

const rule = (ch = '─'): Line => [{ text: ch.repeat(WIDTH), tone: 'rule' }]
const center = (text: string, tone: Tone): Line => [
  { text: ' '.repeat(Math.max(0, Math.floor((WIDTH - text.length) / 2))) + text, tone },
]
// label on the left, value on the right, padded to the receipt width
const row = (label: string, labelTone: Tone, right: string, rightTone: Tone): Line => {
  const room = WIDTH - right.length - 1
  return [
    { text: fit(label, room).padEnd(room) + ' ', tone: labelTone },
    { text: right, tone: rightTone },
  ]
}

const AGENT_W = WIDTH - 16
const TOOL_W = WIDTH - 22

const receiptLines = (r: Receipt, now: number): Line[] => {
  const end = r.endedAt ?? now
  const lines: Line[] = []

  lines.push(center('🧾  CLAUDE CODE RECEIPT', 'title'))
  lines.push(center(`#${String(r.number).padStart(4, '0')} · ${stamp(r.startedAt)}`, 'dim'))
  lines.push(rule('═'))
  lines.push([{ text: fit(`“${r.prompt}”`, WIDTH), tone: 'text' }])
  lines.push(rule())

  // Agents: name bright, model faint, time normal, cost amber
  lines.push([{ text: 'AGENTS'.padEnd(AGENT_W) + 'time'.padStart(7) + 'cost'.padStart(9), tone: 'head' }])
  for (const a of r.agents) {
    const model = a.model ? ` · ${prettyModel(a.model)}` : ''
    const label = fit(`${a.name}${model}`, AGENT_W)
    const nameLen = Math.min(a.name.length, label.length)
    const cost = agentCost(r, a)
    lines.push([
      { text: label.slice(0, nameLen), tone: 'text' },
      { text: label.slice(nameLen).padEnd(AGENT_W - nameLen), tone: 'dim' },
      { text: clock((a.endedAt ?? now) - a.startedAt).padStart(7), tone: 'text' },
      { text: (cost === null ? `${k(a.tokens)}t` : `≈${money(cost)}`).padStart(9), tone: 'money' },
    ])
  }
  if (r.agents.length === 0) lines.push([{ text: 'No agents yet', tone: 'dim' }])
  lines.push(rule())

  // Tools, most time first; failures in red
  lines.push([
    { text: 'TOOLS'.padEnd(TOOL_W) + 'calls'.padStart(6) + 'time'.padStart(7) + '~tokens'.padStart(9), tone: 'head' },
  ])
  for (const t of [...r.tools].sort((a, b) => b.ms - a.ms)) {
    const fail = t.failed ? ` (${t.failed}✗)` : ''
    lines.push([
      { text: fit(t.tool, TOOL_W - fail.length), tone: 'text' },
      { text: fail.padEnd(TOOL_W - fit(t.tool, TOOL_W - fail.length).length), tone: 'bad' },
      { text: String(t.calls).padStart(6), tone: 'text' },
      { text: clock(t.ms).padStart(7), tone: 'text' },
      { text: k(t.tokens).padStart(9), tone: 'dim' },
    ])
  }
  if (r.tools.length === 0) lines.push([{ text: 'No tools used', tone: 'dim' }])
  lines.push(rule())

  // Highlights
  if (r.slowest) lines.push(row(`🐢 Slowest  ${r.slowest.label}`, 'text', clock(r.slowest.ms), 'ink'))
  if (r.biggest) lines.push(row(`🐘 Biggest  ${r.biggest.label}`, 'text', `${k(r.biggest.tokens)} tok`, 'ink'))
  lines.push(row('✏️  Files changed', 'text', String(r.files.length), r.files.length ? 'good' : 'dim'))
  for (const f of r.files.slice(0, 5)) lines.push([{ text: `     ${fit(f.split('/').slice(-2).join('/'), WIDTH - 5)}`, tone: 'dim' }])
  if (r.files.length > 5) lines.push([{ text: `     +${r.files.length - 5} more`, tone: 'dim' }])
  const hit = cacheHit(r)
  if (hit !== null) lines.push(row('♻️  Cache hit', 'text', `${Math.round(hit * 100)}%`, hit >= 0.5 ? 'good' : 'ink'))
  lines.push(rule('═'))

  // Total
  const cost = jobCost(r)
  lines.push(row(`TOTAL  ${clock(end - r.startedAt)} · ${r.steps} step${r.steps === 1 ? '' : 's'}`, 'total', cost === null ? '' : `≈${money(cost)}`, 'money'))
  lines.push(rule('═'))
  lines.push(center(r.isRunning ? '… still printing …' : 'Thank you for coding with Claude!', r.isRunning ? 'ink' : 'text'))
  lines.push(center('turn-receipt · /receipt copy to share', 'dim'))
  return lines
}

// ════════════════════════════════════════════════════════════════════════════
// 3. HOOKS
// ════════════════════════════════════════════════════════════════════════════
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'receipt', description: 'Show the receipt of the last job (/receipt copy to copy it)' })
    return next(e)
  })

  // /receipt → open it · /receipt copy → copy it as text
  on('command.run', { command: 'receipt' }, async ($, e) => {
    const r = await read($, current)
    if (!r) return { text: 'No receipt yet. Send Claude a prompt first.' }
    if (e.args.trim() === 'copy') {
      const now = await $.clock.now()
      const text = receiptLines(r, now).map(plain).join('\n')
      await $.ui.copy({ text })
      return { text: `Receipt #${r.number} copied. Paste it anywhere.` }
    }
    await $.ui.open({ id: PANE, title: 'Receipt', rows: 34, columns: WIDTH + 4 })
    return { text: `Receipt #${r.number} opened.` }
  })

  // You send a prompt: start a new receipt (unless helpers from the last one are still working)
  on('prompt.submit', async ($, e, next) => {
    if (e.command) return next(e) // slash commands like /receipt don't start a job
    const r = await read($, current)
    const busy = r?.agents.some(a => a.isRunning) ?? false
    if (!busy) {
      const now = await $.clock.now()
      const usage = await $.session.usage()
      const n = await update($, count, c => c + 1)
      const prompt = e.text.replace(/\s+/g, ' ').trim()
      await update($, current, () => newReceipt(n, prompt, now, usage.cost?.usd ?? null))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // An agent starts
  on('turn.start', async ($, e, next) => {
    const id = e.agentId ?? 'main'
    const now = await $.clock.now()
    let name = id === 'main' ? 'Main' : 'Helper'
    if (e.agentId) {
      const info = (await $.agent.list()).find(a => a.id === e.agentId)
      if (info) name = info.description || info.type
    }
    await update($, current, r =>
      r ? withAgent({ ...r, isRunning: true }, id, now, a => ({ ...a, name, isRunning: true, endedAt: null })) : r,
    )
    return next(e)
  })

  // Every model request: model, cost share, cache hits
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const u = result.usage
    if (u) {
      const id = e.agentId ?? 'main'
      const now = await $.clock.now()
      const usage = await $.session.usage()
      await update($, current, r => {
        if (!r) return r
        const withUse = withAgent(r, id, now, a => ({
          ...a,
          model: u.model,
          units: a.units + unitsOf(u),
          tokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens,
        }))
        return {
          ...withUse,
          costEnd: usage.cost?.usd ?? r.costEnd,
          cacheRead: r.cacheRead + u.cache_read_input_tokens,
          inputTotal: r.inputTotal + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        }
      })
    }
    return result
  })

  // Every tool call: time it, size its result, note slow and big ones
  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const ran = await next(e) // ← the real tool runs here
    const ms = (await $.clock.now()) - t0

    const input = e as unknown as { tool: string } & Record<string, unknown>
    const failed = ran.deny !== undefined || ran.isError === true
    const body = typeof ran.text === 'string' ? ran.text : JSON.stringify(ran.result ?? '')
    const tokens = Math.ceil((body?.length ?? 0) / 4) // ~4 characters per token
    const step: Step = { label: describe(input), ms, tokens }
    const path = input.file_path

    if (HIDDEN_TOOLS.has(e.tool)) return ran
    const isWork = !META_TOOLS.has(e.tool)

    await update($, current, r => {
      if (!r) return r
      const tallied = withTool({ ...r, steps: r.steps + 1 }, e.tool, ms, tokens, failed)
      return {
        ...tallied,
        slowest: isWork && (!r.slowest || ms > r.slowest.ms) ? step : r.slowest,
        biggest: isWork && (!r.biggest || tokens > r.biggest.tokens) ? step : r.biggest,
        files:
          !failed && EDIT_TOOLS.has(e.tool) && typeof path === 'string' && !r.files.includes(path)
            ? [...r.files, path]
            : r.files,
      }
    })
    return ran
  }).catch(($, e, next) => next(e)) // if this mod breaks, the tool still runs

  // An agent finishes. When everyone is done, the receipt is printed.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? 'main'
    const now = await $.clock.now()
    const usage = await $.session.usage()
    const r = await update($, current, r => {
      if (!r) return r
      const done = withAgent(r, id, now, a => ({ ...a, isRunning: false, endedAt: now }))
      const isRunning = done.agents.some(a => a.isRunning)
      return { ...done, isRunning, endedAt: isRunning ? null : now, costEnd: usage.cost?.usd ?? r.costEnd }
    })

    if (r && !r.isRunning && r.steps + r.agents.length > 0) {
      const cost = jobCost(r)
      const helpers = r.agents.length - 1
      $.ui.toast(
        `🧾 Receipt #${r.number} · ${clock(now - r.startedAt)} · ${r.steps} steps${helpers > 0 ? ` · ${helpers + 1} agents` : ''}${cost === null ? '' : ` · ≈${money(cost)}`}  →  /receipt`,
      )
    }
    return next(e)
  })

  // ════════════════════════════════════════════════════════════════════════
  // 4. DRAWING: the receipt panel
  // ════════════════════════════════════════════════════════════════════════
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const r = await read($, current)
    const { Box, Text } = $.ui.resolve(e)
    if (!r) return <Text dimColor>No receipt yet. Send Claude a prompt first.</Text>

    const now = await $.clock.now()
    const style = (tone: Tone) => {
      switch (tone) {
        case 'title': return { color: INK, bold: true }
        case 'head': return { color: INK, bold: true }
        case 'ink': return { color: INK, bold: true }
        case 'money': return { color: AMBER, bold: true }
        case 'good': return { color: GREEN, bold: true }
        case 'bad': return { color: RED, bold: true }
        case 'total': return { color: 'text', bold: true }
        case 'text': return { color: 'text' }
        case 'rule': return { color: 'subtle' }
        case 'dim': return { dimColor: true }
      }
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        {receiptLines(r, now).map((line, i) => (
          <Text key={`l${i}`}>
            {line.map((seg, j) => (
              <Text key={`s${j}`} {...style(seg.tone)}>
                {seg.text}
              </Text>
            ))}
          </Text>
        ))}
      </Box>
    )
  })
}
