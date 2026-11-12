import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import type { PullRef, Warning } from '../types'

// ════════════════════════════════════════════════════════════════════════════
// crosswalk: warns (never blocks) when Claude is about to edit a file that an open GitHub pull
// request also changes. Everything GitHub sends (titles, logins, paths, dates) is treated as
// hostile: cleaned before it's drawn, and never handed to the model except PR numbers,
// repo-relative paths and logins that look like logins.
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// 1. STATE: the band draws from this one value. Writing it redraws
// ════════════════════════════════════════════════════════════════════════════
const warning = atom({ plugin: 'crosswalk', key: 'warning' } as const, null)

const TICK_MS = 60_000 // the scheduler looks once a minute
const REFRESH_MS = 5 * 60_000 // a repo's open PRs are read again after this
const IDLE_MS = 30 * 60_000 // no prompt, turn or edit for this long: no reading
// a reading that never answers stops blocking the next one after this: past the worst case of
// its calls each running to the timeout (7 git + 2 gh, 20 s each)
const STUCK_MS = 4 * 60_000
const RUN_MS = 20_000 // every git and gh call is killed after this
const WARN_MS = 10 * 60_000 // the band line goes after this
const HOLD_STEP_MAX = 4 // after failures: 2, 4, 8, then 15 minutes between tries
const HOLD_MAX_MS = 15 * 60_000
const HOLD_JITTER = 0.1 // ±10%, so many sessions don't all ask at once
const HOLD_PREFIX = 'cw:hold:' // + hashed repo key: { untilMs, step } only, never repo names or PR text
const HOLD_KEEP = 50 // at most this many repos' holds in the store
const HOLD_TTL_MS = 24 * 60 * 60 * 1000 // ... and none over a day past its time
const PR_LIMIT = 100 // gh pr list --limit
const FILE_LIMIT = 100 // gh lists at most this many files per PR
const PATH_MAX = 4096
const TOASTED_MAX = 500
const DIRS_MAX = 200
const REPOS_MAX = 20 // repos known at once; past this the oldest goes, with what was read for it
const ME_RETRY_MS = 30 * 60_000 // gh not saying who I am: asked again after this
const TITLE_COLS = 60

const OFF_GH = "crosswalk: gh isn't available or not logged in here"
const OFF_REPO = "crosswalk: this folder isn't a GitHub repository with a single remote, so crosswalk is off here"
const HELD = 'crosswalk: reading GitHub failed or was rate limited a moment ago; try /crosswalk again in a few minutes'

// git and gh never prompt, page, colour or check for updates
const ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  NO_COLOR: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
}

const ORANGE = 'warning'

// ════════════════════════════════════════════════════════════════════════════
// 2. HELPERS: plain functions, no `$` in here
// ════════════════════════════════════════════════════════════════════════════

// How many terminal columns text takes: marks, format and control characters none; emoji and
// East Asian wide letters 2 (an emoji-looking sign followed by U+FE0F too); anything else 1.
// When unsure it counts more, never less, so a line never runs past the band
const ZERO_WIDE = /[\p{Mn}\p{Me}\p{Cf}\p{Cc}]/u
const WIDE =
  /[\p{Emoji_Presentation}ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]/u
const PICTO = /\p{Extended_Pictographic}/u
const colsAt = (chars: string[], i: number): number => {
  const c = chars[i] ?? ''
  if (/^[0-9#*]$/.test(c) && chars[i + 1] === '️' && chars[i + 2] === '⃣') return 2
  if (ZERO_WIDE.test(c)) return 0
  if (WIDE.test(c) || (PICTO.test(c) && chars[i + 1] === '️')) return 2
  return 1
}
const cols = (text: string): number => {
  const chars = Array.from(text)
  return chars.reduce((n, _, i) => n + colsAt(chars, i), 0)
}

// At most `max` columns, cut by whole code points (never half an emoji), with "…" when cut
const fit = (text: string, max: number): string => {
  if (cols(text) <= max) return text
  if (max <= 0) return ''
  const chars = Array.from(text)
  let out = ''
  let used = 0
  for (let i = 0; i < chars.length; i++) {
    const w = colsAt(chars, i)
    if (used + w > max - 1) break
    out += chars[i]
    used += w
  }
  return out + '…'
}

// One safe line of text from anything GitHub sent: terminal escapes (OSC 8 links, CSI colours)
// out, then format characters (bidi overrides, zero-width, soft hyphen), private-use, unassigned
// and lone surrogates; every run of spaces, new lines and control characters one space; piles of
// combining marks cut to three; at most `max` columns
const clean = (s: unknown, max: number): string => {
  if (typeof s !== 'string') return ''
  const text = s
    .slice(0, 20_000)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x9b[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, '')
    .replace(/[\s\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/(\p{M}{3})\p{M}+/gu, '$1')
    .trim()
  return fit(text, max)
}

// 125_000 → "2m ago"; under a minute (or a date ahead of us) "just now"
const ago = (ms: number): string => {
  if (ms < 60_000) return 'just now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

// A short stable key for a repo (two FNV-1a passes), so the store never holds its name or path
const hashKey = (s: string): string => {
  const pass = (seed: number): string => {
    let h = seed >>> 0
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return pass(0x811c9dc5) + pass(0x050c5d1f)
}

// A whole number in [min, max], else null
const toInt = (v: unknown, min: number, max: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null

// A date GitHub sent, as ms; null when it isn't an ISO-looking date that parses
const toTime = (v: unknown): number | null => {
  if (typeof v !== 'string' || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

// a GitHub login, or a GitHub App's as gh names it (app/dependabot); anything else is '?'
const LOGIN = /^[A-Za-z0-9-]{1,39}$/
const AUTHOR = /^(?:[A-Za-z0-9-]{1,39}|app\/[a-z0-9-]{1,39})$/
const login = (v: unknown): string => (typeof v === 'string' && AUTHOR.test(v) ? v : '?')

// A repo-relative path we'd ever match: no absolute path, no "..", no control characters, not huge
const safePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length <= PATH_MAX &&
  !p.startsWith('/') &&
  !p.startsWith('\\') &&
  !/^[A-Za-z]:/.test(p) &&
  !/[\p{Cc}]/u.test(p) &&
  !p.split(/[\\/]/).some(seg => seg === '..' || seg === '.' || seg === '')

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

// github.com remotes only: https://github.com/o/r(.git), git@github.com:o/r(.git),
// ssh://git@github.com/o/r(.git). Anything else (another host, a token in the URL, a port,
// odd characters) is no GitHub repo for us
const SLUG = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/
const slugOf = (url: string): string | null => {
  const u = url.trim()
  const m =
    /^https:\/\/github\.com\/([^/?#@:\s]+\/[^/?#@:\s]+?)(?:\.git)?\/?$/.exec(u) ??
    /^git@github\.com:([^/?#@:\s]+\/[^/?#@:\s]+?)(?:\.git)?$/.exec(u) ??
    /^ssh:\/\/git@github\.com\/([^/?#@:\s]+\/[^/?#@:\s]+?)(?:\.git)?\/?$/.exec(u)
  const slug = m?.[1]
  return slug && SLUG.test(slug) && !slug.split('/').some(s => s === '.' || s === '..') ? slug : null
}

// One remote name git gave us, safe to pass as an argument
const REMOTE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
// A remote-tracking ref we'd pass to git: refs/remotes/<remote>/<branch>, nothing that reads as an option
const REF = /^refs\/remotes\/[A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

// The plugin's options (/config or settings.json), read leniently: anything odd counts as the default
type Config = { showTitles: boolean; showAuthors: boolean; includeMine: boolean }
const configOf = (o: PluginOptions): Config => ({
  showTitles: o.showTitles !== false,
  showAuthors: o.showAuthors !== false,
  includeMine: o.includeMine === true,
})

type Repo = {
  top: string // real path of the work tree
  slug: string // owner/name, memory only
  hash: string
  remote: string
  ignorecase: boolean
  branch: string | null
  pull: number | null // the PR this branch tracks (gh pr checkout: branch.<b>.merge refs/pull/N/head)
  submodules: string[]
}

// one open PR as kept in memory: what the band shows, plus what tells whether it's my own
// branch's PR (its head and fork flag, never shown anywhere)
type Indexed = PullRef & { truncated: boolean; head: string; isFork: boolean }
type Cache = { index: Map<string, Indexed[]>; pulls: Indexed[]; fetchedAt: number }

// A branch name git gave us, safe as part of one argument
const BRANCH = /^[^\s\p{Cc}\-][^\s\p{Cc}]{0,254}$/u

// The PR of the branch I'm on isn't anyone crossing: a same-repo PR of this branch, or the PR
// this branch was checked out from (a fork's included). Applied when asked, so a checkout counts at once
const isOwn = (repo: Repo, pr: Indexed): boolean =>
  (!pr.isFork && repo.branch !== null && pr.head === repo.branch) || pr.number === repo.pull

// gh pr list's JSON, checked field by field; null when it isn't a list at all
type Pull = Indexed & { files: string[] }
const parsePulls = (stdout: string): Pull[] | null => {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const out: Pull[] = []
  for (const item of raw.slice(0, PR_LIMIT)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const number = toInt(r.number, 1, 1e9)
    if (number === null) continue
    const author = r.author && typeof r.author === 'object' ? (r.author as Record<string, unknown>).login : undefined
    const list = Array.isArray(r.files) ? r.files : []
    const files = list
      .slice(0, FILE_LIMIT)
      .map(f => (f && typeof f === 'object' ? (f as Record<string, unknown>).path : undefined))
      .filter(safePath)
    const changed = toInt(r.changedFiles, 0, 1e9)
    out.push({
      number,
      title: clean(r.title, TITLE_COLS),
      login: login(author),
      updatedAt: toTime(r.updatedAt),
      truncated: list.length > FILE_LIMIT || (changed !== null && changed > Math.min(list.length, FILE_LIMIT)),
      files,
      head: typeof r.headRefName === 'string' ? r.headRefName : '',
      isFork: r.isCrossRepository === true,
    })
  }
  return out
}

// The key a path is looked up by: lower-cased where the repo ignores case
const keyOf = (repo: Repo, rel: string): string => (repo.ignorecase ? rel.toLowerCase() : rel)

// Whether a repo-relative path lies in one of the repo's submodules
const inSubmodule = (repo: Repo, rel: string): boolean =>
  repo.submodules.some(s => rel === s || rel.startsWith(s + '/'))

// Paths from NUL-separated git output
const zList = (s: string): string[] => s.split('\0').filter(Boolean)

// git status --porcelain -z: "XY path", and after a rename or copy its source as the next entry
const statusPaths = (s: string): string[] => {
  const parts = s.split('\0')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? ''
    if (entry.length < 4) continue
    out.push(entry.slice(3))
    if (/[RC]/.test(entry.slice(0, 2)) && parts[i + 1]) out.push(parts[++i] ?? '')
  }
  return out
}

// The band's words, newest PR first: "<file> is in PR #14 'Title' by alice · updated 2h ago (+1 more)"
const lineOf = (w: Warning, cfg: Config, now: number): string => {
  const [pr] = w.prs
  if (!pr) return ''
  const title = cfg.showTitles && pr.title ? ` '${clean(pr.title, TITLE_COLS)}'` : ''
  const by = cfg.showAuthors ? ` by ${login(pr.login)}` : ''
  const age = pr.updatedAt === null ? '' : ` · updated ${ago(now - pr.updatedAt)}`
  const more = w.prs.length > 1 ? ` (+${w.prs.length - 1} more)` : ''
  return ` · ${clean(baseName(w.path), 80)} is in PR #${pr.number}${title}${by}${age}${more}`
}

// ════════════════════════════════════════════════════════════════════════════
// 3. THE WORK: discovery, reading PRs, the scheduler (module state, like usage-radar)
// ════════════════════════════════════════════════════════════════════════════
// everything below lives for this load of the mod; session.end and /clear empty it
const repos = new Map<string, Repo>() // by real top
const dirs = new Map<string, string | null>() // a folder → its repo's top, or null: none
const finding = new Map<string, Promise<Repo | null>>() // discoveries on their way, by folder
const caches = new Map<string, Cache>() // by repo hash
const toasted = new Set<string>()
let me: string | null | undefined // my GitHub login (undefined: not asked yet; null: gh wouldn't say)
let meAt = 0 // when it was last asked
let ghOk: boolean | null = null // the last gh pr list: worked, failed, not run yet
let lastActive = 0
let timer: Timer | undefined
let starting: Promise<void> | null = null
let sessionGen = 0 // session.end moves it on, so a start still on its way stops
let fetchGen = 0 // numbers each reading, so a late answer of an older one is dropped
// the reading on its way per repo hash: one at a time per repo, a late one of an older reading dropped
const flights = new Map<string, { p: Promise<boolean>; at: number; gen: number }>()

// ── Running git and gh: argv only (no shell), fixed env, a timeout. A non-zero exit, output cut
//    short, a missing binary or a timeout all count as failed (a rate limit too: every failure
//    backs off the same way); stderr is never read, so gh's own words never reach the screen ──
type Ran = { ok: boolean; stdout: string }
const run = async ($: EngineInterface, argv: string[], cwd: string): Promise<Ran> => {
  try {
    const r = await $.process.run(argv, { cwd, env: ENV, timeoutMs: RUN_MS })
    if (r.exitCode !== 0 || r.isStdoutTruncated || typeof r.stdout !== 'string') return { ok: false, stdout: '' }
    return { ok: true, stdout: r.stdout }
  } catch {
    // the binary is missing, or it ran past the timeout
    return { ok: false, stdout: '' }
  }
}
const git = ($: EngineInterface, args: string[], cwd: string) => run($, ['git', ...args], cwd)

// A path's real spelling (every link and ".." resolved), or undefined
const realOf = async ($: EngineInterface, path: string): Promise<string | undefined> => {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

// ── Repo discovery, per folder (cached): one GitHub remote, its real top, case, branch, submodules ──
const look = async ($: EngineInterface, dir: string): Promise<Repo | null> => {
  const top = await git($, ['rev-parse', '--show-toplevel'], dir)
  const shown = top.stdout.replace(/\n$/, '')
  if (!top.ok || !shown.startsWith('/') || /[\p{Cc}]/u.test(shown)) return null
  const real = await realOf($, shown)
  if (!real) return null
  const remotes = await git($, ['remote'], real)
  const names = remotes.stdout.split('\n').filter(Boolean)
  const remote = names[0]
  if (!remotes.ok || names.length !== 1 || !remote || !REMOTE.test(remote)) return null
  const url = await git($, ['remote', 'get-url', remote], real)
  const slug = url.ok ? slugOf(url.stdout) : null
  if (!slug) return null
  const ic = await git($, ['config', '--get', 'core.ignorecase'], real)
  const { branch, pull } = await branchOf($, real)
  let submodules: string[] = []
  if (await $.fs.exists(`${real}/.gitmodules`).catch(() => false)) {
    const subs = await git($, ['config', '-z', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], real)
    if (!subs.ok) return null
    // each entry "submodule.<name>.path\n<path>"
    submodules = zList(subs.stdout)
      .map(x => x.slice(x.indexOf('\n') + 1).replace(/\/+$/, ''))
      .filter(safePath)
  }
  return {
    top: real,
    slug,
    hash: hashKey(`${slug}\0${real}`),
    remote,
    ignorecase: ic.ok && ic.stdout.trim() === 'true',
    branch,
    pull,
    submodules,
  }
}

// The branch I'm on, and the PR it was checked out from (gh pr checkout sets branch.<b>.merge to
// refs/pull/<n>/head, a fork's PR included); two cheap git calls, so a checkout counts at once
const branchOf = async ($: EngineInterface, top: string): Promise<{ branch: string | null; pull: number | null }> => {
  const head = await git($, ['symbolic-ref', '--short', '-q', 'HEAD'], top)
  const branch = head.ok ? head.stdout.trim() : ''
  if (!BRANCH.test(branch)) return { branch: null, pull: null }
  const merge = await git($, ['config', '--get', `branch.${branch}.merge`], top)
  const m = merge.ok ? /^refs\/pull\/(\d{1,10})\/head$/.exec(merge.stdout.trim()) : null
  return { branch, pull: m ? toInt(Number(m[1]), 1, 1e9) : null }
}

// A repo joins (or is updated in) the known ones; past REPOS_MAX the oldest goes, with its cache
const keep = (repo: Repo): void => {
  repos.delete(repo.top)
  repos.set(repo.top, repo)
  for (const old of repos.values()) {
    if (repos.size <= REPOS_MAX) break
    repos.delete(old.top)
    caches.delete(old.hash)
    flights.delete(old.hash)
    for (const [d, t] of dirs) if (t === old.top) dirs.delete(d)
  }
}

// The branch looked at again (the minute tick, /crosswalk); null when the repo isn't known now
const rebranch = async ($: EngineInterface, repo: Repo): Promise<Repo | null> => {
  const b = await branchOf($, repo.top)
  const now = repos.get(repo.top)
  if (!now || now.hash !== repo.hash) return null
  const next = now.branch === b.branch && now.pull === b.pull ? now : { ...now, ...b }
  repos.set(now.top, next) // in place: a branch change doesn't make it the newest repo
  return next
}

// Where a folder's repo is (once per folder); a repo found joins `repos`
const discover = ($: EngineInterface, dir: string): Promise<Repo | null> => {
  const known = dirs.get(dir)
  if (known !== undefined) return Promise.resolve(known === null ? null : (repos.get(known) ?? null))
  const going = finding.get(dir)
  if (going) return going
  const gen = sessionGen
  const p = look($, dir)
    .catch(() => null)
    .then(repo => {
      finding.delete(dir)
      if (gen !== sessionGen) return null
      if (dirs.size >= DIRS_MAX) dirs.clear()
      if (repo) keep(repo)
      dirs.set(dir, repo?.top ?? null)
      return repo
    })
  finding.set(dir, p)
  return p
}

// Everything this session learned about a repo goes (its identity changed, or it isn't one now)
const forget = async ($: EngineInterface, repo: Repo): Promise<void> => {
  caches.delete(repo.hash)
  const w = await read($, warning)
  if (w?.repo === repo.hash) await update($, warning, () => null)
}

// The repo looked at again before each reading: its branch moves, its remote may change
const refresh = async ($: EngineInterface, repo: Repo): Promise<Repo | null> => {
  const now = await look($, repo.top).catch(() => null)
  if (now?.hash !== repo.hash) {
    await forget($, repo)
    repos.delete(repo.top)
    for (const [d, t] of dirs) if (t === repo.top) dirs.delete(d)
    if (now) {
      keep(now)
      dirs.set(now.top, now.top)
    }
    return now
  }
  if (repos.has(repo.top)) repos.set(repo.top, now)
  return now
}

// ── Holding back after failures, shared by every session through $.store ──
const holdKey = (hash: string) => HOLD_PREFIX + hash
// a hold further off than the longest wait we ever set (a clock that jumped, a broken store) is none
const HOLD_FAR_MS = HOLD_MAX_MS * (1 + HOLD_JITTER)
const holdOf = async ($: EngineInterface, hash: string, now: number): Promise<{ untilMs: number; step: number } | null> => {
  try {
    const v = (await $.store.get(holdKey(hash))) as Record<string, unknown> | undefined
    const untilMs = toInt(v?.untilMs, 0, Number.MAX_SAFE_INTEGER)
    const step = toInt(v?.step, 1, HOLD_STEP_MAX)
    return untilMs === null || step === null || untilMs - now > HOLD_FAR_MS ? null : { untilMs, step }
  } catch {
    return null
  }
}
const isHeld = async ($: EngineInterface, hash: string, now: number): Promise<boolean> => {
  const h = await holdOf($, hash, now)
  return h !== null && now < h.untilMs
}
// 2, 4, 8, then 15 minutes, ±10%
const holdMs = (step: number): number =>
  Math.round(Math.min(HOLD_MAX_MS, 60_000 * 2 ** step) * (1 - HOLD_JITTER + 2 * HOLD_JITTER * Math.random()))
const holdBack = async ($: EngineInterface, hash: string, now: number): Promise<void> => {
  try {
    const step = Math.min(((await holdOf($, hash, now))?.step ?? 0) + 1, HOLD_STEP_MAX)
    await $.store.set(holdKey(hash), { untilMs: now + holdMs(step), step })
  } catch {
    // the store is down: the next tick tries again
  }
}
// Holds over a day past their time go, so do ones too far ahead, and past the newest 50 the oldest
const prune = async ($: EngineInterface): Promise<void> => {
  try {
    const now = await $.clock.now()
    const held: { key: string; until: number }[] = []
    for (const key of await $.store.keys()) {
      if (!key.startsWith(HOLD_PREFIX)) continue
      const v = (await $.store.get(key)) as Record<string, unknown> | undefined
      const until = toInt(v?.untilMs, 0, Number.MAX_SAFE_INTEGER)
      if (until === null || now - until > HOLD_TTL_MS || until - now > HOLD_FAR_MS) await $.store.delete(key)
      else held.push({ key, until })
    }
    held.sort((a, b) => b.until - a.until)
    for (const h of held.slice(HOLD_KEEP)) await $.store.delete(h.key)
  } catch {
    // ignore: next session prunes
  }
}

// My own login, asked once and kept in memory (never stored); null when gh won't say
const myLogin = async ($: EngineInterface, top: string): Promise<string | null> => {
  const r = await run($, ['gh', 'api', 'user', '--hostname=github.com', '--jq', '.login'], top)
  const v = r.stdout.trim()
  return r.ok && LOGIN.test(v) ? v : null
}

// ── Reading a repo's open PRs: one at a time per repo; a late answer of an older reading is dropped ──
const isBusy = (hash: string, now: number): boolean => {
  const f = flights.get(hash)
  return f !== undefined && now - f.at < STUCK_MS
}
const fetchRepo = async ($: EngineInterface, cfg: Config, start: Repo): Promise<boolean> => {
  const now = await $.clock.now()
  const going = flights.get(start.hash)
  if (going && isBusy(start.hash, now)) return going.p
  const gen = ++fetchGen
  const live = () => flights.get(start.hash)?.gen === gen
  const p = (async (): Promise<boolean> => {
    try {
      const repo = await refresh($, start)
      if (!live() || !repo) return false
      // who I am, asked once; when gh won't say, again only after a while
      if (!cfg.includeMine && (me === undefined || (me === null && now - meAt >= ME_RETRY_MS))) {
        meAt = now
        me = await myLogin($, repo.top)
      }
      if (!live()) return false
      const r = await run(
        $,
        [
          'gh', 'pr', 'list',
          `--repo=github.com/${repo.slug}`, // never a repo an inherited GH_REPO names
          '--state', 'open',
          '--limit', String(PR_LIMIT),
          '--json', 'number,title,author,headRefName,isCrossRepository,updatedAt,files,changedFiles',
        ],
        repo.top,
      )
      if (!live()) return false
      const pulls = r.ok ? parsePulls(r.stdout) : null
      if (!pulls) {
        ghOk = false
        await holdBack($, repo.hash, now)
        return false
      }
      // (unless asked) the PRs I opened aren't anyone crossing; my branch's own PR is left out
      // when asked (isOwn), so a checkout counts without reading again
      const mine = (l: string) => !cfg.includeMine && !!me && l.toLowerCase() === me.toLowerCase()
      const index = new Map<string, Indexed[]>()
      const kept: Indexed[] = []
      for (const pr of pulls) {
        if (mine(pr.login)) continue
        const { files, ...ref } = pr
        kept.push(ref)
        for (const f of new Set(files.map(f => keyOf(repo, f)))) index.set(f, [...(index.get(f) ?? []), ref])
      }
      caches.set(repo.hash, { index, pulls: kept, fetchedAt: now })
      ghOk = true
      await $.store.delete(holdKey(repo.hash)).catch(() => {})
      return true
    } catch {
      return false
    } finally {
      if (live()) flights.delete(start.hash)
    }
  })()
  flights.set(start.hash, { p, at: now, gen })
  return p
}

// ── The scheduler: once a minute, only while someone looks and something happens ──
const tick = async ($: EngineInterface, cfg: Config): Promise<void> => {
  try {
    const now = await $.clock.now()
    // the band line goes once it's old
    const w = await read($, warning)
    if (w && now - w.at > WARN_MS) await update($, warning, () => null)
    if ((await $.session.surfaces()).length === 0) return
    if (now - lastActive >= IDLE_MS) return
    // the branch of each repo read so far, so a checkout's own PR is left out within a minute
    for (const repo of [...repos.values()]) if (caches.has(repo.hash)) await rebranch($, repo)
    // one gh at a time; the next tick takes the next repo
    if ([...flights.keys()].some(h => isBusy(h, now))) return
    for (const repo of repos.values()) {
      const c = caches.get(repo.hash)
      if (c && now - c.fetchedAt < REFRESH_MS) continue
      if (await isHeld($, repo.hash, now)) continue
      void fetchRepo($, cfg, repo)
      return
    }
  } catch {
    // ignore: the next tick tries again
  }
}

// ── Startup: the /crosswalk command, the minute timer, the session folder's repo ──
const startSession = async ($: EngineInterface, cfg: Config): Promise<void> => {
  const gen = sessionGen
  try {
    await $.command.register({
      name: 'crosswalk',
      description: 'List the files on this branch that open GitHub pull requests also change',
    })
  } catch {
    // a refused command: the next prompt or command starts again
    if (gen === sessionGen) starting = null
    return
  }
  if (gen !== sessionGen) return
  timer?.cancel()
  timer = $.clock.every(TICK_MS, () => void tick($, cfg))
  lastActive = await $.clock.now()
  void prune($)
  void (async () => {
    const cwd = await $.session.cwd()
    await discover($, cwd)
    if (gen !== sessionGen) return
    await tick($, cfg)
  })().catch(() => {})
}
const ensureStarted = ($: EngineInterface, cfg: Config): Promise<void> => (starting ??= startSession($, cfg))

const active = async ($: EngineInterface): Promise<void> => {
  try {
    lastActive = await $.clock.now()
  } catch {
    // ignore
  }
}

// Everything this session knew goes: at its end and at /clear
const reset = async ($: EngineInterface): Promise<void> => {
  timer?.cancel()
  timer = undefined
  sessionGen++
  starting = null
  flights.clear() // a reading still on its way is dropped
  repos.clear()
  dirs.clear()
  finding.clear()
  caches.clear()
  toasted.clear()
  me = undefined
  meAt = 0
  ghOk = null
  try {
    await update($, warning, () => null)
  } catch {
    // the host wipes it anyway
  }
}

// ── An edit, a write or a notebook edit: warn when an open PR changes the same file ──
// The call always goes on as it came: this hook never blocks, rewrites or adds context, and
// never waits for git or gh (an unknown repo is looked up in the background)
const onEdit = async ($: EngineInterface, cfg: Config, input: Record<string, unknown>): Promise<void> => {
  await active($)
  const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > PATH_MAX) return
  // where it lands: the file, or for a new file its folder and name
  let real = await realOf($, path)
  if (!real) {
    const cut = path.lastIndexOf('/')
    const name = path.slice(cut + 1)
    if (name === '' || name === '.' || name === '..') return
    const dir = await realOf($, path.slice(0, cut) || '/')
    if (!dir) return
    real = `${dir.replace(/\/$/, '')}/${name}`
  }
  let repo: Repo | undefined
  for (const r of repos.values()) if (real.startsWith(r.top + '/') && (!repo || r.top.length > repo.top.length)) repo = r
  if (!repo) {
    const dir = real.slice(0, real.lastIndexOf('/')) || '/'
    if (!dirs.has(dir)) void discover($, dir).then(r => (r ? tick($, cfg) : undefined)).catch(() => {})
    return
  }
  const rel = real.slice(repo.top.length + 1)
  if (!safePath(rel) || inSubmodule(repo, rel)) return
  const own = repo
  const hits = caches.get(repo.hash)?.index.get(keyOf(repo, rel))?.filter(pr => !isOwn(own, pr))
  if (!hits?.length) return
  const now = await $.clock.now()
  const prs: PullRef[] = [...hits]
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(({ number, title, login, updatedAt }) => ({ number, title, login, updatedAt }))
  const shownPath = clean(rel, 200)
  await update($, warning, () => ({ repo: repo.hash, path: shownPath, prs, at: now }))
  // one toast per file and PR
  for (const pr of prs) {
    const key = `${repo.hash}:${keyOf(repo, rel)}#${pr.number}`
    if (toasted.has(key)) continue
    if (toasted.size >= TOASTED_MAX) toasted.clear()
    toasted.add(key)
    const title = cfg.showTitles && pr.title ? ` '${pr.title}'` : ''
    const by = cfg.showAuthors ? ` by ${pr.login}` : ''
    $.ui.toast(fit(`🚸 crosswalk: ${shownPath} is also changed in PR #${pr.number}${title}${by}`, 200))
  }
}

// ── /crosswalk: the files this branch changes that open PRs also change ──
// The model reads this reply: PR numbers, repo-relative paths and checked logins only, never
// a PR's title or branch, never gh's own error text
const branchPaths = async ($: EngineInterface, repo: Repo): Promise<{ paths: string[]; hasBase: boolean }> => {
  const paths: string[] = []
  let base: string | null = null
  const head = await git($, ['symbolic-ref', '-q', `refs/remotes/${repo.remote}/HEAD`], repo.top)
  const named = head.stdout.trim()
  if (head.ok && REF.test(named) && (await git($, ['check-ref-format', named], repo.top)).ok) base = named
  for (const b of ['main', 'master']) {
    if (base) break
    const ref = `refs/remotes/${repo.remote}/${b}`
    if ((await git($, ['rev-parse', '--verify', '--quiet', ref], repo.top)).ok) base = ref
  }
  let hasBase = false
  if (base) {
    const mb = await git($, ['merge-base', 'HEAD', base], repo.top)
    const sha = mb.stdout.trim()
    if (mb.ok && SHA.test(sha)) {
      const diff = await git($, ['diff', '--name-only', '--no-renames', '-z', sha, 'HEAD', '--'], repo.top)
      if (diff.ok) {
        hasBase = true
        paths.push(...zList(diff.stdout))
      }
    }
  }
  const status = await git($, ['status', '--porcelain', '-z', '--untracked-files=all'], repo.top)
  if (status.ok) paths.push(...statusPaths(status.stdout))
  return { paths, hasBase }
}

// ════════════════════════════════════════════════════════════════════════════
// 4. HOOKS
// ════════════════════════════════════════════════════════════════════════════
export const register: Register = (on, options) => {
  const cfg = configOf(options ?? {})

  // ── Startup: the /crosswalk command, the minute timer, the session folder's repo ──
  on('session.start', async ($, e, next) => {
    await ensureStarted($, cfg)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── The session ends (exit, /clear, ...): its cache, timer and band line go ──
  on('session.end', async ($, e, next) => {
    await reset($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.SessionStart', async ($, e, next) => {
    // /clear: the cache goes, then the new conversation starts again (once)
    if (e.source === 'clear') await reset($)
    await ensureStarted($, cfg)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── Activity: a prompt or a finished turn keeps the readings going ──
  on('prompt.submit', async ($, e, next) => {
    await active($)
    await ensureStarted($, cfg)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await active($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── An edit, a write or a notebook edit: warn, never block ──
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    try {
      await onEdit($, cfg, e as unknown as Record<string, unknown>)
    } catch {
      // the edit goes on whatever the lookup did
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // if this mod breaks, the edit still runs

  // ── /crosswalk: what this branch shares with open PRs. The model reads this reply ──
  on('command.run', { command: 'crosswalk' }, async ($, e) => {
    try {
      await ensureStarted($, cfg)
      await active($)
      const cwd = await $.session.cwd()
      const repo = await discover($, cwd)
      if (!repo) return { text: OFF_REPO }
      const now = await $.clock.now()
      if (!caches.has(repo.hash)) {
        if (await isHeld($, repo.hash, now)) return { text: ghOk === false ? OFF_GH : HELD }
        await fetchRepo($, cfg, repo)
      }
      const known = repos.get(repo.top)
      // the branch as it is now (a checkout since the last reading counts)
      const fresh = known ? await rebranch($, known) : null
      const cache = fresh ? caches.get(fresh.hash) : undefined
      if (!fresh || !cache) return { text: OFF_GH }
      const { paths, hasBase } = await branchPaths($, fresh)
      const hits = new Map<string, Indexed[]>()
      for (const p of paths) {
        if (!safePath(p) || inSubmodule(fresh, p)) continue
        const prs = cache.index.get(keyOf(fresh, p))?.filter(pr => !isOwn(fresh, pr))
        if (prs?.length) hits.set(p, prs)
      }
      const others = cache.pulls.filter(pr => !isOwn(fresh, pr))
      const truncated = others.filter(pr => pr.truncated).length
      const age = ago(now - cache.fetchedAt)
      const checked = `${others.length} open PR${others.length === 1 ? '' : 's'} checked, read ${age}`
      const notes = [
        hasBase ? '' : 'No base branch found, so only uncommitted changes were checked.',
        truncated
          ? `${truncated} PR${truncated === 1 ? ' has' : 's have'} more than ${FILE_LIMIT} files; only the first ${FILE_LIMIT} were checked.`
          : '',
      ].filter(Boolean)
      if (hits.size === 0)
        return { text: [`crosswalk: no file on this branch is in another open PR (${checked}).`, ...notes].join('\n') }
      const rows = [...hits]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([p, prs]) => {
          const list = [...prs]
            .sort((a, b) => a.number - b.number)
            .map(pr => (cfg.showAuthors ? `#${pr.number} (${login(pr.login)})` : `#${pr.number}`))
            .join(', ')
          return `${clean(p, 200)} — ${list}`
        })
      const head = `crosswalk: ${hits.size} file${hits.size === 1 ? '' : 's'} on this branch ${hits.size === 1 ? 'is' : 'are'} also in open PRs (${checked}):`
      return { text: [head, ...rows, ...notes].join('\n') }
    } catch {
      return { text: OFF_GH }
    }
  })

  // ── Band above the prompt: one line on top of whatever else draws there ──
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const w = await read($, warning)
    if (!w || w.prs.length === 0) return next(e)
    const now = await $.clock.now()
    if (now - w.at > WARN_MS) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(1, e.props.bodyColumns)
    const lead = '🚸 crosswalk'
    const leadText = fit(lead, width)
    const rest = fit(lineOf(w, cfg, now), Math.max(0, width - cols(leadText)))
    const below = await next(e)
    const line = (
      <Text wrap="truncate-end">
        <Text color={ORANGE} bold>
          {leadText}
        </Text>
        <Text>{rest}</Text>
      </Text>
    )
    return below ? (
      <Box flexDirection="column">
        {line}
        {below}
      </Box>
    ) : (
      <Box flexDirection="column">{line}</Box>
    )
  })
}
