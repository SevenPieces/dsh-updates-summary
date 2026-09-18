# collect.mjs digest schema

Emitted by `scripts/collect.mjs`. Read the `--out` file, not stdout.

## Range rule

- Resolve installed `I` (checkout -> `apps/cli/package.json`; otherwise the
  installed package manifest or `dsh --version`).
- Resolve latest `L` = highest semver across the union of GitHub releases, npm
  versions, and git tags (all channels: alpha/beta/rc/lts/stable).
- `I != L` -> `from = I`, `to = L`.
- `I == L` -> `from = previous install`, `to = I`; the previous install is
  read from the checkout reflog.
- Explicit `--from` / `--to` always win.

## Exit codes

| code | status | meaning |
|---|---|---|
| 0 | OK | digest produced |
| 1 | (stderr) | unexpected fatal error |
| 2 | REPO_NOT_FOUND | repo not found; ask the user for the path, re-run with `--repo` |
| 3 | NO_UPSTREAM | no upstream versions found (usually offline) |
| 4 | NO_INSTALLED / NO_PREVIOUS | range could not be derived; pass `--from`/`--to` |
| 5 | OUT_WRITE_FAILED | `--out` could not be written; the digest was printed to stdout instead. With `--human` only the human summary is printed (human mode replaces the JSON by design) |

## Top-level fields

- `status` - `OK` or an error status.
- `generatedAt` - ISO timestamp.
- `slug` - GitHub repo slug used for upstream lookups.
- `repo` - `{ kind: checkout|package, root, resolvedFrom }`.
- `installed` - `{ version, sha, longSha, describe, nearestTag, aheadBy, source }`.
- `latest` - `{ version, channel, publishedAt, sources, tag }`.
- `previous` - `{ version, tag, sha }` or null.
- `range` - `{ from, to, reason, releases[] }`; each release has
  `version, channel, publishedAt, sources, url`.
- `sections` - release-note items, delta-filtered. Keys: `breaking`,
  `features`, `improvements`, `performance`, `fixes`, `other`,
  `removals`. Each item is `{ text, release, url }`.
- `commits` - `{ source, total, mergeCount, sections }` where sections are
  `features`, `fixes`, `performance`, `other`, `unattributed`; each
  commit is `{ sha, message, section, breaking }`. `source` is
  `git-local`, `github-compare`, or `unavailable`.
- `installedAhead` - commits the installed build has beyond its nearest tag.
- `npmDistTags` - npm dist-tags (`latest`, `alpha`, ...) for channel context.
- `sources` - `{ releases[], compare, npm }` URLs.
- `notices` - degradations (rate limits, missing release notes, offline mode).

## Flags

- `--repo PATH` (or `$DSH_REPO`) - explicit repo path.
- `--from V` / `--to V` - explicit range endpoints.
- `--slug owner/repo` - override the upstream slug.
- `--offline` - skip GitHub/npm; use local git tags only.
- `--out FILE` - write the digest JSON here.
- `--human` - print a human summary instead of the JSON.
- `-h, --help` - print usage and exit immediately, without touching the network or writing anything.
- `GITHUB_TOKEN` / `GH_TOKEN` - raise the GitHub API rate limit.

## Read-only guarantee

The collector never mutates the repository: it uses `git ls-remote` (never
`git fetch`), `git log`, `git describe`, and `git reflog`. It writes only the
optional `--out` file.
