import { expect, mock, test } from 'claude-code/testing'

const usage = (input: number, output: number) => ({
  model: 'claude-opus-5-5',
  input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`band and agents pane on ${surface}`, async ($, on) => {
    // what the engine would answer, beneath the mod
    const clock = mock.clock(on)
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
