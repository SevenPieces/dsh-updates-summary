#!/usr/bin/env node
/**
 * collect.mjs - deterministic data collection for the dsh-updates-summary skill.
 *
 * Resolves the dsh repository, the currently installed version, the previously
 * installed version, and the newest published upstream version (any channel:
 * alpha/beta/rc/lts/stable), then gathers release notes and commit history for
 * the resolved range and emits one JSON digest. Read-only with respect to the
 * repository: it uses git ls-remote (never git fetch) and never writes inside
 * the repo.
 *
 * Exit codes: 0 ok  2 REPO_NOT_FOUND  3 network unavailable  4 no usable range
 *
 * Usage:
 *   node collect.mjs [--repo PATH] [--from V] [--to V]
 *                    [--slug owner/repo] [--offline] [--out FILE] [--human]
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const DEFAULT_SLUG = 'deepseek-ai/deepseek-harness'
const NPM_PKG = '@deepseek-ai/dsh'
const TAG_PREFIXES = ['dsh-v', 'v']
const MAX_RELEASE_PAGES = 5

/* ------------------------------- arguments ------------------------------- */

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const flag = (name) => argv.includes(name)
const options = {
  repo: opt('--repo') ?? process.env.DSH_REPO,
  from: opt('--from'),
  to: opt('--to'),
  slug: opt('--slug') ?? DEFAULT_SLUG,
  offline: flag('--offline'),
  out: opt('--out'),
  human: flag('--human'),
  token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
}
const HELP_TEXT = [
  'usage: node collect.mjs [options]',
  '',
  'options:',
  '  --repo PATH        dsh repository path (env: DSH_REPO)',
  '  --from V           start version/tag of the range',
  '  --to V             end version/tag of the range',
  '  --slug owner/repo  upstream repository slug',
  '  --offline          skip all network calls',
  '  --out FILE         write the JSON digest to FILE',
  '  --human            print a human-readable summary instead of JSON',
  '  -h, --help         print this help and exit',
  '',
  'env: DSH_REPO, GITHUB_TOKEN / GH_TOKEN',
  'exit codes and digest fields: see reference/digest-schema.md (in this skill directory)',
].join('\n')

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(HELP_TEXT + '\n')
  process.exit(0)
}

const warn = (...a) => process.stderr.write('[collect] ' + a.join(' ') + '\n')

/* -------------------------------- helpers -------------------------------- */

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return undefined } }

function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch { return undefined }
}

function stripTag(t) {
  let s = String(t)
  for (const p of TAG_PREFIXES) if (s.startsWith(p)) { s = s.slice(p.length); break }
  return s
}

function escapeRe(s) { return String(s).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&') }

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim())
  if (!m) return undefined
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] }
}

function cmpSemver(a, b) {
  const A = parseSemver(a); const B = parseSemver(b)
  if (!A || !B) return 0
  for (const k of ['major', 'minor', 'patch']) if (A[k] !== B[k]) return A[k] - B[k]
  if (A.pre.length === 0 && B.pre.length === 0) return 0
  if (A.pre.length === 0) return 1
  if (B.pre.length === 0) return -1
  const n = Math.max(A.pre.length, B.pre.length)
  for (let i = 0; i < n; i++) {
    const x = A.pre[i]; const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y)
    if (xn && yn) { if (+x !== +y) return +x - +y; continue }
    if (xn) return -1
    if (yn) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function channelOf(v) { const m = /-(alpha|beta|rc|lts|canary|next|dev)\./.exec(String(v)); return m ? m[1] : 'stable' }

function norm(s) {
  return String(s).toLowerCase()
    .replace(/\u0060/g, '')
    .replace(/\s+by\s+@[\w.,@\s-]+$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokenSet(s) { return new Set(norm(s).split(' ').filter(Boolean)) }

function similar(a, b) {
  const [s, l] = a.size <= b.size ? [a, b] : [b, a]
  if (s.size === 0) return 0
  let n = 0
  for (const t of s) if (l.has(t)) n++
  return n / s.size
}

/* ---------------------------- repo resolution ---------------------------- */

function checkoutRootFromPackageDir(dir) {
  if (basename(dir) === 'cli' && basename(dirname(dir)) === 'apps') return dirname(dirname(dir))
  return undefined
}

function classify(dir) {
  if (!dir) return undefined
  let real = dir
  try { real = realpathSync(dir) } catch { /* keep the literal path */ }
  if (!existsSync(real)) return undefined
  if (readJson(join(real, 'apps/cli/package.json'))?.name === NPM_PKG) return { kind: 'checkout', root: real }
  if (readJson(join(real, 'package.json'))?.name === NPM_PKG) {
    const root = checkoutRootFromPackageDir(real) ?? checkoutRootFromPackageDir(dir)
    if (root && existsSync(join(root, '.git'))) return { kind: 'checkout', root }
    return { kind: 'package', root: real }
  }
  return undefined
}

function launcherTargets() {
  const dirs = []
  const paths = [
    join(homedir(), '.local/bin/dsh'),
    join(homedir(), '.npm-global/bin/dsh'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  ]
  for (const p of (process.env.PATH ?? '').split(':').filter(Boolean)) paths.push(join(p, 'dsh'))
  for (const p of paths) {
    try {
      const txt = readFileSync(p, 'utf8')
      const m = /([^\s'";]+)[/\\]apps[/\\]cli[/\\]lib[/\\]bin\.js/.exec(txt)
      if (m) dirs.push(m[1])
    } catch { /* not a launcher */ }
  }
  return dirs
}

function npmGlobalDirs() {
  const dirs = []
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (root) dirs.push(join(root, '@deepseek-ai/dsh'))
  } catch { /* npm unavailable */ }
  dirs.push(join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh'))
  if (process.env.DSH_HOME) dirs.push(join(process.env.DSH_HOME, 'profiles/node_modules/@deepseek-ai/dsh'))
  return dirs
}

function commonDirs() {
  const h = homedir()
  return [
    join(h, 'deepseek-harness'),
    join(h, 'src/deepseek-harness'),
    join(h, 'code/deepseek-harness'),
    join(h, 'Work/deepseek-harness'),
    '/opt/deepseek-harness',
  ]
}

function ancestors(start) {
  const out = []; let d = resolve(start)
  for (let i = 0; i < 12; i++) { out.push(d); const p = dirname(d); if (p === d) break; d = p }
  return out
}

function resolveRepo() {
  const candidates = [
    options.repo,
    ...launcherTargets(),
    ...npmGlobalDirs(),
    ...commonDirs(),
    ...ancestors(process.cwd()),
  ].filter(Boolean)
  for (const c of candidates) { const info = classify(c); if (info) return { ...info, resolvedFrom: c } }
  return undefined
}

/* --------------------------- installed / previous -------------------------- */

function installedInfo(repo) {
  if (repo?.kind === 'checkout') {
    const version = readJson(join(repo.root, 'apps/cli/package.json'))?.version
    const sha = git(repo.root, ['rev-parse', '--short', 'HEAD'])
    const longSha = git(repo.root, ['rev-parse', 'HEAD'])
    const describe = git(repo.root, ['describe', '--tags', '--always'])
    const nearestTag = git(repo.root, ['describe', '--tags', '--abbrev=0'])
    let aheadBy = 0
    if (describe && nearestTag) {
      const m = new RegExp(escapeRe(nearestTag) + '-(\\d+)-g').exec(describe)
      if (m) aheadBy = +m[1]
    }
    return { version, sha, longSha, describe, nearestTag, aheadBy, source: 'checkout' }
  }
  if (repo?.kind === 'package') {
    return { version: readJson(join(repo.root, 'package.json'))?.version, source: 'package' }
  }
  return undefined
}

function installedFromCli() {
  const paths = (process.env.PATH ?? '').split(':').filter(Boolean).map((p) => join(p, 'dsh'))
  paths.push(join(homedir(), '.local/bin/dsh'))
  for (const p of paths) {
    try {
      const v = execFileSync(p, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (v) return v
    } catch { /* keep looking */ }
  }
  return undefined
}

function previousInstall(repo, currentVersion, currentNearestTag) {
  if (repo?.kind !== 'checkout') return undefined
  const out = git(repo.root, ['reflog', '--format=%H'])
  if (!out) return undefined
  const shas = [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))]
  for (const sha of shas) {
    const tag = git(repo.root, ['describe', '--tags', '--abbrev=0', sha])
    if (!tag) continue
    const v = stripTag(tag)
    if (v !== currentVersion && tag !== currentNearestTag) return { version: v, tag, sha: sha.slice(0, 12) }
  }
  return undefined
}

/* ------------------------------- upstream -------------------------------- */

async function gh(path) {
  const res = await fetch('https://api.github.com' + path, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-updates-summary',
      ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
    },
  })
  if (!res.ok) { const e = new Error('GitHub ' + res.status + ' for ' + path); e.status = res.status; throw e }
  return res.json()
}

async function fetchReleases(slug) {
  const out = []
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const arr = await gh('/repos/' + slug + '/releases?per_page=100&page=' + page)
    if (!Array.isArray(arr) || arr.length === 0) break
    out.push(...arr)
    if (arr.length < 100) break
  }
  return out
}

async function fetchNpm() {
  const res = await fetch('https://registry.npmjs.org/' + NPM_PKG.replace('/', '%2f'))
  if (!res.ok) throw new Error('npm ' + res.status)
  const j = await res.json()
  return { versions: Object.keys(j.versions ?? {}), tags: j['dist-tags'] ?? {}, time: j.time ?? {} }
}

function remoteTags(repo) {
  const out = git(repo, ['ls-remote', '--tags', 'origin'])
  if (!out) return []
  return out.split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean)
    .map((r) => r.replace('refs/tags/', '')).filter((t) => !t.endsWith('^{}'))
}

function localTags(repo) {
  const out = git(repo, ['tag', '-l'])
  return out ? out.split('\n').filter(Boolean) : []
}

function unionVersions({ releases, npm, tags }) {
  const map = new Map()
  const add = (raw, src, date) => {
    const v = stripTag(raw)
    if (!parseSemver(v)) return
    const e = map.get(v) ?? { version: v, sources: new Set(), publishedAt: undefined }
    e.sources.add(src)
    if (date && (!e.publishedAt || date > e.publishedAt)) e.publishedAt = date
    map.set(v, e)
  }
  for (const r of releases) add(r.tag_name, 'github', r.published_at)
  for (const v of npm.versions) add(v, 'npm', npm.time?.[v])
  for (const t of tags) add(t, 'git', undefined)
  return [...map.values()]
}

/* --------------------------- release note parsing -------------------------- */

function headingSections(body) {
  const marks = []
  const re = /(?:^|\n)(?:#{2,3}\s+([^\n]+)|<h3[^>]*>(.*?)<\/h3>)/g
  let m
  while ((m = re.exec(String(body)))) marks.push({ title: (m[1] || m[2] || '').replace(/<[^>]+>/g, '').trim(), start: m.index })
  const secs = []
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : body.length
    secs.push({ title: marks[i].title, content: String(body).slice(marks[i].start, end) })
  }
  return secs
}

function bullets(content) {
  const out = []
  for (const line of String(content).split('\n')) {
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line)
    if (m) out.push(m[1].replace(/\s+by\s+@[\w.,@\s-]+$/i, '').trim())
  }
  return out
}

const SECTION_MATCHERS = [
  { key: 'features', re: /new feature/i },
  { key: 'improvements', re: /improvement/i },
  { key: 'fixes', re: /bug fix/i },
  { key: 'other', re: /chore|other change/i },
  { key: 'breaking', re: /breaking/i },
  { key: 'removals', re: /removal|deprecat/i },
]

function parseRelease(body) {
  const sections = { breaking: [], features: [], improvements: [], performance: [], fixes: [], other: [], removals: [] }
  const allBullets = []
  for (const s of headingSections(body)) {
    const hit = SECTION_MATCHERS.find((h) => h.re.test(s.title))
    if (!hit) continue
    for (const b of bullets(s.content)) {
      allBullets.push(b)
      sections[hit.key].push(b)
      if (hit.key === 'other' && /breaking|no longer|remove|removed|deprecat/i.test(b)) sections.removals.push(b)
    }
  }
  return { sections, allBullets }
}

/* -------------------------------- commits -------------------------------- */

const COMMIT_MATCHERS = [
  { key: 'features', re: /^feat(\(|!|:)/i },
  { key: 'fixes', re: /^fix(\(|!|:)/i },
  { key: 'performance', re: /^perf(\(|!|:)/i },
  { key: 'other', re: /^(refactor|docs|chore|test|build|ci|style|revert)(\(|!|:)/i },
]

function categorizeCommit(line) {
  const idx = line.indexOf('\t')
  const sha = idx >= 0 ? line.slice(0, idx) : ''
  const message = idx >= 0 ? line.slice(idx + 1) : line
  let section = 'unattributed'
  for (const m of COMMIT_MATCHERS) if (m.re.test(message)) { section = m.key; break }
  const breaking = /^[a-z]+(\([^)]*\))?!:/.test(message) || /BREAKING[ -]CHANGE/.test(message)
  return { sha, message, section, breaking }
}

function localCommitRange(repo, fromTag, toTag) {
  if (repo?.kind !== 'checkout' || !fromTag || !toTag) return undefined
  const exists = (t) => {
    try { execFileSync('git', ['-C', repo.root, 'rev-parse', '--verify', '--quiet', t + '^{commit}'], { stdio: 'ignore' }); return true } catch { return false }
  }
  if (!exists(fromTag) || !exists(toTag)) return undefined
  const out = git(repo.root, ['log', '--no-merges', '--pretty=format:%h%x09%s', fromTag + '..' + toTag]) ?? ''
  const merges = git(repo.root, ['log', '--merges', '--pretty=format:%h%x09%s', fromTag + '..' + toTag]) ?? ''
  return { commits: out.split('\n').filter(Boolean), merges: merges.split('\n').filter(Boolean) }
}

async function compareCommits(slug, base, head) {
  const j = await gh('/repos/' + slug + '/compare/' + encodeURIComponent(base) + '...' + encodeURIComponent(head))
  return {
    commits: (j.commits ?? []).map((c) => c.sha.slice(0, 7) + '\t' + String(c.commit?.message ?? '').split('\n')[0]),
    merges: [],
  }
}

/* ---------------------------------- main ---------------------------------- */

function finish(digest, human, code) {
  let outFailed = false
  if (options.out && code === 0) {
    try { writeFileSync(options.out, JSON.stringify(digest, null, 2)) } catch (e) {
      warn('could not write --out: ' + e.message)
      outFailed = true
    }
  }
  const payload = options.human
    ? human + '\n'
    : (!options.out || code !== 0 || outFailed) ? JSON.stringify(digest, null, 2) + '\n' : null
  // Write synchronously before exiting. process.stdout.write() to a pipe is async,
  // so process.exit() truncates anything past the ~64 KiB pipe buffer; and deferring
  // the exit to a write callback would let main() continue past finish().
  if (payload) {
    const buf = Buffer.from(payload, 'utf8')
    let off = 0
    while (off < buf.length) {
      try { off += writeSync(1, buf, off, buf.length - off) }
      catch (e) { if (e.code === 'EAGAIN') continue; throw e }
    }
  }
  process.exit(outFailed ? 5 : code)
}

function humanNotFound(d) {
  return ['dsh updates digest: REPO_NOT_FOUND',
    '  installed: ' + (d.installed?.version ?? 'unknown'),
    '  searched launcher targets: ' + (d.searched.launcher.length ? d.searched.launcher.join(', ') : '(none)'),
    '  searched npm globals: ' + d.searched.npmGlobal.join(', '),
    '  hint: ' + d.hint].join('\n')
}

function humanDigest(d) {
  const sec = d.sections
  const cs = d.commits.sections
  const n = (a) => (a ? a.length : 0)
  return ['dsh updates digest: OK',
    '  repo:      ' + d.repo.root + ' (' + d.repo.kind + ', via ' + d.repo.resolvedFrom + ')',
    '  installed: ' + (d.installed?.version ?? '?') + (d.installed?.describe ? ' (' + d.installed.describe + (d.installed.aheadBy ? ', +' + d.installed.aheadBy : '') + ')' : ''),
    '  latest:    ' + d.latest.version + ' (' + d.latest.channel + ') from ' + d.latest.sources.join(','),
    '  previous:  ' + (d.previous?.version ?? 'n/a'),
    '  range:     ' + d.range.from + ' -> ' + d.range.to + '  [' + d.range.reason + ']',
    '  releases:  ' + d.range.releases.map((r) => r.version).join(', '),
    '  notes:     breaking ' + n(sec.breaking) + ', features ' + n(sec.features) + ', improvements ' + n(sec.improvements) + ', fixes ' + n(sec.fixes) + ', other ' + n(sec.other) + ', removals ' + n(sec.removals),
    '  commits:   ' + d.commits.total + ' via ' + d.commits.source + ' (features ' + n(cs.features) + ', fixes ' + n(cs.fixes) + ', other ' + n(cs.other) + ', unattributed ' + n(cs.unattributed) + ')',
    d.installedAhead.length ? '  ahead:     ' + d.installedAhead.length + ' non-merge commits past the installed tag' : '',
    '  notices:   ' + (d.notices.length ? d.notices.join(' | ') : 'none'),
  ].filter(Boolean).join('\n')
}

async function main() {
  const repo = resolveRepo()
  const installed = repo ? installedInfo(repo) : (() => { const v = installedFromCli(); return v ? { version: v, source: 'cli' } : undefined })()
  const notices = []

  if (!repo) {
    const digest = {
      status: 'REPO_NOT_FOUND',
      slug: options.slug,
      installed: installed ?? null,
      searched: {
        explicit: options.repo ?? process.env.DSH_REPO ?? null,
        launcher: launcherTargets(),
        npmGlobal: npmGlobalDirs(),
        common: commonDirs(),
        cwdAncestors: ancestors(process.cwd()),
      },
      hint: 'Ask the user for the path to their dsh checkout or installed package, then re-run with --repo <path>.',
    }
    finish(digest, humanNotFound(digest), 2)
  }

  let releases = []
  let npm = { versions: [], tags: {}, time: {} }
  let tags = []
  if (!options.offline) {
    try { releases = await fetchReleases(options.slug) } catch (e) { notices.push('GitHub releases unavailable: ' + e.message) }
    try { npm = await fetchNpm() } catch (e) { notices.push('npm registry unavailable: ' + e.message) }
  } else {
    notices.push('offline mode: upstream release notes and npm versions not fetched')
  }
  if (repo.kind === 'checkout') tags = [...new Set([...(options.offline ? [] : remoteTags(repo.root)), ...localTags(repo.root)])]

  const versions = unionVersions({ releases, npm, tags })
  if (versions.length === 0) {
    const digest = { status: 'NO_UPSTREAM', repo, installed: installed ?? null, notices,
      hint: 'No upstream versions found. Re-run without --offline and check network access to GitHub/npm.' }
    finish(digest, 'dsh updates digest: NO_UPSTREAM (no versions found)', 3)
  }
  const latest = versions.reduce((a, b) => (cmpSemver(b.version, a.version) > 0 ? b : a))

  const tagByVersion = new Map()
  for (const t of tags) { const v = stripTag(t); if (!tagByVersion.has(v)) tagByVersion.set(v, t) }
  for (const r of releases) { const v = stripTag(r.tag_name); if (!tagByVersion.has(v)) tagByVersion.set(v, r.tag_name) }

  const I = installed?.version
  const L = latest.version
  const previous = (repo.kind === 'checkout' && I) ? previousInstall(repo, I, installed.nearestTag) : undefined
  let from = options.from
  let to = options.to
  let reason = 'explicit override'
  if (!from || !to) {
    if (!I) {
      const digest = { status: 'NO_INSTALLED', repo, latest: latest.version, notices,
        hint: 'Installed version not determined. Re-run with --from <version> and --to <version>.' }
      finish(digest, 'dsh updates digest: NO_INSTALLED', 4)
    }
    if (I !== L) { from = from ?? I; to = to ?? L; reason = 'installed differs from latest' }
    else if (previous) { from = from ?? previous.version; to = to ?? I; reason = 'installed equals latest; using previous install' }
    else {
      const digest = { status: 'NO_PREVIOUS', repo, installed, latest: latest.version, notices,
        hint: 'Installed already equals the latest; previous install could not be derived. Re-run with --from <version>.' }
      finish(digest, 'dsh updates digest: NO_PREVIOUS (installed is already latest)', 4)
    }
  }

  const ascending = [...versions].sort((a, b) => cmpSemver(a.version, b.version))
  const releaseByVersion = new Map()
  for (const r of releases) { const v = stripTag(r.tag_name); if (!releaseByVersion.has(v)) releaseByVersion.set(v, r) }

  const inRange = ascending.filter((v) => cmpSemver(v.version, from) > 0 && cmpSemver(v.version, to) <= 0)

  // Cumulative release notes: seed fuzzy-match sets from every release at or
  // before `from`, then drop in-range bullets that merely restate them.
  const seed = []
  const seedAttention = []
  for (const v of ascending) {
    if (cmpSemver(v.version, from) > 0) continue
    const r = releaseByVersion.get(v.version)
    if (!r) continue
    const parsed = parseRelease(r.body)
    for (const b of parsed.allBullets) seed.push(tokenSet(b))
    for (const key of ['breaking', 'removals']) for (const b of parsed.sections[key]) seedAttention.push(tokenSet(b))
  }
  const isDup = (set, list) => list.some((t) => similar(set, t) >= 0.6)
  const sections = { breaking: [], features: [], improvements: [], performance: [], fixes: [], other: [], removals: [] }
  for (const v of inRange) {
    const r = releaseByVersion.get(v.version)
    if (!r) { notices.push('no GitHub release notes for ' + v.version); continue }
    const parsed = parseRelease(r.body)
    // Chores that change public surface (APIs, defaults, formats) are also
    // surfaced as attention items so a reader cannot miss them.
    for (const b of parsed.sections.other) {
      if (/breaking|no longer|remov|deprecat|api change|migrat|renam|replac/i.test(b)) parsed.sections.breaking.push(b)
    }
    for (const key of ['features', 'improvements', 'performance', 'fixes', 'other']) {
      for (const b of parsed.sections[key] ?? []) {
        const t = tokenSet(b)
        if (isDup(t, seed)) continue
        seed.push(t)
        sections[key].push({ text: b, release: v.version, url: r.html_url })
      }
    }
    for (const key of ['breaking', 'removals']) {
      for (const b of parsed.sections[key] ?? []) {
        const t = tokenSet(b)
        if (isDup(t, seedAttention)) continue
        seedAttention.push(t)
        sections[key].push({ text: b, release: v.version, url: r.html_url })
      }
    }
  }

  const fromTag = tagByVersion.get(from) ?? 'dsh-v' + from
  const toTag = tagByVersion.get(to) ?? 'dsh-v' + to
  let commitData = localCommitRange(repo, fromTag, toTag)
  let commitSource = 'git-local'
  if (!commitData && !options.offline) {
    try { commitData = await compareCommits(options.slug, fromTag, toTag); commitSource = 'github-compare' }
    catch (e) { notices.push('commit compare unavailable: ' + e.message) }
  }
  if (!commitData) { commitData = { commits: [], merges: [] }; commitSource = 'unavailable' }

  const commits = commitData.commits.map(categorizeCommit)
  const commitSections = { features: [], fixes: [], performance: [], other: [], unattributed: [] }
  for (const c of commits) (commitSections[c.section] ?? commitSections.unattributed).push(c)

  let installedAhead = []
  if (repo.kind === 'checkout' && installed.aheadBy > 0 && installed.nearestTag) {
    const out = git(repo.root, ['log', '--no-merges', '--pretty=format:%h%x09%s', installed.nearestTag + '..HEAD']) ?? ''
    installedAhead = out.split('\n').filter(Boolean).map(categorizeCommit)
  }

  const digest = {
    status: 'OK',
    generatedAt: new Date().toISOString(),
    slug: options.slug,
    repo: { kind: repo.kind, root: repo.root, resolvedFrom: repo.resolvedFrom },
    installed: installed ?? null,
    latest: { version: latest.version, channel: channelOf(latest.version), publishedAt: latest.publishedAt ?? null, sources: [...latest.sources], tag: tagByVersion.get(latest.version) ?? null },
    previous: previous ?? null,
    range: {
      from, to, reason,
      releases: inRange.map((v) => ({
        version: v.version, channel: channelOf(v.version), publishedAt: v.publishedAt ?? null,
        sources: [...v.sources], url: releaseByVersion.get(v.version)?.html_url ?? null,
      })),
    },
    sections,
    commits: {
      source: commitSource, total: commits.length, mergeCount: commitData.merges.length,
      sections: commitSections,
    },
    installedAhead,
    npmDistTags: npm.tags,
    sources: {
      releases: inRange.map((v) => releaseByVersion.get(v.version)?.html_url).filter(Boolean),
      compare: fromTag && toTag ? 'https://github.com/' + options.slug + '/compare/' + fromTag + '...' + toTag : null,
      npm: 'https://www.npmjs.com/package/' + NPM_PKG,
    },
    notices,
  }

  finish(digest, humanDigest(digest), 0)
}

main().catch((e) => { warn('fatal: ' + (e?.stack ?? e)); process.exit(1) })
