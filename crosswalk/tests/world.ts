import { expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// ════════════════════════════════════════════════════════════════════════════
// One mocked world beneath the mod: git and gh behind $.process.run, the file system, the
// store, toasts and the session. Every test drives it through `w`.
// ════════════════════════════════════════════════════════════════════════════

export const NOW = Date.parse('2026-11-12T12:00:00Z')
export const HOUR = 3600_000
export const MIN = 60_000

// One PR as gh pr list --json answers it
export const pr = (number: number, files: string[], extra: Record<string, unknown> = {}) => ({
  number,
  title: `Title ${number}`,
  author: { login: 'alice' },
  headRefName: `branch-${number}`,
  isCrossRepository: false,
  updatedAt: new Date(NOW - 2 * HOUR).toISOString(),
  files: files.map(path => ({ path, additions: 1, deletions: 0 })),
  changedFiles: files.length,
  ...extra,
})

type Reply = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean }

export const world = (on: any) => {
  const w = {
    clock: mock.clock(on, { now: NOW }),
    store: new Map<string, unknown>(),
    /** every argv $.process.run got, with its init */
    calls: [] as { argv: string[]; init: any; at: number }[],
    toasts: [] as string[],
    surfaces: ['terminal'] as string[],
    cwd: '/repo',
    top: '/repo',
    remotes: ['origin'],
    url: 'https://github.com/acme/app.git',
    ignorecase: false,
    branch: 'feature/x' as string | null,
    /** submodule paths in .gitmodules (null: no .gitmodules) */
    submodules: null as null | string[],
    originHead: 'refs/remotes/origin/main' as string | null,
    mergeBase: 'a'.repeat(40),
    diff: [] as string[],
    status: '',
    prs: [] as unknown[],
    /** what gh pr list answers instead of the PRs (or 'throw': gh missing) */
    list: null as null | 'throw' | Reply,
    /** gh is not installed at all */
    ghMissing: false,
    me: 'me',
    /** gh api user fails */
    meFails: false,
    /** branch.<name>.merge per branch (gh pr checkout sets refs/pull/<n>/head) */
    merge: {} as Record<string, string>,
    /** a second GitHub repo beside the main one, with its own PRs */
    other: { top: '/other', url: 'https://github.com/acme/other.git', prs: [] as unknown[] },
    /** what the next gh pr list waits for */
    ghHold: null as null | Promise<void>,
    /** symbolic links: a path and where it really lands */
    links: {} as Record<string, string>,
    /** every $.fs.stat fails */
    statBroken: false,
    /** paths that don't exist (yet) */
    absent: new Set<string>(),
    registers: 0,
    /** what reached the tool beneath the mod */
    tools: [] as any[],
  }
  const reply = (r: Reply = {}) =>
    ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...r } }) as never
  const ok = (stdout = '') => reply({ stdout })
  const fail = (exitCode = 1, stderr = 'fatal') => reply({ exitCode, stderr })

  on('process.run', async (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    w.calls.push({ argv, init: e.init, at: w.clock.now() })
    const [bin, ...a] = argv
    const s = a.join(' ')
    const cwd: string = e.init?.cwd ?? ''
    // which repo the call runs in: the main one, the other one, or one of /many/r<n> (no PRs)
    const under = (top: string) => cwd === top || cwd.startsWith(`${top}/`)
    const many = /^\/many\/r\d+/.exec(cwd)?.[0]
    const repo = under(w.top)
      ? { top: w.top, url: w.url, prs: w.prs }
      : under(w.other.top)
        ? w.other
        : many
          ? { top: many, url: `https://github.com/acme/${many.slice(6)}.git`, prs: [] }
          : null
    if (bin === 'gh') {
      if (w.ghMissing) throw new Error('spawn gh ENOENT')
      if (a[0] === 'api' && a[1] === 'user') return w.meFails ? fail(1) : ok(`${w.me}\n`)
      if (a[0] === 'pr' && a[1] === 'list') {
        // what this call answers is fixed when it starts; a hold is this call's alone
        const hold = w.ghHold
        const list = w.list
        const prs = JSON.stringify(repo?.prs ?? [])
        w.ghHold = null
        if (hold) await hold
        if (list === 'throw') throw new Error('spawn gh ENOENT')
        if (list) return reply(list)
        return ok(prs)
      }
      return fail()
    }
    if (bin !== 'git') return fail(127)
    if (s === 'rev-parse --show-toplevel') return repo ? ok(`${repo.top}\n`) : fail(128)
    if (s === 'remote') return ok((repo?.top === w.top ? w.remotes : ['origin']).map(r => `${r}\n`).join(''))
    if (a[0] === 'remote' && a[1] === 'get-url') return ok(`${repo?.url ?? ''}\n`)
    if (s === 'config --get core.ignorecase') return w.ignorecase ? ok('true\n') : fail(1, '')
    if (s === 'symbolic-ref --short -q HEAD') return w.branch ? ok(`${w.branch}\n`) : fail(1, '')
    if (a[0] === 'config' && a[1] === '--get' && a[2]?.startsWith('branch.')) {
      const m = w.merge[a[2].slice(7, -6)]
      return m ? ok(`${m}\n`) : fail(1, '')
    }
    if (a[0] === 'config' && a.includes('.gitmodules'))
      return ok((w.submodules ?? []).map((p, i) => `submodule.s${i}.path\n${p}\0`).join(''))
    if (a[0] === 'symbolic-ref' && a[2] === 'refs/remotes/origin/HEAD') return w.originHead ? ok(`${w.originHead}\n`) : fail(1, '')
    if (a[0] === 'check-ref-format') return /[\s~^:?*[\\\x00-\x1f]|\.\.|@\{/.test(a[1] ?? '') ? fail(1, '') : ok()
    if (a[0] === 'rev-parse' && a[1] === '--verify') return fail(1, '')
    if (a[0] === 'merge-base') return ok(`${w.mergeBase}\n`)
    if (a[0] === 'diff') return ok(w.diff.map(p => `${p}\0`).join(''))
    if (a[0] === 'status') return ok(w.status)
    return fail()
  })
  on('fs.stat', (_$: any, e: any) => {
    const path: string = e.path
    if (w.statBroken) throw new Error('disk on fire')
    if (w.absent.has(path)) throw new Error(`ENOENT: ${path}`)
    const real = w.links[path] ?? path
    return { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: path in w.links, ...(e.resolve && { realPath: real }) } } as never
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path === `${w.top}/.gitmodules` && w.submodules !== null }) as never)
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
  on('session.cwd', () => ({ value: w.cwd }) as never)
  on('session.surfaces', () => ({ value: w.surfaces }) as never)
  on('ui.toast', (_$: any, e: any) => {
    w.toasts.push(e.text)
    return { value: undefined } as never
  })
  on('command.register', () => {
    w.registers++
    return { value: { command: 'crosswalk' } } as never
  })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }) as never)
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }) as never)
  on('classic.SessionStart', () => ({}) as never)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('tool.call', (_$: any, e: any) => {
    w.tools.push(e)
    return { result: {} } as never
  })
  return w
}
export type World = ReturnType<typeof world>

// gh pr list calls so far
export const listCalls = (w: World) => w.calls.filter(c => c.argv[0] === 'gh' && c.argv[1] === 'pr')

// What a session does, step by step
export const begin = async ($: Engine, w: World) => {
  await $.session.start({ cwd: w.cwd, surface: 'terminal', isInteractive: true } as never)
  await w.clock.settle()
}
export const prompt = async ($: Engine, w: World, text = 'go') => {
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
  await w.clock.settle()
}
export const edit = async ($: Engine, w: World, path: string, tool: 'Edit' | 'Write' | 'NotebookEdit' = 'Edit') => {
  const input =
    tool === 'Edit'
      ? { tool, file_path: path, old_string: 'a', new_string: 'b' }
      : tool === 'Write'
        ? { tool, file_path: path, content: 'x' }
        : { tool, notebook_path: path, new_source: 'x' }
  const r = await $.tool.call(input as never)
  await w.clock.settle()
  return r as any
}
export const crosswalk = ($: Engine) =>
  $.command.run({ command: 'crosswalk', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never) as Promise<{
    text?: string
  }>
export const clear = async ($: Engine, w: World) => {
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await $.classic.SessionStart({ source: 'clear' } as never)
  await w.clock.settle()
}

// The band, as drawn
export const band = (
  $: Engine,
  surface: 'terminal' | 'desktop' = 'terminal',
  bodyColumns = 100,
  extra: Record<string, unknown> = {},
) =>
  $.ui.mount({
    plugin: 'crosswalk',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns, ...extra } as never,
  })

// The text a drawn element shows
export const textOf = (el: any): string =>
  typeof el === 'string' || typeof el === 'number' ? String(el) : (el?.children ?? []).map(textOf).join('')

// terminal columns, counted here on their own: marks and control characters 0; emoji and East
// Asian wide letters 2; the rest 1
export const displayWidth = (text: string): number =>
  Array.from(text).reduce((n, c) => {
    if (/[\p{Mn}\p{Me}\p{Cf}\p{Cc}]/u.test(c)) return n
    if (/\p{Emoji_Presentation}/u.test(c)) return n + 2
    if (/[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿＀-｠￠-￦]/u.test(c)) return n + 2
    return n + 1
  }, 0)

// The band's crosswalk line (or undefined when the band shows none), and every line drawn
export const bandLines = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal', bodyColumns = 100) => {
  const ui = await band($, surface, bodyColumns)
  const root: any = await ui.drawn()
  await ui.unmount()
  const kids = root?.type === 'Box' ? (root.children ?? []).filter((c: any) => c && typeof c === 'object') : [root]
  const lines = kids.map(textOf) as string[]
  return { root, lines, line: lines.find(l => l.startsWith('🚸 crosswalk')) }
}

// A world with one PR touching src/app.ts, the session started and the PRs read
export const ready = async ($: Engine, on: any, prs?: unknown[]) => {
  const w = world(on)
  w.prs = prs ?? [pr(14, ['src/app.ts', 'README.md'])]
  await begin($, w)
  expect(listCalls(w).length).toBe(1)
  return w
}
