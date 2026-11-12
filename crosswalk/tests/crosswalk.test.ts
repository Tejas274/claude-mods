import { expect, test } from 'claude-code/testing'

import { HOUR, MIN, NOW, band, bandLines, begin, clear, crosswalk, edit, listCalls, pr, prompt, ready, world } from './world'

const OFF_GH = "gh isn't available or not logged in here"
const OFF_REPO = "this folder isn't a GitHub repository with a single remote, so crosswalk is off here"

// ════════════════════════════════════════════════════════════════════════════
// The band and the toast
// ════════════════════════════════════════════════════════════════════════════
for (const surface of ['terminal', 'desktop'] as const) {
  test(`an edit of a file in an open PR shows the band line on ${surface}`, async ($, on) => {
    const w = await ready($, on)
    expect((await bandLines($, surface)).line).toBeUndefined()
    await edit($, w, '/repo/src/app.ts')
    const { line } = await bandLines($, surface)
    expect(line).toBe("🚸 crosswalk · app.ts is in PR #14 'Title 14' by alice · updated 2h ago")
  })

  test(`the band wraps what draws beneath it on ${surface}`, async ($, on) => {
    on('ui.render', ($: any, e: any) => {
      const { Text } = $.ui.resolve(e)
      return h(Text, null, 'engine below') as never
    })
    const w = await ready($, on)
    expect((await bandLines($, surface)).lines).toEqual(['engine below'])
    await edit($, w, '/repo/src/app.ts')
    const { lines } = await bandLines($, surface)
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(/^🚸 crosswalk · app\.ts is in PR #14/)
    expect(lines[1]).toBe('engine below')
  })

  test(`the band yields to a survey, and goes after 10 minutes, on ${surface}`, async ($, on) => {
    const w = await ready($, on)
    await edit($, w, '/repo/src/app.ts')
    const ui = await band($, surface, 100, { hasSurvey: true })
    expect(await ui.find({ type: 'Text', text: /crosswalk/ })).toBeUndefined()
    await ui.unmount()
    await w.clock.advance(9 * MIN)
    expect((await bandLines($, surface)).line).toBeDefined()
    await w.clock.advance(2 * MIN)
    expect((await bandLines($, surface)).line).toBeUndefined()
  })
}

test('several PRs on one file: the newest first, the rest counted', async ($, on) => {
  const w = await ready($, on, [
    pr(14, ['src/app.ts']),
    pr(22, ['src/app.ts'], { author: { login: 'bob' }, title: 'Newer', updatedAt: new Date(NOW - 5 * MIN).toISOString() }),
  ])
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBe("🚸 crosswalk · app.ts is in PR #22 'Newer' by bob · updated 5m ago (+1 more)")
})

test('a Write of a new file resolves its folder', async ($, on) => {
  const w = await ready($, on, [pr(7, ['src/new.ts'])])
  // the file isn't there yet, and its folder is reached through a link
  w.absent.add('/alias/src/new.ts')
  w.links['/alias/src'] = '/repo/src'
  await edit($, w, '/alias/src/new.ts', 'Write')
  expect((await bandLines($)).line).toMatch(/new\.ts is in PR #7/)
})

test('a NotebookEdit is matched by its notebook_path', async ($, on) => {
  const w = await ready($, on, [pr(9, ['nb/analysis.ipynb'])])
  await edit($, w, '/repo/nb/analysis.ipynb', 'NotebookEdit')
  expect((await bandLines($)).line).toMatch(/analysis\.ipynb is in PR #9/)
})

test('an edit is never blocked: it reaches the tool as it came', async ($, on) => {
  const w = await ready($, on)
  const r = await edit($, w, '/repo/src/app.ts')
  expect(r.deny).toBeUndefined()
  expect(w.tools.length).toBe(1)
  expect(w.tools[0]).toMatchObject({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  // a file in no PR goes through too, and so does one outside any repo
  await edit($, w, '/repo/src/other.ts')
  await edit($, w, '/elsewhere/x.ts')
  expect(w.tools.length).toBe(3)
})

test('one toast per file and PR', async ($, on) => {
  const w = await ready($, on, [pr(14, ['src/app.ts', 'README.md']), pr(22, ['src/app.ts'], { author: { login: 'bob' } })])
  await edit($, w, '/repo/src/app.ts')
  expect(w.toasts.length).toBe(2)
  expect(w.toasts.some(t => t.includes('src/app.ts is also changed in PR #14') && t.includes('by alice'))).toBe(true)
  expect(w.toasts.some(t => t.includes('PR #22'))).toBe(true)
  await edit($, w, '/repo/src/app.ts')
  expect(w.toasts.length).toBe(2)
  await edit($, w, '/repo/README.md')
  expect(w.toasts.length).toBe(3)
})

// ════════════════════════════════════════════════════════════════════════════
// Which PRs count
// ════════════════════════════════════════════════════════════════════════════
test("my branch's own PR is skipped, a fork's PR of the same branch name is not", async ($, on) => {
  const w = await ready($, on, [
    pr(1, ['a.ts'], { headRefName: 'feature/x' }),
    pr(2, ['a.ts'], { headRefName: 'feature/x', isCrossRepository: true, author: { login: 'forker' } }),
  ])
  await edit($, w, '/repo/a.ts')
  const { line } = await bandLines($)
  expect(line).toMatch(/PR #2 'Title 2' by forker/)
  expect(line).not.toMatch(/more/)
})

test('my own PRs are skipped by default', async ($, on) => {
  const w = await ready($, on, [pr(3, ['a.ts'], { author: { login: 'ME' } })])
  await edit($, w, '/repo/a.ts')
  expect((await bandLines($)).line).toBeUndefined()
  expect(w.toasts.length).toBe(0)
})

test('includeMine shows my own PRs too', { options: { includeMine: true } }, async ($, on) => {
  const w = await ready($, on, [pr(3, ['a.ts'], { author: { login: 'me' } })])
  await edit($, w, '/repo/a.ts')
  expect((await bandLines($)).line).toMatch(/PR #3 'Title 3' by me/)
  // no need to ask who I am
  expect(w.calls.some(c => c.argv[0] === 'gh' && c.argv[1] === 'api')).toBe(false)
})

test('showTitles and showAuthors off hide them', { options: { showTitles: false, showAuthors: false } }, async ($, on) => {
  const w = await ready($, on)
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBe('🚸 crosswalk · app.ts is in PR #14 · updated 2h ago')
  expect(w.toasts[0]).not.toMatch(/Title|alice/)
  w.diff = ['src/app.ts']
  expect((await crosswalk($)).text).toMatch(/^src\/app\.ts — #14$/m)
})

test('a repo that ignores case matches paths whatever their case', async ($, on) => {
  const w = world(on)
  w.ignorecase = true
  w.prs = [pr(5, ['Src/App.ts'])]
  await begin($, w)
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toMatch(/app\.ts is in PR #5/)
})

test('a repo that minds case does not', async ($, on) => {
  const w = await ready($, on, [pr(5, ['Src/App.ts'])])
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBeUndefined()
})

test('a file in a submodule is skipped', async ($, on) => {
  const w = world(on)
  w.submodules = ['vendor/lib']
  w.prs = [pr(6, ['vendor/lib/x.ts', 'src/app.ts'])]
  await begin($, w)
  await edit($, w, '/repo/vendor/lib/x.ts')
  expect((await bandLines($)).line).toBeUndefined()
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toMatch(/PR #6/)
})

// ════════════════════════════════════════════════════════════════════════════
// When crosswalk is off
// ════════════════════════════════════════════════════════════════════════════
test('gh missing: off, and /crosswalk says so', async ($, on) => {
  const w = world(on)
  w.ghMissing = true
  w.prs = [pr(14, ['src/app.ts'])]
  await begin($, w)
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBeUndefined()
  expect(w.toasts.length).toBe(0)
  expect((await crosswalk($)).text).toBe(OFF_GH)
})

test('gh failing (not logged in): off, and /crosswalk says so', async ($, on) => {
  const w = world(on)
  w.list = { exitCode: 4, stderr: 'To get started with GitHub CLI, please run: gh auth login' }
  await begin($, w)
  expect((await crosswalk($)).text).toBe(OFF_GH)
  // later, once held back no longer, /crosswalk tries again and works
  w.list = null
  w.prs = [pr(14, ['src/app.ts'])]
  w.diff = ['src/app.ts']
  await w.clock.advance(3 * MIN)
  expect((await crosswalk($)).text).toMatch(/src\/app\.ts — #14 \(alice\)/)
})

for (const [name, setup] of [
  ['two remotes', (w: any) => (w.remotes = ['origin', 'upstream'])],
  ['a remote that is not GitHub', (w: any) => (w.url = 'https://gitlab.com/acme/app.git')],
  ['no repo at all', (w: any) => (w.cwd = '/tmp/scratch')],
] as const) {
  test(`${name}: off, no gh call`, async ($, on) => {
    const w = world(on)
    setup(w)
    w.prs = [pr(14, ['src/app.ts'])]
    await begin($, w)
    await edit($, w, `${w.cwd}/src/app.ts`)
    await w.clock.advance(10 * MIN)
    expect(w.calls.filter(c => c.argv[0] === 'gh').length).toBe(0)
    expect((await bandLines($)).line).toBeUndefined()
    expect((await crosswalk($)).text).toBe(OFF_REPO)
  })
}

// ════════════════════════════════════════════════════════════════════════════
// When it reads
// ════════════════════════════════════════════════════════════════════════════
test('no reading while nothing draws; it starts once something does', async ($, on) => {
  const w = world(on)
  w.surfaces = []
  await begin($, w)
  await w.clock.advance(3 * MIN)
  expect(listCalls(w).length).toBe(0)
  w.surfaces = ['terminal']
  await w.clock.advance(MIN)
  expect(listCalls(w).length).toBe(1)
})

test('no reading after 30 idle minutes; a prompt wakes it', async ($, on) => {
  const w = await ready($, on)
  await w.clock.advance(35 * MIN)
  // at 0, 5, 10, 15, 20 and 25 minutes; idle from 30
  expect(listCalls(w).length).toBe(6)
  await w.clock.advance(20 * MIN)
  expect(listCalls(w).length).toBe(6)
  await prompt($, w)
  await w.clock.advance(MIN)
  expect(listCalls(w).length).toBe(7)
})

test('an edit counts as activity', async ($, on) => {
  const w = await ready($, on)
  await w.clock.advance(29 * MIN)
  await edit($, w, '/repo/src/other.ts')
  await w.clock.advance(10 * MIN)
  // 0 to 25 as before, then 30 and 35: the edit at 29 keeps it awake
  expect(listCalls(w).length).toBe(8)
})

test('read again every 5 minutes, and a new PR shows up', async ($, on) => {
  const w = await ready($, on)
  await w.clock.advance(4 * MIN)
  expect(listCalls(w).length).toBe(1)
  w.prs = [pr(14, ['src/app.ts']), pr(40, ['lib/new.ts'], { author: { login: 'carol' } })]
  await w.clock.advance(MIN)
  expect(listCalls(w).length).toBe(2)
  await edit($, w, '/repo/lib/new.ts')
  expect((await bandLines($)).line).toMatch(/PR #40 'Title 40' by carol/)
})

test('a reading that never answers stops blocking after 4 minutes; its late answer is dropped', async ($, on) => {
  const w = world(on)
  let release = () => {}
  w.ghHold = new Promise<void>(r => (release = r))
  w.prs = [pr(1, ['old.ts'])]
  await begin($, w)
  expect(listCalls(w).length).toBe(1)
  // a reading still within its calls' timeouts (up to 9 × 20 s) isn't taken over
  w.prs = [pr(2, ['new.ts'])]
  await w.clock.advance(3 * MIN)
  expect(listCalls(w).length).toBe(1)
  // the next one goes out once the first is 4 minutes stuck
  await w.clock.advance(MIN)
  expect(listCalls(w).length).toBe(2)
  release()
  await w.clock.settle()
  await edit($, w, '/repo/old.ts')
  expect((await bandLines($)).line).toBeUndefined()
  await edit($, w, '/repo/new.ts')
  expect((await bandLines($)).line).toMatch(/PR #2/)
})

test('/clear empties the cache, drops a reading on its way, and starts again', async ($, on) => {
  const w = await ready($, on)
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBeDefined()
  // a reading on its way when /clear comes
  let release = () => {}
  w.ghHold = new Promise<void>(r => (release = r))
  w.prs = [pr(14, ['src/app.ts'])]
  await w.clock.advance(5 * MIN)
  expect(listCalls(w).length).toBe(2)
  w.prs = [pr(50, ['lib/b.ts'])]
  await clear($, w)
  expect((await bandLines($)).line).toBeUndefined()
  expect(listCalls(w).length).toBe(3)
  release()
  await w.clock.settle()
  // the late answer (PR #14) is dropped; the new session's reading (PR #50) stands
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBeUndefined()
  await edit($, w, '/repo/lib/b.ts')
  expect((await bandLines($)).line).toMatch(/PR #50/)
  // and the toast comes again for a file and PR seen before /clear
  w.prs = [pr(14, ['src/app.ts'])]
  await w.clock.advance(5 * MIN)
  const before = w.toasts.length
  await edit($, w, '/repo/src/app.ts')
  expect(w.toasts.length).toBe(before + 1)
})

test("the repo's remote changing drops what was read for it", async ($, on) => {
  const w = await ready($, on)
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBeDefined()
  w.url = 'git@github.com:acme/other.git'
  w.prs = []
  await w.clock.advance(5 * MIN)
  expect((await bandLines($)).line).toBeUndefined()
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toBeUndefined()
})

test('an edit in a repo not seen yet looks it up in the background', async ($, on) => {
  const w = world(on)
  w.cwd = '/tmp/scratch'
  w.prs = [pr(14, ['src/app.ts'])]
  await begin($, w)
  expect(listCalls(w).length).toBe(0)
  await edit($, w, '/repo/src/app.ts')
  expect(listCalls(w).length).toBe(1)
  await edit($, w, '/repo/src/app.ts')
  expect((await bandLines($)).line).toMatch(/PR #14/)
})

// ════════════════════════════════════════════════════════════════════════════
// /crosswalk
// ════════════════════════════════════════════════════════════════════════════
test('/crosswalk lists committed and uncommitted overlaps, sorted, with the truncated count', async ($, on) => {
  const many = Array.from({ length: 120 }, (_, i) => (i === 3 ? 'docs/a.md' : `gen/f${i}.ts`))
  const w = await ready($, on, [
    pr(22, ['src/app.ts', 'lib/z.ts'], { author: { login: 'bob' } }),
    pr(14, ['src/app.ts', 'README.md']),
    pr(30, many.slice(0, 100), { changedFiles: 120 }),
  ])
  w.diff = ['src/app.ts', 'other.ts']
  w.status = ' M lib/z.ts\0R  docs/new.md\0docs/a.md\0?? notes.txt\0'
  const { text } = await crosswalk($)
  expect(text).toBe(
    [
      '3 files on this branch are also in open PRs (3 open PRs checked, read just now):',
      'docs/a.md — #30 (alice)',
      'lib/z.ts — #22 (bob)',
      'src/app.ts — #14 (alice), #22 (bob)',
      '1 PR has more than 100 files; only the first 100 were checked.',
    ].join('\n'),
  )
  // the diff runs from the merge base with the base branch
  const diff = w.calls.find(c => c.argv[1] === 'diff')
  expect(diff?.argv).toEqual(['git', 'diff', '--name-only', '--no-renames', '-z', 'a'.repeat(40), 'HEAD', '--'])
  expect(w.calls.find(c => c.argv[1] === 'merge-base')?.argv).toEqual(['git', 'merge-base', 'HEAD', 'refs/remotes/origin/main'])
})

test('/crosswalk with no overlaps says so', async ($, on) => {
  const w = await ready($, on)
  w.diff = ['other.ts']
  await w.clock.advance(3 * MIN)
  expect((await crosswalk($)).text).toBe('no file on this branch is in another open PR (1 open PR checked, read 3m ago).')
})

test('/crosswalk on a cold cache reads first', async ($, on) => {
  const w = world(on)
  w.surfaces = [] // nothing drawn: no background reading
  w.prs = [pr(14, ['src/app.ts'])]
  w.diff = ['src/app.ts']
  await begin($, w)
  expect(listCalls(w).length).toBe(0)
  expect((await crosswalk($)).text).toMatch(/^src\/app\.ts — #14 \(alice\)$/m)
  expect(listCalls(w).length).toBe(1)
})

test('/crosswalk registers again after /clear', async ($, on) => {
  const w = await ready($, on)
  expect(w.registers).toBe(1)
  await clear($, w)
  expect(w.registers).toBe(2)
  // a session that ended without the classic hook starts again at the next prompt
  await $.session.end({ reason: 'clear', sessionId: 's2', resume: { id: 's2' } } as never)
  await prompt($, w)
  expect(w.registers).toBe(3)
  w.diff = ['src/app.ts']
  expect((await crosswalk($)).text).toMatch(/src\/app\.ts — #14/)
})

test('an age in hours and days', async ($, on) => {
  const w = await ready($, on, [pr(1, ['a.ts'], { updatedAt: new Date(NOW - 3 * 24 * HOUR).toISOString() })])
  await edit($, w, '/repo/a.ts')
  expect((await bandLines($)).line).toMatch(/updated 3d ago$/)
})

// ════════════════════════════════════════════════════════════════════════════
// Review round 1: my checkout's own PR, bots, one reading per repo, bounds
// ════════════════════════════════════════════════════════════════════════════
test("a fork's PR I checked out (branch.<b>.merge refs/pull/22/head) is not a warning", async ($, on) => {
  const w = world(on)
  w.branch = 'fix-thing'
  w.merge['fix-thing'] = 'refs/pull/22/head'
  w.prs = [
    pr(22, ['src/app.ts'], { headRefName: 'fix-thing', isCrossRepository: true, author: { login: 'forker' } }),
    pr(14, ['src/app.ts']),
  ]
  await begin($, w)
  await edit($, w, '/repo/src/app.ts')
  const { line } = await bandLines($)
  expect(line).toMatch(/PR #14/)
  expect(line).not.toMatch(/more/)
  expect(w.toasts.some(t => t.includes('#22'))).toBe(false)
  w.diff = ['src/app.ts']
  const { text } = await crosswalk($)
  expect(text).toMatch(/^src\/app\.ts — #14 \(alice\)$/m)
  expect(text).toMatch(/\(1 open PR checked/)
  // the merge ref was asked with the branch as one argument
  expect(w.calls.some(c => c.argv.join(' ') === 'git config --get branch.fix-thing.merge')).toBe(true)
})

test("after a branch switch the new branch's own PR is left out at once in /crosswalk, and in the band within a minute", async ($, on) => {
  const w = await ready($, on, [pr(1, ['a.ts'], { headRefName: 'feature/x' }), pr(2, ['a.ts'], { headRefName: 'feature/y' })])
  w.diff = ['a.ts']
  expect((await crosswalk($)).text).toMatch(/^a\.ts — #2 \(alice\)$/m)
  w.branch = 'feature/y'
  const calls = listCalls(w).length
  expect((await crosswalk($)).text).toMatch(/^a\.ts — #1 \(alice\)$/m)
  expect(listCalls(w).length).toBe(calls) // no new reading needed
  await w.clock.advance(MIN)
  await edit($, w, '/repo/a.ts')
  const { line } = await bandLines($)
  expect(line).toMatch(/PR #1 /)
  expect(line).not.toMatch(/more/)
  // and checking out a PR by its number counts the same way
  w.branch = 'review'
  w.merge.review = 'refs/pull/1/head'
  await w.clock.advance(MIN)
  await edit($, w, '/repo/a.ts')
  expect((await bandLines($)).line).toMatch(/PR #2 /)
})

test('a bot author (app/dependabot) shows, in the band and /crosswalk', async ($, on) => {
  const w = await ready($, on, [pr(31, ['package.json'], { author: { login: 'app/dependabot' } })])
  await edit($, w, '/repo/package.json')
  expect((await bandLines($)).line).toMatch(/PR #31 'Title 31' by app\/dependabot/)
  w.diff = ['package.json']
  expect((await crosswalk($)).text).toMatch(/^package\.json — #31 \(app\/dependabot\)$/m)
})

test('anything else that is no login still reads as ?', async ($, on) => {
  const w = await ready($, on, [
    pr(1, ['a.ts'], { author: { login: 'app/Dependabot' } }),
    pr(2, ['a.ts'], { author: { login: 'app/x/y' } }),
    pr(3, ['a.ts'], { author: { login: 'apps/bot' } }),
    pr(4, ['a.ts'], { author: { login: 'a'.repeat(40) } }),
  ])
  w.diff = ['a.ts']
  expect((await crosswalk($)).text).toMatch(/^a\.ts — #1 \(\?\), #2 \(\?\), #3 \(\?\), #4 \(\?\)$/m)
})

test('gh pr list names the repo itself, whatever GH_REPO the session inherited', async ($, on) => {
  const w = await ready($, on)
  const list = listCalls(w)[0]
  expect(list?.argv).toContain('--repo=github.com/acme/app')
  expect(list?.argv.filter(a => a.startsWith('--repo')).length).toBe(1)
  expect(w.calls.find(c => c.argv[1] === 'api')?.argv).toContain('--hostname=github.com')
})

test("/crosswalk reads its own repo even while another repo's reading is on its way", async ($, on) => {
  const w = world(on)
  w.cwd = '/other'
  let release = () => {}
  w.ghHold = new Promise<void>(r => (release = r))
  w.prs = [pr(14, ['src/app.ts'])]
  w.diff = ['src/app.ts']
  await begin($, w)
  expect(listCalls(w).length).toBe(1) // /other's, held
  w.cwd = '/repo'
  expect((await crosswalk($)).text).toMatch(/^src\/app\.ts — #14 \(alice\)$/m)
  expect(listCalls(w).length).toBe(2)
  release()
  await w.clock.settle()
})

test('who I am is asked once; when gh will not say, again only after 30 minutes', async ($, on) => {
  const w = world(on)
  w.meFails = true
  w.prs = [pr(14, ['src/app.ts'])]
  await begin($, w)
  const asks = () => w.calls.filter(c => c.argv[0] === 'gh' && c.argv[1] === 'api').length
  for (let i = 0; i < 5; i++) {
    await prompt($, w)
    await w.clock.advance(5 * MIN)
  }
  expect(listCalls(w).length).toBe(6)
  expect(asks()).toBe(1)
  await prompt($, w)
  await w.clock.advance(10 * MIN)
  expect(asks()).toBe(2)
})

test('at most 20 repos are kept; the oldest is looked up again', async ($, on) => {
  const w = await ready($, on)
  for (let i = 0; i < 25; i++) await edit($, w, `/many/r${i}/src/x.ts`)
  const looks = (dir: string) => w.calls.filter(c => c.argv.join(' ') === 'git rev-parse --show-toplevel' && c.init?.cwd === dir).length
  expect(looks('/many/r0/src')).toBe(1)
  await edit($, w, '/many/r0/src/x.ts')
  expect(looks('/many/r0/src')).toBe(2)
  await edit($, w, '/many/r24/src/x.ts')
  expect(looks('/many/r24/src')).toBe(1)
})
