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
    on('session.authorize', () => ({ value: null }) as never)
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

const world = (on: any, seed: Record<string, unknown> = {}, now = 0, env: Record<string, string> = {}) => {
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
    /** the plan limits session.usage reports (none, as off a subscription, unless a test sets them) */
    limits: [] as Array<Record<string, unknown>>,
    /** files $.fs.read finds (by path), and how many reads were asked for */
    files: {} as Record<string, string>,
    reads: 0,
    /** the panes open now (by id) */
    panes: new Set<string>(),
    /** the login session.authorize answers (null: none, 'throw': it fails), and how often it was asked */
    auth: null as null | 'throw' | { handle: string; kind: 'bearer' | 'api-key' },
    authorized: 0,
    /** where the session draws (none: a -p run, or an SDK session nothing attached to yet) */
    surfaces: ['terminal'] as string[],
    /** the requests $.http.fetch got and when, what it answers (null or 'deny': refused), and what it waits for first */
    fetches: [] as any[],
    fetchedAt: [] as number[],
    reply: null as null | 'deny' | 'throw' | { status: number; ok: boolean; text: string },
    hold: null as null | Promise<void>,
  }
  on('session.authorize', () => {
    w.authorized++
    if (w.auth === 'throw') throw new Error('no login')
    return { value: w.auth } as never
  })
  on('session.surfaces', () => ({ value: w.surfaces }) as never)
  on('http.fetch', async (_$: any, e: any) => {
    w.fetches.push(e)
    w.fetchedAt.push(w.clock.now())
    const reply = w.reply
    if (w.hold) await w.hold
    if (reply === 'throw') throw new Error('network down')
    if (reply === null || reply === 'deny') return { deny: 'refused' } as never
    return { value: { ...reply, headers: {} } } as never
  })
  mock.env(on, env)
  on('fs.read', (_$: any, e: any) => {
    w.reads++
    const text = w.files[e.path]
    return (text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }) as never
  })
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }) as never)
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
    const value = { startedAt: 0, context: { window: 200_000, percent: 10 }, rateLimits: w.limits, cost: { usd: w.cost } }
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
    w.panes.add(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('ui.panes', () => ({ value: [...w.panes].map(id => ({ id, title: 'Usage Radar', isShown: true, isFocused: false, isPlaced: true })) }) as never)
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
        v: 1, updatedAt: now - DAY, name: 'DEMO-142', nameKind: 'ticket',
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

    const totals = [/^≈\$1\.20$/, /^511k$/, /^10:05$/, /41 steps/, /^DEMO-142$/, /this request: ≈\$0\.20 · 11k · 0:05 · 1 step/]
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
  ['DEMO-142 fix the login redirect', 'DEMO-142', 'ticket'],
  ['USAGE-RADAR: Agent names', 'USAGE-RADAR', 'ticket'],
  ['please refactor the payment service retry logic', 'please refactor the payment service', 'words'],
  ['fix UTF-8 handling and TODO in src/ABC-1.ts', 'fix UTF-8 handling and TODO', 'words'],
  ['fix qzx-142 redirect', 'QZX-142', 'ticket'],
  ['usage-radar tweaks', 'usage-radar tweaks', 'words'],
  ['bump gpt-4 and utf-8 support now', 'bump gpt-4 and utf-8 support', 'words'],
  ['look at https://acme.atlassian.net/browse/DEMO-142 please', 'DEMO-142', 'ticket'],
  ['see https://jira.example.com/jira/browse/ops-77?focusedCommentId=1', 'OPS-77', 'ticket'],
  ['fix qzx-42 redirect', 'QZX-42', 'ticket'],
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
  await prompt($, '/feature DEMO-7 add search', { name: 'feature', args: 'DEMO-7 add search' })
  expect(record(w)).toMatchObject({ name: 'DEMO-7', nameKind: 'ticket' })

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

// ════════════════════════════════════════════════════════════════════════════
// 2.2.0: the limit forecast, the session budget and the account badge
// ════════════════════════════════════════════════════════════════════════════
const radarCmd = ($: Engine, args: string) =>
  $.command.run({ command: 'radar', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never) as Promise<{ text?: string }>

// The 5-hour limit as the engine reports it: used %, and its reset `resetInMs` after `now`
const five = (pct: number, resetInMs = 3 * 3600_000, now = 0) =>
  ({ kind: 'five_hour', percentUsed: pct, resetsAt: new Date(now + resetInMs).toISOString() })

// The colour of the first Text matching `re` that has one; the band's border colour
const color = async (mount: Promise<Ui>, re: RegExp) => {
  const ui = await mount
  const found = (await ui.findAll({ type: 'Text', text: re })).find(t => t.props.color !== undefined)
  await ui.unmount()
  return found?.props.color
}
const border = async (mount: Promise<Ui>) => {
  const ui = await mount
  const box = await ui.find({ type: 'Box' })
  await ui.unmount()
  return box?.props.borderColor
}

// Work for `seconds` (in 30 s steps), the 5-hour limit rising `by` points every 30 s
const climb = async (w: World, from: number, by: number, seconds: number, reading = (pct: number) => five(pct)) => {
  let pct = from
  for (let s = 0; s < seconds; s += 30) {
    await w.clock.advance(30_000)
    pct += by
    w.limits = [reading(pct)]
  }
  return pct
}
const paceToasts = (w: World, re = /at this pace/) => w.toasts.filter(t => re.test(t))

test('the forecast shows after 3 minutes of steady work, with one ⚠', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.limits = [five(40)]
  await prompt($, 'go')
  await start($, 'm')
  // a minute in: not measured long enough yet
  await climb(w, 40, 1, 60)
  await hidden(band($), /left/)
  await climb(w, 42, 1, 120)
  await w.clock.advance(10_000)
  await shows(band($), /^ · ~2\dm left$/)
  await shows(pane($), /~2\dm left at this pace/)
  expect(paceToasts(w).length).toBe(1)
  expect(paceToasts(w)[0]).toMatch(/^⚠ 5h limit: ~2\dm left at this pace · resets in /)
  // more of the same pace: no second toast
  await climb(w, 46, 1, 60)
  expect(paceToasts(w).length).toBe(1)
})

test('a steep climb gives one ⛔, and no repeats', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.limits = [five(40)]
  await prompt($, 'go')
  await start($, 'm')
  await climb(w, 40, 5, 180)
  await w.clock.advance(10_000)
  expect(paceToasts(w).length).toBe(1)
  expect(paceToasts(w)[0]).toMatch(/^⛔ 5h limit: ~\dm left at this pace/)
  await climb(w, 70, 5, 60)
  expect(paceToasts(w).length).toBe(1)
})

test('no forecast when the limit resets before it would run out', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  const soon = (pct: number) => five(pct, 20 * 60_000)
  w.limits = [soon(40)]
  await prompt($, 'go')
  await start($, 'm')
  await climb(w, 40, 1, 180, soon)
  await w.clock.advance(10_000)
  await hidden(band($), /left/)
  await hidden(pane($), /at this pace/)
  expect(paceToasts(w).length).toBe(0)
})

test('the forecast goes when the job ends, and after a reset', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.limits = [five(40)]
  await prompt($, 'go')
  await start($, 'm')
  await climb(w, 40, 1, 180)
  await w.clock.advance(10_000)
  await shows(band($), /~2\dm left/)
  await complete($, 'm')
  await hidden(band($), /left/)
  await hidden(pane($), /at this pace/)

  // the next job picks the pace back up; then the window resets (40 → 1): measuring starts over
  await prompt($, 'more')
  await start($, 'm')
  await w.clock.advance(2_000)
  await shows(band($), /~\d+m left/)
  w.limits = [five(1)]
  await w.clock.advance(2_000)
  await hidden(band($), /left/)
})

test('what a limit rose while idle is left out of the pace', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.limits = [five(40)]
  await prompt($, 'first')
  await start($, 'm')
  const pct = await climb(w, 40, 1, 90)
  await complete($, 'm')
  // half an hour away while another window (another session) used 10 points
  w.limits = [five(pct + 10)]
  await w.clock.advance(30 * 60_000)
  await prompt($, 'second')
  await start($, 'm')
  await climb(w, pct + 10, 1, 90)
  await w.clock.advance(5_000)
  // 6 points in ~3 minutes of work: ~23m left (with the idle 10 it would be ~8m)
  await shows(band($), /^ · ~2\dm left$/)
})

// The live shape: no limits until the first response, ISO text or epoch seconds for the reset
const NOW = Date.parse('2026-10-21T10:00:00Z')
const LIVE_SHAPES: Array<[string, (pct: number) => Record<string, unknown>]> = [
  ['ISO reset', pct => five(pct, 3 * 3600_000, NOW)],
  ['epoch-seconds reset', pct => ({ kind: 'five_hour', percentUsed: pct, resetsAt: Math.floor((NOW + 3 * 3600_000) / 1000) })],
]
for (const [label, reading] of LIVE_SHAPES) {
  test(`limits that appear only after the first response still get a forecast (${label})`, { timeoutMs: 30_000 }, async ($, on) => {
    const w = world(on, {}, NOW)
    // before the first response: no limits at all (as the engine reports them)
    await prompt($, 'go')
    await start($, 'm')
    await w.clock.advance(5_000)
    await hidden(band($), /5h limit/)
    // the first response reports them, with the weekly one beside (no reset time)
    w.limits = [reading(1), { kind: 'seven_day', percentUsed: 11 }]
    await step($, w, 'm', 1_000, 0)
    await shows(band($), /^5h limit $/, /^Weekly $/)
    await shows(pane($), /resets in 3h 0m/)
    let pct = 1
    for (let s = 0; s < 240; s += 30) {
      await w.clock.advance(30_000)
      pct += 2
      w.limits = [reading(pct), { kind: 'seven_day', percentUsed: 11 }]
      await step($, w, 'm', 1_000, 0)
    }
    await w.clock.advance(10_000)
    // ~4% a minute of work with 83% left: ~20m
    await shows(band($), /^ · ~(19|2\d)m left$/)
    await shows(pane($), /~(19|2\d)m left at this pace/)
    expect(paceToasts(w).length).toBe(1)
  })
}

test('limits the engine pushes (session.measure) reach the meters', async ($, on) => {
  const w = world(on)
  await job($, w, 'go', 0.01)
  await hidden(band($), /5h limit/)
  await $.session.measure({
    context: { window: 200_000, percent: 12 },
    rateLimits: [five(84)],
    changed: ['rateLimits'],
  } as never)
  await shows(band($), /^5h limit $/, /84%/)
  expect(w.toasts.filter(t => /^⚠ 5h limit 84% used/.test(t)).length).toBe(1)
})

// ── The budget ─────────────────────────────────────────────────────────
test('the budget warns at 80% and 100% once each, and colours the band', async ($, on) => {
  const w = world(on)
  expect((await radarCmd($, 'budget 1')).text).toBe('Budget set: $1.00 for this session · — spent so far')
  await prompt($, 'go')
  await start($, 'm')
  w.cost = 0.50
  await step($, w, 'm', 1_000, 0)
  expect(w.toasts.filter(t => /Budget/.test(t))).toEqual([])
  expect(await color(band($), exactly('≈$0.50 / $1.00'))).toBe('success')
  w.cost = 0.85
  await step($, w, 'm', 1_000, 0)
  w.cost = 0.90
  await step($, w, 'm', 1_000, 0)
  expect(await color(band($), exactly('≈$0.90 / $1.00'))).toBe('warning')
  expect(await border(band($))).toBe('warning')
  w.cost = 1.20
  await step($, w, 'm', 1_000, 0)
  await complete($, 'm')
  expect(w.toasts.filter(t => /Budget/.test(t))).toEqual(['⚠ Budget 80% used · ≈$0.85 / $1.00', '⛔ Budget reached · ≈$1.20 / $1.00'])
  await shows(band($), exactly('≈$1.20 / $1.00'))
  expect(await color(band($), exactly('≈$1.20 / $1.00'))).toBe('error')
  expect(await border(band($))).toBe('error')
  expect(await color(pane($), exactly('≈$1.20 / $1.00'))).toBe('error')
  expect(record(w)).toMatchObject({ budget: 1, budgetFired: 100 })
})

test('resume keeps the budget and the warnings already shown', async ($, on) => {
  const now = 400 * DAY
  const w = world(on, {
    'session:s1': {
      v: 1, updatedAt: now - DAY, name: 'old', nameKind: 'words',
      cost: 0.85, tokens: 1_000, ms: 1_000, steps: 1, helperIds: [], budget: 1, budgetFired: 80,
    },
  }, now)
  await job($, w, 'more', 0.10)
  expect(w.toasts.filter(t => /Budget/.test(t))).toEqual([])
  await shows(band($), exactly('≈$0.95 / $1.00'))
  await job($, w, 'more', 0.20)
  expect(w.toasts.filter(t => /Budget/.test(t))).toEqual(['⛔ Budget reached · ≈$1.05 / $1.00'])
  expect(record(w)).toMatchObject({ budget: 1, budgetFired: 100 })
})

test('/clear keeps the budget, its spend and warnings start over; resume keeps its own', async ($, on) => {
  const w = world(on)
  await radarCmd($, 'budget 1')
  await job($, w, 'go', 0.90)
  expect(w.toasts.filter(t => /Budget/.test(t))).toEqual(['⚠ Budget 80% used · ≈$0.90 / $1.00'])

  // /clear: a new id with no record
  w.sid = 's2'
  w.cost = 0
  await job($, w, 'fresh', 0.10)
  await shows(band($), exactly('≈$0.10 / $1.00'))
  await job($, w, 'fresh', 0.85)
  expect(w.toasts.filter(t => /Budget/.test(t)).length).toBe(2)
  expect(record(w, 's2')).toMatchObject({ budget: 1, budgetFired: 80 })

  // back to s1: its own record
  w.sid = 's1'
  w.cost = 0
  await job($, w, 'back', 0)
  await shows(band($), exactly('≈$0.90 / $1.00'))
  expect(record(w, 's1')).toMatchObject({ budget: 1, budgetFired: 80 })
  expect(w.toasts.filter(t => /Budget/.test(t)).length).toBe(2)
})

test('/radar budget: show, bad amounts, lowering below the spend, off, $2', async ($, on) => {
  const w = world(on)
  expect((await radarCmd($, 'budget abc')).text).toBe('Usage Radar: /radar budget takes an amount in dollars (like 5 or 2.50), or off.')
  expect((await radarCmd($, 'budget -3')).text).toMatch(/takes an amount/)
  expect((await radarCmd($, 'budget')).text).toBe('No budget for this session. Set one with /radar budget 5')
  await job($, w, 'go', 0.50)
  const toasts = w.toasts.length

  // lowering it below what's spent: no toast now, the reply says so
  expect((await radarCmd($, 'budget 0.40')).text).toBe('Budget set: $0.40 for this session · ≈$0.50 spent so far · already past 100%')
  expect(w.toasts.length).toBe(toasts)
  expect((await radarCmd($, 'budget')).text).toBe('Budget: ≈$0.50 / $0.40 (125%)')
  await job($, w, 'more', 0.60)
  expect(w.toasts.filter(t => /Budget/.test(t))).toEqual([])

  expect((await radarCmd($, 'budget off')).text).toBe('Budget off for this session.')
  expect(record(w)).toMatchObject({ budget: null, budgetFired: 0 })
  await shows(band($), exactly('≈$0.60'))
  await hidden(band($), / \/ \$/)

  expect((await radarCmd($, 'BUDGET $2')).text).toBe('Budget set: $2.00 for this session · ≈$0.60 spent so far')
  await shows(pane($), exactly('≈$0.60 / $2.00'))
})

test('a default budget from the options; a record\'s own budget wins', { options: { defaultBudget: 5 } }, async ($, on) => {
  const now = 400 * DAY
  const old = { v: 1, updatedAt: now - DAY, name: 'old', nameKind: 'words', cost: 0.5, tokens: 1, ms: 1, steps: 1, helperIds: [] }
  const w = world(on, { 'session:off': { ...old, budget: null }, 'session:none': old }, now)
  await job($, w, 'go', 0.10)
  await shows(band($), exactly('≈$0.10 / $5.00'))
  // the default isn't saved: it comes back on its own
  expect(record(w)?.budget).toBeUndefined()

  w.sid = 'off'
  w.cost = 0
  await job($, w, 'go', 0.10)
  await shows(band($), exactly('≈$0.60'))
  await hidden(band($), / \/ \$/)

  w.sid = 'none'
  w.cost = 0
  await job($, w, 'go', 0.10)
  await shows(band($), exactly('≈$0.60 / $5.00'))
})

test('/radar budget does not name the session', async ($, on) => {
  const w = world(on)
  await prompt($, '/radar budget 5', { name: 'radar', args: 'budget 5' })
  await radarCmd($, 'budget 5')
  expect(record(w)).toMatchObject({ name: null, budget: 5 })
  await job($, w, 'DEMO-9 the real work', 0.01)
  expect(record(w)?.name).toBe('DEMO-9')
})

// ── The account badge ──────────────────────────────────────────────────
const LABELS = { accounts: ['work.example.com=WORK', 'gmail.com=PERSONAL'] }
const account = (email: string | null, org: string | null = null) =>
  JSON.stringify({ oauthAccount: { ...(email && { emailAddress: email }), ...(org && { organizationName: org }) } })

test('a work account from $CLAUDE_CONFIG_DIR gets an amber [WORK] badge', { options: LABELS }, async ($, on) => {
  const w = world(on, {}, 0, { CLAUDE_CONFIG_DIR: '/Users/t/.claude-work', HOME: '/Users/t' })
  w.files['/Users/t/.claude-work/.claude.json'] = account('you@work.example.com', 'Work Co')
  w.files['/Users/t/.claude.json'] = account('you@gmail.com')
  await job($, w, 'go', 0.01)
  await shows(band($), exactly('[WORK] you@work.example.com'))
  await shows(pane($), exactly('[WORK] you@work.example.com'))
  expect(await color(band($), exactly('[WORK] you@work.example.com'))).toBe('warning')
  expect(await color(pane($), exactly('[WORK] you@work.example.com'))).toBe('warning')
})

for (const [email, badge, colour] of [
  ['you@gmail.com', '[PERSONAL] you@gmail.com', 'success'],
  ['You@Mail.Work.Example.COM', '[WORK] You@Mail.Work.Example.COM', 'warning'],
] as const) {
  test(`${email} from ~/.claude.json reads ${badge}`, { options: LABELS }, async ($, on) => {
    const w = world(on, {}, 0, { HOME: '/Users/t' })
    w.files['/Users/t/.claude.json'] = account(email)
    await job($, w, 'go', 0.01)
    await shows(band($), exactly(badge))
    expect(await color(band($), exactly(badge))).toBe(colour)
  })
}

const BADGES: Array<[string, Record<string, unknown>, string, string]> = [
  ['no label: the email, dim', { accounts: ['work.example.com=WORK'] }, account('you@gmail.com', 'Acme'), 'you@gmail.com'],
  ['hideEmail with a label', { ...LABELS, hideEmail: true }, account('you@work.example.com', 'Work Co'), '[WORK]'],
  ['hideEmail without a label: the organization', { hideEmail: true }, account('you@gmail.com', 'Acme'), 'Acme'],
  ['a custom label: orange', { accounts: 'gmail.com=Side; work.example.com=WORK' }, account('you@gmail.com'), '[Side] you@gmail.com'],
]
for (const [label, options, file, badge] of BADGES) {
  test(`account badge: ${label}`, { options: options as never }, async ($, on) => {
    const w = world(on, {}, 0, { HOME: '/Users/t' })
    w.files['/Users/t/.claude.json'] = file
    await job($, w, 'go', 0.01)
    await shows(band($), exactly(badge))
    await shows(pane($), exactly(badge))
    const ui = await band($)
    const found = await ui.find({ type: 'Text', text: exactly(badge) })
    expect(found?.props.color).toBe(badge.startsWith('[Side]') ? 'claude' : badge.startsWith('[WORK]') ? 'warning' : undefined)
    expect(found?.props.dimColor).toBe(!badge.startsWith('['))
    await ui.unmount()
  })
}

const FALLBACKS: Array<[string, Record<string, string>, Record<string, string>, string]> = [
  ['an organization only', { HOME: '/Users/t' }, { '/Users/t/.claude.json': account(null, 'Acme') }, 'Acme'],
  ['no file under $CLAUDE_CONFIG_DIR', { CLAUDE_CONFIG_DIR: '/Users/t/.claude-work/', HOME: '/Users/t' }, {}, '~/.claude-work'],
  ['a broken file', { HOME: '/Users/t' }, { '/Users/t/.claude.json': '{ not json' }, '~/.claude'],
  ['no environment', {}, {}, '~/.claude'],
  ['a config dir outside home', { CLAUDE_CONFIG_DIR: '/opt/cc/conf', HOME: '/Users/t' }, {}, 'conf'],
]
for (const [label, env, files, badge] of FALLBACKS) {
  test(`account badge falls back: ${label}`, { options: LABELS }, async ($, on) => {
    const w = world(on, {}, 0, env)
    Object.assign(w.files, files)
    await job($, w, 'go', 0.01)
    await shows(band($), exactly(badge), /^≈\$0\.01$/)
    await shows(pane($), exactly(badge), /Session total ≈\$0\.01/)
    expect(record(w)).toMatchObject({ cost: 0.01 })
  })
}

test('the account file is read once, and the account is never saved', { options: LABELS }, async ($, on) => {
  const w = world(on, {}, 0, { HOME: '/Users/t' })
  w.files['/Users/t/.claude.json'] = account('you@gmail.com')
  await job($, w, 'one', 0.01)
  await job($, w, 'two', 0.02)
  w.sid = 's2'
  w.cost = 0
  await job($, w, 'three', 0.03)
  expect(w.reads).toBe(1)
  await shows(band($), exactly('[PERSONAL] you@gmail.com'))
  expect(JSON.stringify([...w.store.values()])).not.toContain('gmail')
})

test('showAccount off hides the badge everywhere', { options: { ...LABELS, showAccount: false } }, async ($, on) => {
  const w = world(on, {}, 0, { HOME: '/Users/t' })
  w.files['/Users/t/.claude.json'] = account('you@gmail.com')
  await job($, w, 'go', 0.01)
  await hidden(band($), /gmail|PERSONAL/)
  await hidden(pane($), /gmail|PERSONAL/)
  await fits($, w)
})

for (const showAccount of [true, false]) {
  test(`the panel fits with the badge, a budget bar and limits (showAccount ${showAccount})`, { options: { ...LABELS, showAccount } }, async ($, on) => {
    const w = world(on, {}, 0, { HOME: '/Users/t' })
    w.files['/Users/t/.claude.json'] = account('you@gmail.com')
    w.limits = [five(30), { kind: 'seven_day', percentUsed: 11 }]
    w.agents = [{ id: 'a1', description: '', type: 'coder', status: 'running' }]
    await prompt($, 'go')
    await start($, 'm')
    w.cost = 0.10
    await step($, w, 'm', 1_000, 0)
    await fits($, w)
    await radarCmd($, 'budget 1')
    await start($, 'h1', 'a1')
    await fits($, w)
    await complete($, 'h1', 'a1')
    await complete($, 'm')
    await fits($, w)
  })
}

test('thinking time between prompts is not working time, nor what a limit rose meanwhile', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.limits = [five(40)]
  await prompt($, 'first')
  await start($, 'm')
  const pct = await climb(w, 40, 1, 90)
  await complete($, 'm')
  // 30 s of thinking (under the 1-minute gap) while another session used 5 points
  w.limits = [five(pct + 5)]
  await w.clock.advance(30_000)
  await prompt($, 'second')
  await start($, 'm')
  await climb(w, pct + 5, 1, 90)
  await w.clock.advance(5_000)
  // 6 points in ~3 minutes of work: ~23m left (with the 5 points it would be ~13m)
  await shows(band($), /^ · ~2\dm left$/)
})

test('a reading at the same moment as the last one still counts its rise', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  w.limits = [five(40)]
  await prompt($, 'go')
  await start($, 'm')
  let pct = 40
  for (let s = 0; s < 190; s += 30) {
    // while the poll waits for the agent list, a step reads the limits at the same moment,
    // then the limit moves: the poll's reading (gap 0) carries the rise
    const at = pct
    w.onList = async () => {
      await step($, w, 'm', 1_000, 0)
      w.limits = [five(at + 1)]
    }
    await w.clock.advance(30_000)
    pct += 1
  }
  await w.clock.advance(10_000)
  await shows(band($), /~\d+m left/)
})

test('an open panel resizes when the budget bar comes and goes', async ($, on) => {
  const w = world(on)
  await job($, w, 'go', 0.10)
  // not open yet: setting a budget doesn't open it
  await radarCmd($, 'budget 1')
  expect(w.opened.length).toBe(0)
  await radarCmd($, 'budget off')
  await radar($)
  const opened = w.opened.length
  const sized = async () => {
    const ui: any = await pane($)
    expect(w.opened.at(-1)).toBe(height(await ui.drawn()))
    await ui.unmount()
  }
  await radarCmd($, 'budget 1')
  expect(w.opened.length).toBe(opened + 1)
  await sized()
  // a new amount: same height, no resize
  await radarCmd($, 'budget 2')
  expect(w.opened.length).toBe(opened + 1)
  await radarCmd($, 'budget off')
  expect(w.opened.length).toBe(opened + 2)
  await sized()
})

// ════════════════════════════════════════════════════════════════════════════
// 2.3.0: the spend limit in dollars, read from Anthropic once a minute
// ════════════════════════════════════════════════════════════════════════════
const SPEND_URL = 'https://api.anthropic.com/api/oauth/usage'

// Anthropic's usage answer for an account with a spend limit: amounts in cents
const SPEND = (used: number, cap: number) => ({
  five_hour: null,
  seven_day: null,
  limits: [],
  spend: {
    enabled: true,
    used: { amount_minor: used, exponent: 2, currency: 'USD' },
    limit: { amount_minor: cap, exponent: 2, currency: 'USD' },
    percent: Math.round((used / cap) * 100),
    severity: 'warning',
  },
  extra_usage: { is_enabled: true, monthly_limit: cap, used_credits: used, utilization: (used / cap) * 100, currency: 'USD', decimal_places: 2 },
})
const ok = (text: string) => ({ status: 200, ok: true, text })
// a claude login, and Anthropic answering `body`
const spendOn = (w: World, body: unknown) => {
  w.auth = { handle: 'h', kind: 'bearer' }
  w.reply = ok(JSON.stringify(body))
}
const begin = async ($: Engine, w: World) => {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await w.clock.advance(0)
}
const measure = ($: Engine, limits: Array<Record<string, unknown>>) =>
  $.session.measure({ context: { window: 200_000, percent: 10 }, rateLimits: limits, changed: ['rateLimits'] } as never)
const seven = (pct: number) => ({ kind: 'seven_day', percentUsed: pct })
// The band's meter labels, in order
const labels = async ($: Engine) => {
  const ui = await band($)
  const found = (await ui.findAll({ type: 'Text', text: /^(Spend|5h limit|Weekly|Context) $/ })).map(t => t.text.trim())
  await ui.unmount()
  return found
}

test('the dollar spend limit comes first, with no reset time of its own', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /^Spend/, /\$88\.40 used · \$11\.60 left of \$100/, /88%/)
  await hidden(pane($), /resets in/)
  await shows(band($), /^Spend $/, /88%/)
  await hidden(band($), /\$88/)
  expect(w.fetches[0].url).toBe(SPEND_URL)
  expect(w.fetches[0].init.auth).toBe('h')
  expect(w.fetches[0].init.headers['anthropic-beta']).toBe('oauth-2025-04-20')
})

test('Spend comes before the 5h limit, Weekly and Context', async ($, on) => {
  const w = world(on)
  w.limits = [five(30), seven(11)]
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  expect(await labels($)).toEqual(['Spend', '5h limit', 'Weekly', 'Context'])
})

test('the dollars and Claude Code\'s own spend_limit are one Spend row, with its reset', async ($, on) => {
  const w = world(on)
  const resetsAt = new Date((8 * 24 + 14) * 3600_000 + 10 * 60_000).toISOString()
  w.limits = [{ kind: 'spend_limit', percentUsed: 87, resetsAt }]
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  const ui = await pane($)
  expect((await ui.findAll({ type: 'Text', text: /^Spend/ })).length).toBe(1)
  await ui.unmount()
  await shows(pane($), /\$88\.40 used/, /88%/, /resets in 8d 14h/)
  // 96%: from the next check, and Claude Code's own reading after it: one ⛔
  spendOn(w, SPEND(9600, 10000))
  await w.clock.advance(60_000)
  await measure($, [{ kind: 'spend_limit', percentUsed: 96, resetsAt }])
  expect(w.toasts.filter(t => /^⛔ Spend 96% used/.test(t)).length).toBe(1)
  expect(w.toasts.filter(t => /^⛔ Spend/.test(t)).length).toBe(1)
})

test('without Claude Code\'s spend_limit, the Spend row has no reset time', async ($, on) => {
  const w = world(on)
  w.limits = [seven(11)]
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /^Spend/, /^Weekly/)
  await hidden(pane($), /resets in/)
})

const NO_SPEND: Array<[string, (w: World) => void, number]> = [
  ['no login', w => { w.auth = null }, 0],
  ['an API key', w => { w.auth = { handle: 'h', kind: 'api-key' } }, 0],
  ['the request is refused', w => { w.auth = { handle: 'h', kind: 'bearer' }; w.reply = 'deny' }, 1],
  ['the request throws', w => { w.auth = { handle: 'h', kind: 'bearer' }; w.reply = 'throw' }, 1],
  ['a 401', w => { w.auth = { handle: 'h', kind: 'bearer' }; w.reply = { status: 401, ok: false, text: '{"error":"unauthorized"}' } }, 1],
  ['an answer that is not JSON', w => { w.auth = { handle: 'h', kind: 'bearer' }; w.reply = ok('not json') }, 1],
  ['no spend block', w => spendOn(w, { five_hour: null, seven_day: null, spend: null, extra_usage: null }), 1],
  ['both turned off', w => spendOn(w, { spend: { ...SPEND(1, 2).spend, enabled: false }, extra_usage: { ...SPEND(1, 2).extra_usage, is_enabled: false } }), 1],
  ['garbage amounts', w => spendOn(w, {
    spend: { enabled: true, used: { amount_minor: 'lots', exponent: 2 }, limit: { amount_minor: 0, exponent: 2 } },
    extra_usage: { is_enabled: true, monthly_limit: -5, used_credits: 1, decimal_places: 99 },
  }), 1],
  ['authorize throws', w => { w.auth = 'throw' }, 0],
]
for (const [label, set, requests] of NO_SPEND) {
  test(`no dollar row, just the plan limits: ${label}`, async ($, on) => {
    const w = world(on)
    w.limits = [five(30), seven(11)]
    set(w)
    await begin($, w)
    await job($, w, 'go', 0.01)
    await measure($, [five(30), seven(11)])
    await w.clock.advance(120_000)
    expect(w.toasts).toEqual([])
    expect(w.authorized).toBeGreaterThan(0)
    if (requests === 0) expect(w.fetches.length).toBe(0)
    else expect(w.fetches.length).toBeGreaterThan(0)
    await shows(pane($), /^5h limit/, /^Weekly/)
    await hidden(pane($), /^Spend/, /left of/)
    await fits($, w)
  })
}

test('an account without a spend limit but with extra usage reads it from extra_usage', async ($, on) => {
  const w = world(on)
  spendOn(w, { spend: null, extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 12000, decimal_places: 2, currency: 'USD' } })
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$120 used · \$80 left of \$200/, /^60%$/)
})

test('over the limit: how much over, and ⛔', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(10270, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$102\.70 used · \$2\.70 over \$100/, /^103% ⛔$/)
})

test('a failed check keeps the last reading; the third in a row drops it', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$88\.40/)
  const toasts = w.toasts.length
  w.reply = { status: 500, ok: false, text: '' }
  await w.clock.advance(60_000)
  await shows(pane($), /\$88\.40/)
  await w.clock.advance(60_000)
  await shows(pane($), /\$88\.40/)
  // a good answer in between starts the count over
  spendOn(w, SPEND(8840, 10000))
  await w.clock.advance(60_000)
  w.reply = { status: 500, ok: false, text: '' }
  await w.clock.advance(60_000)
  await w.clock.advance(60_000)
  await shows(pane($), /\$88\.40/)
  // the third failure in a row
  await w.clock.advance(60_000)
  await hidden(pane($), /^Spend/, /\$88\.40/)
  expect(w.toasts.length).toBe(toasts)
})

test('an answer without a spend limit drops the last reading at once', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$88\.40/)
  spendOn(w, { spend: null, extra_usage: null })
  await w.clock.advance(60_000)
  await hidden(pane($), /^Spend/, /\$88\.40/)
})

test('the spend limit is read once a minute, also while idle', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  expect(w.fetches.length).toBe(1)
  await prompt($, 'go')
  await start($, 'm')
  for (let i = 0; i < 3; i++) await measure($, [])
  await complete($, 'm')
  await w.clock.advance(59_000)
  expect(w.fetches.length).toBe(1)
  await w.clock.advance(1_000)
  expect(w.fetches.length).toBe(2)
  await w.clock.advance(180_000)
  expect(w.fetches.length).toBe(5)
})

test('an event check off the minute grid moves the next one: never two within a minute', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await w.clock.advance(60_000)
  expect(w.fetches.length).toBe(2)
  // a second after the tick: too soon
  await w.clock.advance(1_000)
  await measure($, [])
  await w.clock.advance(0)
  expect(w.fetches.length).toBe(2)
  // 56 s after the tick an event checks, off the minute grid
  await w.clock.advance(55_000)
  await measure($, [])
  await w.clock.advance(0)
  expect(w.fetches.length).toBe(3)
  // so the tick 4 s later is skipped, and the one after checks
  await w.clock.advance(4_000)
  expect(w.fetches.length).toBe(3)
  await w.clock.advance(60_000)
  expect(w.fetches.length).toBe(4)
})

test('a busy session still checks about once a minute, never twice within 55 s', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await prompt($, 'go')
  await start($, 'm')
  for (let t = 0; t < 6 * 60_000; t += 7_000) {
    await w.clock.advance(7_000)
    await measure($, [])
    if (t % 21_000 === 0) await prompt($, 'more')
  }
  await w.clock.advance(0)
  const gaps = w.fetchedAt.slice(1).map((at, i) => at - (w.fetchedAt[i] ?? 0))
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(55_000)
  expect(w.fetches.length).toBeGreaterThanOrEqual(6)
})

test('a tick a few seconds early after an off-grid check still checks every minute', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  w.surfaces = []
  await begin($, w)
  // the first check happens 3 s in, so each tick lands 3 s "early" against it
  w.surfaces = ['terminal']
  await w.clock.advance(3_000)
  await measure($, [])
  await w.clock.advance(0)
  expect(w.fetches.length).toBe(1)
  await w.clock.advance(57_000)
  expect(w.fetches.length).toBe(2)
  await w.clock.advance(60_000)
  expect(w.fetches.length).toBe(3)
})

test('a check that never answers stops holding the next one back after 5 minutes', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  w.hold = new Promise(() => {})
  await begin($, w)
  w.hold = null
  await w.clock.advance(240_000)
  expect(w.fetches.length).toBe(1)
  await w.clock.advance(60_000)
  expect(w.fetches.length).toBe(2)
  await shows(pane($), /\$88\.40/)
})

test('a late answer of an older check does not overwrite a newer reading', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  let land = () => {}
  w.hold = new Promise(r => { land = r })
  await begin($, w)
  w.hold = null
  // 5 minutes on, a new check reads $20
  spendOn(w, SPEND(2000, 10000))
  await w.clock.advance(300_000)
  await shows(pane($), /\$20 used/)
  // the stuck one's $88.40 lands now: dropped
  land()
  await w.clock.advance(0)
  await shows(pane($), /\$20 used/)
  await hidden(pane($), /\$88\.40/)
})

test('a -p run makes no request', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  w.surfaces = []
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await job($, w, 'go', 0.01)
  await measure($, [])
  await w.clock.advance(120_000)
  expect(w.authorized).toBe(0)
  expect(w.fetches.length).toBe(0)
})

test('an SDK session reads the spend limit once a client attaches', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  w.surfaces = []
  await $.session.start({ cwd: '/', surface: null, isInteractive: false } as never)
  await job($, w, 'go', 0.01)
  await w.clock.advance(60_000)
  expect(w.fetches.length).toBe(0)
  // a client attaches: the next tick reads it
  w.surfaces = ['desktop']
  await w.clock.advance(60_000)
  expect(w.fetches.length).toBe(1)
  await shows(pane($), /\$88\.40 used/)
})

test('another currency and exponent', async ($, on) => {
  const w = world(on)
  spendOn(w, {
    spend: {
      enabled: true,
      used: { amount_minor: 88, exponent: 0, currency: 'EUR' },
      limit: { amount_minor: 100, exponent: 0, currency: 'EUR' },
    },
    extra_usage: null,
  })
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /88 EUR used · 12 EUR left of 100 EUR/, /^88% ⚠$/)
})

test('the Spend row with a forecast still fits on one line', { timeoutMs: 30_000 }, async ($, on) => {
  const w = world(on)
  const engine = (pct: number) => ({ kind: 'spend_limit', percentUsed: pct, resetsAt: new Date(3 * 3600_000).toISOString() })
  w.limits = [engine(40)]
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await prompt($, 'go')
  await start($, 'm')
  await climb(w, 40, 1, 180, engine)
  await w.clock.advance(10_000)
  const ui = await pane($)
  const line = await ui.find({ type: 'Text', text: /^Spend/ })
  const level = await ui.find({ type: 'Text', text: /^88% ⚠$/ })
  expect(line?.text).toMatch(/at this pace$/)
  expect(line?.text).toMatch(/\$88/)
  // the pane's width: bodyColumns 60 - 2; the label side and the percent side, one space apart
  expect((line?.text.length ?? 99) + 1 + (level?.text.length ?? 99)).toBeLessThanOrEqual(58)
  await ui.unmount()
})

test('an open panel shrinks when the Spend row goes', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await radar($)
  const opened = w.opened.length
  spendOn(w, { spend: null, extra_usage: null })
  await w.clock.advance(60_000)
  expect(w.opened.length).toBe(opened + 1)
  const ui: any = await pane($)
  expect(w.opened.at(-1)).toBe(height(await ui.drawn()))
  await ui.unmount()
})

test('the end of the session stops the checks', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  const fetches = w.fetches.length
  await $.session.end({ sessionId: 's1', reason: 'other' } as never)
  await w.clock.advance(300_000)
  expect(w.fetches.length).toBe(fetches)
})

test('showSpend off: no request at all', { options: { showSpend: false } }, async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await w.clock.advance(120_000)
  expect(w.authorized).toBe(0)
  expect(w.fetches.length).toBe(0)
  await hidden(pane($), /left of/)
})

test('a personal account: no Spend row, the 5h and weekly limits as before', async ($, on) => {
  const w = world(on)
  w.limits = [five(30), seven(11)]
  spendOn(w, {
    five_hour: { utilization: 30, resets_at: new Date(3 * 3600_000).toISOString() },
    seven_day: { utilization: 11, resets_at: null },
    spend: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
  })
  await begin($, w)
  await job($, w, 'go', 0.01)
  expect(await labels($)).toEqual(['5h limit', 'Weekly', 'Context'])
  await hidden(pane($), /^Spend/)
  await fits($, w)
})

test('an open panel grows when the Spend row first appears', async ($, on) => {
  const w = world(on)
  await begin($, w)
  await job($, w, 'go', 0.01)
  await radar($)
  const opened = w.opened.length
  spendOn(w, SPEND(8840, 10000))
  await w.clock.advance(60_000)
  expect(w.opened.length).toBe(opened + 1)
  const ui: any = await pane($)
  expect(w.opened.at(-1)).toBe(height(await ui.drawn()))
  await ui.unmount()
})

test('the dollars are never saved', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$88\.40/)
  const saved = JSON.stringify([...w.store.entries()])
  expect(saved).not.toContain('88.4')
  expect(saved).not.toContain('spend')
})

test('Spend past 80% warns once', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8100, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  expect(w.toasts.filter(t => /Spend/.test(t))).toEqual(['⚠ Spend 81% used'])
  await w.clock.advance(60_000)
  await measure($, [{ kind: 'spend_limit', percentUsed: 82 }])
  expect(w.toasts.filter(t => /Spend/.test(t))).toEqual(['⚠ Spend 81% used'])
})

// ── Another login drops the reading at once ────────────────────────────
for (const [label, auth] of [['no claude login', null], ['an API key', { handle: 'k', kind: 'api-key' }]] as const) {
  test(`switching to ${label} drops the Spend row at the next check`, async ($, on) => {
    const w = world(on)
    spendOn(w, SPEND(8840, 10000))
    await begin($, w)
    await job($, w, 'go', 0.01)
    await shows(pane($), /\$88\.40/)
    const toasts = w.toasts.length
    w.auth = auth
    await w.clock.advance(60_000)
    await hidden(pane($), /^Spend/, /\$88\.40/)
    expect(w.toasts.length).toBe(toasts)
  })
}

test('another account drops the old dollars before the new ones come', async ($, on) => {
  const w = world(on, {}, 0, { HOME: '/Users/t' })
  w.files['/Users/t/.claude.json'] = account('me@work.example.com', 'Work Co')
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$88\.40/)
  // /login as someone else; the next check's answer is slow
  w.files['/Users/t/.claude.json'] = account('me@gmail.com')
  spendOn(w, SPEND(2000, 10000))
  let land = () => {}
  w.hold = new Promise(r => { land = r })
  await w.clock.advance(60_000)
  w.hold = null
  await hidden(pane($), /^Spend/, /\$88\.40/)
  land()
  await w.clock.advance(0)
  await shows(pane($), /\$20 used/)
})

test('an answer on its way when the account changes is dropped', async ($, on) => {
  const w = world(on, {}, 0, { HOME: '/Users/t' })
  w.files['/Users/t/.claude.json'] = account('me@work.example.com', 'Work Co')
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  await shows(pane($), /\$88\.40/)
  // a check under the old account, slow; the old account's answer would be $40
  spendOn(w, SPEND(4000, 10000))
  let land = () => {}
  w.hold = new Promise(r => { land = r })
  await w.clock.advance(60_000)
  w.hold = null
  // meanwhile, /login as someone else
  w.files['/Users/t/.claude.json'] = account('me@gmail.com')
  spendOn(w, SPEND(2000, 10000))
  land()
  await w.clock.advance(0)
  await hidden(pane($), /^Spend/, /\$40/, /\$88\.40/)
  // the next tick reads the new account
  await w.clock.advance(60_000)
  await shows(pane($), /\$20 used/)
})

test('asking for the login failing keeps the last reading like any failed check', async ($, on) => {
  const w = world(on)
  spendOn(w, SPEND(8840, 10000))
  await begin($, w)
  await job($, w, 'go', 0.01)
  const toasts = w.toasts.length
  w.auth = 'throw'
  await w.clock.advance(60_000)
  await w.clock.advance(60_000)
  await shows(pane($), /\$88\.40/)
  await w.clock.advance(60_000)
  await hidden(pane($), /^Spend/)
  expect(w.toasts.length).toBe(toasts)
})
