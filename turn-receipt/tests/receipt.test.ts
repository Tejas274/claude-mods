import { expect, mock, test } from 'claude-code/testing'

const usage = (input: number, output: number, cacheRead = 0) => ({
  model: 'claude-sonnet-5',
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0,
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`prints an itemized receipt on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    let cost = 1.0
    let nextUsage: unknown = null
    const toasts: string[] = []
    const copies: string[] = []
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: cost } } }) as never)
    on('agent.list', () => ({ value: [{ id: 'a1', description: 'Explore hooks', type: 'Explore', status: 'running' }] }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('ui.toast', ($: any, e: any) => { toasts.push(e.text); return { value: undefined } as never })
    on('ui.copy', ($: any, e: any) => { copies.push(e.text); return { value: {} } as never })
    on('command.register', () => ({ value: {} }) as never)
    on('prompt.submit', ($: any, e: any) => ({ text: e.text }) as never)
    on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }) as never)
    on('turn.complete', () => ({ text: '' }) as never)
    on('turn.step', async function* (_$: any, e: any) { return { turnId: e.turnId, index: e.index, usage: nextUsage, stopReason: 'end_turn', answer: '', toolUses: [] } } as never)
    // tools: Bash takes 8s, Read returns a big file
    on('tool.call', async ($: any, e: any) => {
      if (e.tool === 'Bash') { await clock.advance(8000); return { result: { stdout: 'ok' } } as never }
      if (e.tool === 'Agent') { await clock.advance(20000); return { result: {} } as never }
      if (e.tool === 'Read') { await clock.advance(1000); return { result: { content: 'x'.repeat(40_000) } } as never }
      return { result: {} } as never
    })

    await $.prompt.submit({ text: 'explain   what this project does' } as never)
    await $.turn.start({ turnId: 't1', text: 'go' } as never)
    cost = 1.08; nextUsage = usage(20_000, 2_000, 60_000)
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5', messageCount: 1 } as never)) { }

    await $.turn.start({ turnId: 't2', text: 'explore', agentId: 'a1' } as never)
    cost = 1.21; nextUsage = usage(10_000, 1_000, 30_000)
    for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5', messageCount: 1, agentId: 'a1' } as never)) { }

    await $.tool.call({ tool: 'Bash', command: 'npm test' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/repo/src/big.json' } as never)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' } as never)
    // launching a helper is slow but isn't "work"; the handback step is hidden
    await $.tool.call({ tool: 'Agent', description: 'Explore hooks', prompt: 'x', __slow: true } as never)
    await $.tool.call({ tool: 'SubagentHandback' } as never)

    // main ends first: no receipt yet, the helper still works
    await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
    expect(toasts.length).toBe(0)
    // helper ends: receipt printed
    await $.turn.complete({ turnId: 't2', answer: '', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'a1' } as never)
    expect(toasts.length).toBe(1)
    expect(toasts[0]).toContain('🧾 Receipt #1')
    expect(toasts[0]).toContain('4 steps')
    expect(toasts[0]).toContain('2 agents')
    expect(toasts[0]).toContain('≈$0.21')

    // /receipt copy → the text receipt
    const copied = await $.command.run({ command: 'receipt', args: 'copy' } as never)
    expect((copied as any).text).toContain('copied')
    const text = copies[0] ?? ''
    expect(text).toContain('CLAUDE CODE RECEIPT')
    expect(text).toContain('“explain what this project does”')
    expect(text).toMatch(/Main · Sonnet 5/)
    expect(text).toMatch(/Explore hooks · Sonnet 5/)
    expect(text).toMatch(/🐢 Slowest  Bash: npm test\s+0:08/)
    expect(text).toMatch(/🐘 Biggest  Read: src\/big.json\s+10k tok/)
    expect(text).toMatch(/Files changed\s+1/)
    expect(text).toMatch(/Cache hit\s+75%/)
    expect(text).toMatch(/TOTAL  0:29 · 4 steps\s+≈\$0.21/)
    expect(text).not.toContain('SubagentHandback')

    // the panel draws the same receipt
    const pane = await $.ui.mount({
      plugin: 'turn-receipt', surface, component: 'Pane', requestId: 'turn-receipt',
      props: { title: 'Receipt', isFocused: false, bodyColumns: 50 } as never,
    })
    expect(await pane.find({ type: 'Text', text: /CLAUDE CODE RECEIPT/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Thank you for coding with Claude/ })).toBeDefined()
    await pane.unmount()
    if (surface === 'terminal') console.log('\n' + text + '\n')
  })
}
