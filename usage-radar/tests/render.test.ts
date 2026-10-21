import { expect, mock, test } from 'claude-code/testing'
import type { Engine, FoundElement } from 'claude-code/testing'

const usage = (input: number, output: number) => ({
  model: 'claude-opus-5-5',
  input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band and agents pane on ${surface}`, async ($, on) => {
    // what the engine would answer, beneath the mod
    const clock = mock.clock(on)
    mock.store(on)
    on('session.id', () => ({ value: 's1' }) as never)
    let nextUsage: unknown = null
    let cost = 0
    let fiveHour = 40
    on('session.usage', () => ({ value: {
      startedAt: 0,
      context: { window: 200_000, percent: 42 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(clock.now() + 2 * 3600_000).toISOString() },
        { kind: 'seven_day', percentUsed: 18 },
      ],
      cost: { usd: cost },
    } }) as never)
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'Explore codebase', type: 'Explore', status: 'running' }] }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.status', () => ({ value: undefined }) as never)
    const toasts: string[] = []
    on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } as never })
    on('prompt.submit', ($, e: any) => ({ text: e.text }) as never)
    on('turn.start', ($, e: any) => ({ turnId: e.turnId }) as never)
    on('turn.complete', () => ({ text: '' }) as never)
    on('tool.call', () => ({ result: {} }) as never)

    on('turn.step', async function* (_$: any, e: any) { return { turnId: e.turnId, index: e.index, usage: nextUsage, stopReason: 'end_turn', answer: '', toolUses: [] } } as never)
    await $.prompt.submit({ text: 'go' } as never)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)

    // main agent makes a request: 79k tokens
    cost = 0.12
    nextUsage = usage(70_000, 9_000)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) { }

    // a subagent starts and makes a request: 117k tokens
    await $.turn.start({ turnId: 't2', text: 'explore', agentId: 'a1' } as never)
    cost = 0.34
    fiveHour = 83
    nextUsage = usage(100_000, 17_000)
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' } as never)) { }

    await $.tool.call({ tool: 'TodoWrite', todos: [
      { content: 'A', status: 'completed', activeForm: 'Doing A' },
      { content: 'B', status: 'in_progress', activeForm: 'Writing tests' },
    ] } as never)

    // main finishes first while the helper still works: the job keeps going
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    // the 5-hour limit crossed 80% once → exactly one warning
    expect(toasts.filter(t => t.includes('5h limit 83% used')).length).toBe(1)
    const before = toasts.length

    const band = await $.ui.mount({
      plugin: 'usage-radar', surface, component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 } as never,
    })
    expect(await band.find({ type: 'Text', text: /Usage Radar/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /196k/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /≈\$0\.34/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /this request: ≈\$0\.34 · 196k/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /1\/2 tasks  ·  Writing tests/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /5h limit/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /83%/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Context/ })).toBeDefined()
    await band.unmount()

    const pane = await $.ui.mount({
      plugin: 'usage-radar', surface, component: 'Pane', requestId: 'radar-agents',
      props: { title: 'Agents', isFocused: false, bodyColumns: 60 } as never,
    })
    expect(await pane.find({ type: 'Text', text: /Explore codebase/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Explore · Explore codebase/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /196k/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /≈\$0\.13/ })).toBeDefined() // main's share
    expect(await pane.find({ type: 'Text', text: /≈\$0\.21/ })).toBeDefined() // subagent's share
    expect(await pane.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /resets in 2h 0m/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Weekly/ })).toBeDefined()
    await pane.unmount()

    // the helper finishes: now the whole job is done
    await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'a1' } as never)
    expect(toasts.length).toBe(before + 1)
    expect(toasts.at(-1)).toContain('✓ All done')
    expect(toasts.at(-1)).toContain('2 agents')
  })
}

// ════════════════════════════════════════════════════════════════════════════
// Session totals, saving, names: one mocked world beneath the mod
// ════════════════════════════════════════════════════════════════════════════
type Ui = {
  find: (q: { type?: string; text?: string | RegExp }) => Promise<FoundElement | undefined>
  findAll: (q: { type?: string; text?: string | RegExp }) => Promise<FoundElement[]>
  unmount: () => Promise<void>
}

const DAY = 24 * 60 * 60 * 1000

const world = (on: any, seed: Record<string, unknown> = {}, now = 0) => {
  const w = {
    store: new Map<string, unknown>(Object.entries(seed)),
    sid: 's1',
    cost: 0,
    agents: [] as Array<Record<string, unknown>>,
    toasts: [] as string[],
    next: null as unknown,
    clock: mock.clock(on, { now }),
    /** once: runs while the engine answers agent.list, or after session.usage has read the ledger */
    onList: null as null | (() => Promise<void>),
    onUsage: null as null | (() => Promise<void>),
    /** the rows the pane asked for, each time it opened */
    opened: [] as number[],
  }
  on('store.get', (_$: any, e: any) => ({ value: w.store.get(e.key) }) as never)
  on('store.set', (_$: any, e: any) => {
    w.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$: any, e: any) => {
    w.store.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...w.store.keys()] }) as never)
  on('session.id', () => ({ value: w.sid }) as never)
  on('session.usage', async () => {
    const value = { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: [], cost: { usd: w.cost } }
    const f = w.onUsage
    w.onUsage = null
    if (f) await f()
    return { value } as never
  })
  on('command.list', () => ({ value: [
    { name: 'model', description: 'Set the model', source: 'builtin' },
    { name: 'feature', description: 'Build a feature', source: 'user' },
  ] }) as never)
  on('agent.list', async () => {
    const f = w.onList
    w.onList = null
    if (f) await f()
    return { value: w.agents } as never
  })
  on('ui.open', (_$: any, e: any) => {
    if (typeof e.rows === 'number') w.opened.push(e.rows)
    return { value: { isPlaced: true } } as never
  })
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', (_$: any, e: any) => { w.toasts.push(e.text); return { value: undefined } as never })
  on('command.register', () => ({ value: { command: 'radar' } }) as never)
  on('command.run', () => ({ text: '' }) as never)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }) as never)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('classic.UserPromptSubmit', () => ({}) as never)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }) as never)
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, usage: w.next, stopReason: 'end_turn', answer: '', toolUses: [] }
  } as never)
  return w
}
type World = ReturnType<typeof world>

// What a session does, step by step
const prompt = ($: Engine, text: string, command?: { name: string; args: string }) =>
  $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(command && { command }) } as never)
const start = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.start({ turnId, text: 'go', ...(agentId && { agentId }) } as never)
const step = async ($: Engine, w: World, turnId: string, input: number, output: number, agentId?: string, cacheRead = 0) => {
  w.next = {
    model: 'claude-opus-5-5',
    input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
  }
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1, ...(agentId && { agentId }) } as never)) { }
}
const tool = ($: Engine) => $.tool.call({ tool: 'Bash', command: 'ls' } as never)
const complete = ($: Engine, turnId: string, agentId?: string, isAborted = false) =>
  $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted, reason: 'answer', ...(agentId && { agentId }) } as never)
const rename = ($: Engine, args: string) =>
  $.command.run({ command: 'rename', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

const pane = ($: Engine): Promise<Ui> => $.ui.mount({
  plugin: 'usage-radar', surface: 'terminal', component: 'Pane', requestId: 'radar-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 60 } as never,
})
const band = ($: Engine, bodyColumns = 100): Promise<Ui> => $.ui.mount({
  plugin: 'usage-radar', surface: 'terminal', component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns } as never,
})

// Mount, check that every pattern is drawn in some Text, unmount
const shows = async (mount: Promise<Ui>, ...patterns: RegExp[]) => {
  const ui = await mount
  for (const re of patterns) expect(await ui.find({ type: 'Text', text: re }), `drawn: ${re}`).toBeDefined()
  await ui.unmount()
}
const hidden = async (mount: Promise<Ui>, ...patterns: RegExp[]) => {
  const ui = await mount
  for (const re of patterns) expect(await ui.find({ type: 'Text', text: re }), `not drawn: ${re}`).toBeUndefined()
  await ui.unmount()
}
const exactly = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const record = (w: World, sid = w.sid) => w.store.get(`session:${sid}`) as Record<string, any> | undefined

// One main-only job: prompt, a step at the given ledger, done
const job = async ($: Engine, w: World, text: string, ledger: number, input = 1000, output = 0) => {
  await prompt($, text)
  await start($, 'm')
  w.cost = ledger
  await step($, w, 'm', input, output)
  await complete($, 'm')
}

test('three prompts add up to session totals', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  w.agents = [{ id: 'a1', description: 'Explore codebase', type: 'Explore', status: 'running' }]

  // job 1: main and a helper, one tool call, 5 s
  await prompt($, 'first job')
  await start($, 'm1')
  w.cost = 0.10
  await step($, w, 'm1', 30_000, 2_000)
  await start($, 'h1', 'a1')
  w.cost = 0.15
  await step($, w, 'h1', 10_000, 1_000, 'a1')
  await tool($)
  await w.clock.advance(5_000)
  await complete($, 'm1')
  await complete($, 'h1', 'a1')

  // job 2: cache reads don't count as new tokens; stopped after 3 s
  await prompt($, 'second job')
  await start($, 'm2')
  w.cost = 0.25
  await step($, w, 'm2', 40_000, 3_000, undefined, 100_000)
  await tool($)
  await tool($)
  await w.clock.advance(3_000)
  await complete($, 'm2', undefined, true)
  expect(w.toasts.at(-1)).toContain('■ Stopped')

  // a minute idle doesn't count as time
  await w.clock.advance(60_000)

  // job 3
  await prompt($, 'third job')
  await start($, 'm3')
  w.cost = 0.30
  await step($, w, 'm3', 50_000, 4_000)
  await w.clock.advance(2_000)
  await complete($, 'm3')

  const totals = [/^≈\$0\.30$/, /^140k$/, /^0:10$/, /3 steps/]
  await shows(pane($), ...totals, /Session total ≈\$0\.30/, /2 agents/, /this request: ≈\$0\.05 · 54k · 0:02 · 0 steps/)
  await shows(band($), ...totals, /this request: ≈\$0\.05 · 54k · 0:02 · 0 steps/)
})

test('a new session id starts at zero, and the old one comes back', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: 'Explore codebase', type: 'Explore', status: 'running' }]
  await prompt($, 'first job')
  await start($, 'm1')
  w.cost = 0.30
  await step($, w, 'm1', 100_000, 10_000)
  await start($, 'h1', 'a1')
  await step($, w, 'h1', 25_000, 5_000, 'a1')
  await complete($, 'm1')
  await complete($, 'h1', 'a1')
  await shows(pane($), /^≈\$0\.30$/, /^140k$/, /2 agents/)

  // /clear: a new id, a ledger that starts over
  w.sid = 's2'
  w.cost = 0
  await job($, w, 'after clear', 0.02, 5_000, 1_000)
  await shows(pane($), /^≈\$0\.02$/, /^6k$/, /1 agent\b/, /Session total ≈\$0\.02/)
  await hidden(pane($), /140k/)

  // back to s1 (resume), its ledger at 0 again
  w.sid = 's1'
  w.cost = 0
  await job($, w, 'resumed', 0.01, 1_000, 0)
  await shows(pane($), /^≈\$0\.31$/, /^141k$/, /2 agents/)
})

for (const ledgerAtLoad of [0, 1]) {
  test(`resume continues saved totals (ledger ${ledgerAtLoad} at load)`, async ($, on) => {
    const now = 400 * DAY
    const w = world(on, {
      'session:s1': {
        v: 1, updatedAt: now - DAY, name: 'MRKRR-142', nameKind: 'ticket',
        cost: 1, tokens: 500_000, ms: 600_000, steps: 40, helperIds: ['old1', 'old2'],
      },
    }, now)
    w.cost = ledgerAtLoad
    w.agents = [{ id: 'old1', description: 'Explore codebase', type: 'Explore', status: 'running' }]

    await prompt($, 'keep going')
    await start($, 'm')
    w.cost = ledgerAtLoad + 0.20
    await step($, w, 'm', 10_000, 1_000)
    await start($, 'h', 'old1')
    await tool($)
    await w.clock.advance(5_000)
    await complete($, 'h', 'old1')
    await complete($, 'm')

    const totals = [/^≈\$1\.20$/, /^511k$/, /^10:05$/, /41 steps/, /^MRKRR-142$/, /this request: ≈\$0\.20 · 11k · 0:05 · 1 step/]
    await shows(pane($), ...totals, /Session total ≈\$1\.20/, /3 agents/)
    await shows(band($), ...totals)
  })
}

for (const bad of ['garbage', { v: 1, cost: 'x' }]) {
  test(`a bad record (${JSON.stringify(bad)}) counts as missing`, async ($, on) => {
    const w = world(on, { 'session:s1': bad })
    await job($, w, 'hello there', 0.05)
    await shows(pane($), /^≈\$0\.05$/, /^1k$/)
    expect(record(w)).toMatchObject({ v: 1, cost: 0.05, tokens: 1000, steps: 0, helperIds: [] })
  })
}

test('totals are saved while working, at the end of a session and of a job', async ($, on) => {
  const w = world(on)
  await prompt($, 'go')
  await start($, 'm')
  expect(record(w)).toMatchObject({ name: 'go', tokens: 0 })

  // 1 s in: not saved yet (at most every 15 s)
  await w.clock.advance(1_000)
  await step($, w, 'm', 1_000, 0)
  expect(record(w)?.tokens).toBe(0)

  // 16 s in: saved
  await w.clock.advance(15_000)
  await step($, w, 'm', 2_000, 0)
  expect(record(w)?.tokens).toBe(3_000)

  // the session ends: saved right away
  await tool($)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(record(w)?.steps).toBe(1)

  // the job ends: saved with its time
  await w.clock.advance(4_000)
  await complete($, 'm')
  expect(record(w)?.ms).toBe(20_000)
})

test('sessions unused for 90 days are pruned, other keys kept', async ($, on) => {
  const now = 400 * DAY
  const saved = (age: number) => ({
    v: 1, updatedAt: now - age, name: null, nameKind: null, cost: 0, tokens: 0, ms: 0, steps: 0, helperIds: [],
  })
  const w = world(on, {
    'session:old1': saved(100 * DAY),
    'session:old2': saved(91 * DAY),
    'session:recent1': saved(10 * DAY),
    'session:recent2': saved(89 * DAY),
    'session:bad': 'garbage',
    other: 'keep me',
  }, now)
  w.sid = 'new'
  await job($, w, 'hello', 0.01)
  expect([...w.store.keys()].sort()).toEqual(['other', 'session:new', 'session:recent1', 'session:recent2'])
  expect(w.store.get('other')).toBe('keep me')
})

test('each helper is counted once per session', async ($, on) => {
  const w = world(on)
  w.agents = Array.from({ length: 9 }, (_, i) => ({ id: `a${i + 1}`, description: `task ${i + 1}`, type: 'Explore', status: 'running' }))
  await prompt($, 'many helpers')
  await start($, 'm')
  for (let i = 1; i <= 9; i++) {
    await start($, `h${i}`, `a${i}`)
    await step($, w, `h${i}`, 1_000, 0, `a${i}`)
  }
  // nine running helpers: eight rows, and a1 (the first) is still on screen after another step
  await step($, w, 'h1', 1_000, 0, 'a1')
  await shows(pane($), /10 agents/, /^Explore · task 1$/)

  for (let i = 1; i <= 9; i++) await complete($, `h${i}`, `a${i}`)
  await complete($, 'm')

  // next job: a late finish from a9 doesn't count it again
  await prompt($, 'next')
  await start($, 'm')
  await complete($, 'h9', 'a9')
  await shows(pane($), /10 agents/)
  // ... nor gives it a nameless row; the one folded away (a1, an equal end time) stays folded
  await hidden(pane($), /^Helper$/, /^Explore · task 1$/)
  await shows(pane($), /^Explore · task 9$/, /^\+1 earlier agent · /)
  const toasts = w.toasts.length
  await complete($, 'h1', 'a1')
  await hidden(pane($), /^Helper$/, /^Explore · task 1$/)
  // the job ends: no toast for a job with no steps and no helpers of its own; a1 stays folded
  await complete($, 'm')
  expect(w.toasts.length).toBe(toasts)
  expect(record(w)?.agents.map((a: any) => a.id)).not.toContain('a1')
  expect(record(w)?.earlier).toMatchObject({ agents: 1 })
})

test('helper rows read type · description; teammates by name', async ($, on) => {
  const w = world(on)
  w.agents = [
    { id: 'a1', description: 'Find database connection config', type: 'researcher', status: 'running' },
    { id: 'a2', description: 'Write plan', type: 'teammate', name: 'alice', status: 'running' },
    { id: 'a3', description: 'Draft spec', type: 'teammate', status: 'running' },
    { id: 'a4', description: 'planner', type: 'planner', status: 'running' },
    { id: 'a5', description: '', type: 'coder', status: 'running' },
    { id: 'a7', description: 'Write tests', type: 'tester', teammateId: 'bob@crew', status: 'running' },
  ]
  await prompt($, 'team')
  await start($, 'm')
  for (let i = 1; i <= 7; i++) await start($, `h${i}`, `a${i}`)
  // a6 is listed only after its start: its first step names it
  w.agents.push({ id: 'a6', description: 'Review the diff', type: 'reviewer', status: 'running' })
  await step($, w, 'h6', 1_000, 0, 'a6')
  await shows(pane($), /^Main$/, /^researcher · Find database/, /^alice$/, /^Draft spec$/, /^planner$/, /^coder$/, /^reviewer · Review the diff$/)
  // a teammate with a type is still shown by the name in its teammateId
  await shows(pane($), /^bob$/)
  await hidden(pane($), /^tester · Write tests$/)
})

const NAMES: Array<[string, string, string]> = [
  ['MRKRR-142 fix the login redirect', 'MRKRR-142', 'ticket'],
  ['USAGE-RADAR: Agent names', 'USAGE-RADAR', 'ticket'],
  ['please refactor the payment service retry logic', 'please refactor the payment service', 'words'],
  ['fix UTF-8 handling and TODO in src/ABC-1.ts', 'fix UTF-8 handling and TODO', 'words'],
  ['fix mrkrr-142 redirect', 'MRKRR-142', 'ticket'],
  ['usage-radar tweaks', 'usage-radar tweaks', 'words'],
  ['bump gpt-4 and utf-8 support now', 'bump gpt-4 and utf-8 support', 'words'],
  ['look at https://acme.atlassian.net/browse/MRKRR-142 please', 'MRKRR-142', 'ticket'],
  ['see https://jira.example.com/jira/browse/ops-77?focusedCommentId=1', 'OPS-77', 'ticket'],
  ['fix mrkrr-42 redirect', 'MRKRR-42', 'ticket'],
  ['do step-2 of the python-3 upgrade', 'do step-2 of the python-3', 'words'],
  ['show top-10 web-01 hosts in prod', 'show top-10 web-01 hosts in', 'words'],
  ['fix WEB-01 and CI-CD in prod', 'fix WEB-01 and CI-CD in', 'words'],
  ['open docs/browse/ABC-1.md and fix', 'open docs/browse/ABC-1.md and fix', 'words'],
  ['upgrade ruby-3.2 and node-18.1 then vue-3.4', 'upgrade ruby-3.2 and node-18.1 then', 'words'],
]

test('the first prompt names the session', async ($, on) => {
  const w = world(on)
  for (const [i, [text, name, kind]] of NAMES.entries()) {
    w.sid = `k${i}`
    await prompt($, text)
    await start($, 'm')
    await complete($, 'm')
    expect(record(w), text).toMatchObject({ name, nameKind: kind })
    await shows(pane($), exactly(name))
    // the band keeps the name to 28 characters
    await shows(band($), exactly(name.length <= 28 ? name : `${name.slice(0, 27)}…`))
  }
})

test('slash commands: built-ins give no name, your own do', async ($, on) => {
  const w = world(on)
  await prompt($, '/model sonnet', { name: 'model', args: 'sonnet' })
  expect(record(w)).toBeUndefined()
  await prompt($, '/feature MRKRR-7 add search', { name: 'feature', args: 'MRKRR-7 add search' })
  expect(record(w)).toMatchObject({ name: 'MRKRR-7', nameKind: 'ticket' })

  w.sid = 's2'
  await prompt($, '/feature add dark mode', { name: 'feature', args: 'add dark mode' })
  expect(record(w)).toMatchObject({ name: 'add dark mode', nameKind: 'words' })
  await shows(pane($), /^add dark mode$/)

  // a later prompt doesn't change it
  await prompt($, 'ABC-9 other')
  expect(record(w)?.name).toBe('add dark mode')
})

test('/rename and the session title win over the automatic name', async ($, on) => {
  const w = world(on)
  await job($, w, 'fix stuff quickly', 0.01)
  expect(record(w)).toMatchObject({ name: 'fix stuff quickly', nameKind: 'words' })

  await rename($, 'Login revamp')
  expect(record(w)).toMatchObject({ name: 'Login revamp', nameKind: 'rename' })
  await job($, w, 'ABC-1 more work', 0.02)
  expect(record(w)?.name).toBe('Login revamp')
  await shows(pane($), /^Login revamp$/)
  await shows(band($), /^Login revamp$/)

  // a session title from the classic hook replaces an automatic name
  w.sid = 's2'
  await job($, w, 'another thing', 0.03)
  expect(record(w)?.nameKind).toBe('words')
  await $.classic.UserPromptSubmit({ prompt: 'x', session_title: 'Billing fix' } as never)
  expect(record(w)).toMatchObject({ name: 'Billing fix', nameKind: 'rename' })
  await shows(pane($), /^Billing fix$/)
})

test('a long name is cut to fit a narrow band', async ($, on) => {
  const w = world(on)
  await job($, w, 'hello', 0.01)
  await rename($, 'A'.repeat(60))
  const ui = await band($, 40)
  const names = (await ui.findAll({ type: 'Text', text: /^A+/ })).filter(t => t.props.bold)
  expect(names.length).toBe(1)
  expect(names[0]?.text.length ?? 99).toBeLessThanOrEqual(13)
  expect(names[0]?.text).toEndWith('…')
  await ui.unmount()
})

test('the main row shows session totals, without cache reads or helpers', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: '', type: 'coder', status: 'running' }]

  // job 1: main and a helper with equal usage → the helper's share is half of $0.20
  await prompt($, 'first job')
  await start($, 'm')
  w.cost = 0.10
  await step($, w, 'm', 10_000, 0)
  await start($, 'h', 'a1')
  w.cost = 0.20
  await step($, w, 'h', 10_000, 0, 'a1')
  await w.clock.advance(2_000)
  await complete($, 'm')
  await complete($, 'h', 'a1')

  // job 2: main only; its cache reads don't count
  await prompt($, 'second job')
  await start($, 'm')
  w.cost = 0.30
  await step($, w, 'm', 5_000, 0, undefined, 100_000)
  await w.clock.advance(3_000)
  await complete($, 'm')

  // cards: the session; main's row: the session minus the helper's $0.10 and 10k
  await shows(pane($), /^≈\$0\.30$/, /^25k$/, /^≈\$0\.20$/, /15k · 0:05$/)
  expect(record(w)?.agents).toMatchObject([{ id: 'a1', tokens: 10_000 }])
  expect(Math.abs(record(w)?.agents[0].cost - 0.10)).toBeLessThan(1e-9)

  // no helpers at all: main's row is exactly the cards (a new session's ledger starts at 0)
  w.sid = 's2'
  w.cost = 0
  await job($, w, 'solo', 0.07, 4_000, 1_000)
  const ui = await pane($)
  expect((await ui.findAll({ type: 'Text', text: /^≈\$0\.07$/ })).length).toBe(2)
  expect(await ui.find({ type: 'Text', text: /^ *5k · 0:00$/ })).toBeDefined()
  await ui.unmount()
})

test('the clock keeps ticking while a background helper works', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: '', type: 'coder', status: 'running' }]
  await prompt($, 'go')
  await start($, 'm')
  await step($, w, 'm', 1_000, 0)
  await w.clock.advance(1_000)
  await complete($, 'm')

  // a minute later a background helper starts: the gap isn't counted, then time ticks
  await w.clock.advance(60_000)
  await start($, 'h', 'a1')
  await w.clock.advance(2_000)
  await shows(band($), /^0:03$/)
  await shows(pane($), /^0:03$/, /1 running/, /0:02$/)
  await w.clock.advance(2_000)
  await shows(band($), /^0:05$/)
  await shows(pane($), /^0:05$/, /0:04$/)
})

test('a helper the engine lists as finished stops the clock and the totals refresh', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: '', type: 'coder', status: 'running' }]
  await prompt($, 'go')
  await start($, 'm')
  await start($, 'h', 'a1')
  w.cost = 0.10
  await step($, w, 'h', 1_000, 0, 'a1')
  await complete($, 'm')
  await w.clock.advance(2_000)

  // its turn.complete never comes; the next poll sees it finished and the new cost
  w.agents[0]!.status = 'completed'
  w.cost = 0.25
  await w.clock.advance(1_000)
  expect(w.toasts.at(-1)).toContain('✓ All done')
  const toasts = w.toasts.length
  await shows(pane($), /^≈\$0\.25$/, /^0:03$/, /Done/)

  await w.clock.advance(5_000)
  await shows(band($), /^0:03$/)
  // a late turn.complete: no second toast, the time stays
  await complete($, 'h', 'a1')
  expect(w.toasts.length).toBe(toasts)
  await shows(band($), /^0:03$/)
})

test('an idle teammate pauses its clock, and the job clock when nobody else works', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: 'Write plan', type: 'teammate', name: 'alice', status: 'running' }]
  await prompt($, 'team')
  await start($, 'm')
  await start($, 'h', 'a1')
  await step($, w, 'h', 1_000, 0, 'a1')
  await complete($, 'm')
  await w.clock.advance(2_000)

  // listed idle from the next poll on (at 0:03): nothing advances, but the job isn't done
  w.agents[0]!.status = 'idle'
  await w.clock.advance(1_000)
  await w.clock.advance(5_000)
  await shows(band($), /^0:03$/)
  await shows(pane($), /^0:03$/, /0:03 · idle$/, /1 running/, /Working/)
  expect(w.toasts.some(t => t.includes('All done'))).toBe(false)

  // working again: both clocks go on from where they stopped
  w.agents[0]!.status = 'running'
  await w.clock.advance(1_000)
  await w.clock.advance(2_000)
  await shows(band($), /^0:05$/)
  await shows(pane($), /^0:05$/, /1k · 0:05$/)
  await hidden(pane($), /idle$/)
})

test('agents stay listed for the whole session, frozen once finished', async ($, on) => {
  const w = world(on)
  w.agents = [
    { id: 'a1', description: '', type: 'coder', status: 'running' },
    { id: 'a2', description: '', type: 'reviewer', status: 'running' },
  ]
  // job 1: coder costs half of $0.20, 10k tokens, 2 s
  await prompt($, 'first job')
  await start($, 'm')
  w.cost = 0.10
  await step($, w, 'm', 10_000, 0)
  await start($, 'h1', 'a1')
  w.cost = 0.20
  await step($, w, 'h1', 10_000, 0, 'a1')
  await w.clock.advance(2_000)
  await complete($, 'h1', 'a1')
  await complete($, 'm')

  // job 2: a reviewer works while the cost goes up; the coder's row doesn't change
  await prompt($, 'second job')
  await start($, 'm')
  await start($, 'h2', 'a2')
  w.cost = 0.50
  await step($, w, 'h2', 30_000, 0, 'a2')
  await w.clock.advance(4_000)
  const ui = await pane($)
  expect(await ui.find({ type: 'Text', text: /^≈\$0\.10$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /10k · 0:02$/ })).toBeDefined()
  // the running reviewer comes before the finished, dimmed coder
  const names = await ui.findAll({ type: 'Text', text: /^(reviewer|coder)$/ })
  expect(names.map(n => n.text)).toEqual(['reviewer', 'coder'])
  expect(names[1]?.props.dimColor).toBe(true)
  expect(names[0]?.props.dimColor).toBeFalsy()
  await ui.unmount()
  await shows(pane($), /3 agents/, /1 running/)
})

test('helpers past the 8 rows share one "+N earlier agents" line', async ($, on) => {
  const w = world(on)
  w.agents = Array.from({ length: 10 }, (_, i) => ({ id: `a${i + 1}`, description: '', type: `t${i + 1}`, status: 'running' }))
  await prompt($, 'many')
  await start($, 'm')
  for (let i = 1; i <= 10; i++) await start($, `h${i}`, `a${i}`)
  w.cost = 1
  for (let i = 1; i <= 10; i++) await step($, w, `h${i}`, 1_000, 0, `a${i}`)
  // ten running: the two past the rows are on the line as running, not as earlier
  await shows(pane($), /^\+2 more running · ≈\$0\.20$/)
  await hidden(pane($), /earlier agent/)
  // they finish in turn, each with a tenth of $1
  for (let i = 1; i <= 10; i++) {
    await w.clock.advance(100)
    await complete($, `h${i}`, `a${i}`)
  }
  await complete($, 'm')
  // the 8 latest have rows; t1 and t2 share a line
  await shows(pane($), /^t10$/, /^t3$/, /^\+2 earlier agents · ≈\$0\.20$/)
  await hidden(pane($), /^t1$/, /^t2$/)

  // the next job folds them away for good; the line and the totals stay
  await job($, w, 'next', 1.10)
  await shows(pane($), /^\+2 earlier agents · ≈\$0\.20$/, /^t10$/, /^≈\$1\.10$/)
  expect(record(w)?.agents.length).toBe(8)
  expect(record(w)?.earlier).toMatchObject({ agents: 2, tokens: 2_000 })
})

test('resume brings the session\'s agents back; another session has none', async ($, on) => {
  const now = 400 * DAY
  const agent = { id: 'x1', name: 'researcher · Find config', model: 'claude-opus-5-5', cost: 0.42, tokens: 12_000, ms: 65_000, endedAt: now - DAY }
  const w = world(on, {
    'session:s1': {
      v: 1, updatedAt: now - DAY, name: 'old work', nameKind: 'words',
      cost: 1, tokens: 50_000, ms: 600_000, steps: 4, helperIds: ['x1'],
      // a bad entry is dropped, the rest of the record still loads
      agents: [agent, { id: 3 }, 'junk', { ...agent, id: 'x2', tokens: -1 }],
    },
  }, now)
  await job($, w, 'more', 0.05)
  await shows(pane($), /^researcher · Find config$/, /^≈\$0\.42$/, /12k · 1:05$/, /^≈\$1\.05$/, /2 agents/)
  await hidden(pane($), /earlier agent/)
  expect(record(w)?.agents).toMatchObject([{ id: 'x1', cost: 0.42, tokens: 12_000, ms: 65_000 }])

  // /clear: a new session starts with no agents (and its ledger at 0)
  w.sid = 's2'
  w.cost = 0
  await job($, w, 'fresh', 0.01)
  await hidden(pane($), /researcher/)
  expect(record(w)?.agents).toEqual([])
})

test('a 2.1.0 record without agents still loads', async ($, on) => {
  const now = 400 * DAY
  const w = world(on, {
    'session:s1': {
      v: 1, updatedAt: now - DAY, name: 'old', nameKind: 'words',
      cost: 0.5, tokens: 1_000, ms: 1_000, steps: 1, helperIds: [],
    },
  }, now)
  await job($, w, 'more', 0.01)
  await shows(pane($), /^old$/, /^≈\$0\.51$/)
  expect(record(w)).toMatchObject({ agents: [], earlier: { agents: 0, cost: 0, tokens: 0 } })
})

test('a poll and a turn.complete ending the job together give one "All done"', async ($, on) => {
  const w = world(on)
  // once armed: just before the poll's write lands, the helper's turn.complete writes first,
  // so the poll's write misses and update runs the poll's change again
  let race = false
  on('state.set', async (_$: any, e: any, next: any) => {
    if (race && e.value?.value?.isRunning === false && e.value?.value?.agents?.some((a: any) => a.id === 'a1')) {
      race = false
      await complete($, 'h', 'a1')
    }
    return next(e)
  })
  w.agents = [{ id: 'a1', description: '', type: 'coder', status: 'running' }]
  await prompt($, 'go')
  await start($, 'm')
  await start($, 'h', 'a1')
  await step($, w, 'h', 1_000, 0, 'a1')
  await complete($, 'm')
  await w.clock.advance(500)

  // the poll sees it finished
  race = true
  w.agents[0]!.status = 'completed'
  await w.clock.advance(1_000)
  await w.clock.advance(2_000)
  expect(race).toBe(false)
  expect(w.toasts.filter(t => t.includes('All done')).length).toBe(1)
})

test('a late tick of an old clock does not stop the clock of a new background turn', async ($, on) => {
  const w = world(on)
  w.agents = [{ id: 'a1', description: '', type: 'coder', status: 'running' }]
  // stage 1: while a tick writes, main's turn ends (stopping that clock), so the tick tries again;
  // stage 2: right after its retry lands, a background helper starts a new clock
  let stage = 0
  on('state.set', async (_$: any, e: any, next: any) => {
    if (stage === 1) {
      stage = 0
      await complete($, 'm')
      stage = 2
      return next(e)
    }
    if (stage === 2 && e.value?.value?.isRunning === false) {
      stage = 0
      const r = await next(e)
      await start($, 'h', 'a1')
      return r
    }
    return next(e)
  })
  await prompt($, 'go')
  await start($, 'm')
  stage = 1
  await w.clock.advance(250)
  expect(stage).toBe(0)
  await w.clock.advance(3_000)
  await shows(pane($), /1 running/)
  await shows(band($), /^0:03$/)
})

test('a ledger reading that arrives late is not counted again', async ($, on) => {
  const w = world(on)
  await prompt($, 'go')
  await start($, 'm')
  w.cost = 0.10
  await step($, w, 'm', 1_000, 0)

  // while the poll waits for the agent list, main's next step moves the ledger to $0.20
  w.onList = async () => {
    w.cost = 0.20
    await step($, w, 'm', 1_000, 0)
  }
  await w.clock.advance(1_000)
  expect(w.onList).toBeNull()
  await shows(pane($), /^≈\$0\.20$/, /Session total ≈\$0\.20/, /this request: ≈\$0\.20/)

  // the poll's own reading is $0.20 but a step to $0.30 lands first: the late $0.20 is left out
  w.onUsage = async () => {
    w.cost = 0.30
    await step($, w, 'm', 1_000, 0)
  }
  await w.clock.advance(1_000)
  expect(w.onUsage).toBeNull()
  await shows(pane($), /^≈\$0\.30$/, /Session total ≈\$0\.30/, /this request: ≈\$0\.30/)
  await w.clock.advance(1_000)
  await complete($, 'm')
  await shows(pane($), /^≈\$0\.30$/)
  expect(Math.abs(record(w)?.cost - 0.30)).toBeLessThan(1e-9)
})

// How many rows a drawn tree takes: Text 1, a column its children + gaps, a row its tallest, + borders
const height = (el: any): number => {
  if (!el || typeof el !== 'object') return 0
  if (el.type === 'Text') return 1
  const kids = (el.children ?? []).filter((c: any) => c && typeof c === 'object')
  const inner = el.props?.flexDirection === 'row'
    ? Math.max(0, ...kids.map(height))
    : kids.reduce((s: number, c: any) => s + height(c), 0) + (el.props?.gap ?? 0) * Math.max(0, kids.length - 1)
  return inner + (el.props?.borderStyle ? 2 : 0)
}
const radar = ($: Engine) =>
  $.command.run({ command: 'radar', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
const fits = async ($: Engine, w: World) => {
  await radar($)
  const ui: any = await pane($)
  expect(w.opened.at(-1)).toBe(height(await ui.drawn()))
  await ui.unmount()
}

test('the panel opens exactly as tall as what it draws', async ($, on) => {
  const w = world(on)
  w.agents = Array.from({ length: 10 }, (_, i) => ({ id: `a${i + 1}`, description: '', type: `t${i + 1}`, status: 'running' }))
  await prompt($, 'go')
  await start($, 'm')
  w.cost = 0.10
  await step($, w, 'm', 1_000, 0)
  // the context meter is shown (1 limit row block); one helper
  await start($, 'h1', 'a1')
  await fits($, w)
  // ten helpers: 8 rows and the "+2 more running" line
  for (let i = 2; i <= 10; i++) await start($, `h${i}`, `a${i}`)
  await fits($, w)
  for (let i = 1; i <= 10; i++) await complete($, `h${i}`, `a${i}`)
  await complete($, 'm')
  await fits($, w)
})
