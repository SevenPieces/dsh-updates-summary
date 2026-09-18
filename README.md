# dsh-updates-summary

An agent skill that summarizes **every** change between your installed
[dsh](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness) and
the newest published version across all channels (alpha / beta / rc / stable),
then writes a Markdown report.

The report is complete but scannable: related changes are grouped into short
themed bullets, typically 60-120 lines. Completeness means no change is missed,
not that every commit gets its own line.

## What a run produces

`dsh-updates-<from>-to-<to>.md` in the working directory - for example
`dsh-updates-0.1.5-alpha.1-to-0.1.5-rc.1.md` - with nine sections:

1. Breaking changes and attention items
2. New features
3. Improvements
4. Performance
5. Bug fixes
6. Other changes (chores, docs, dependencies, CI)
7. Plugin and API changes
8. Removals and deprecations
9. Coverage and sources

It is built from **two** sources so nothing slips through: the release-note
narrative (delta-filtered, so cumulative notes are subtracted) and the granular
commit log, which catches changes that never made the release notes.

## Requirements

- **Node.js 18 or newer.** The collector uses only the standard library, so
  there is nothing to install.
- A local dsh checkout. The collector auto-discovers it; when it cannot, the
  skill asks you for the path instead of guessing.
- Optional: `GITHUB_TOKEN` or `GH_TOKEN` to raise GitHub API rate limits, and
  `DSH_REPO` to point at the checkout.

## Install

Clone into your harness's skills directory, keeping the directory name equal to
the `name:` in the frontmatter:

```sh
git clone <repo-url> ~/.dsh/skills/dsh-updates-summary
# Claude Code
git clone <repo-url> ~/.claude/skills/dsh-updates-summary
```

## Usage

Ask "what's new in dsh", "summarize the dsh changelog", or "should I upgrade
dsh". The range rule is fixed: when the installed version differs from the
latest, the range is `installed..latest`; when they are equal, it is
`previous..installed`.

### Running the collector directly

Run it **from your project root**: `--out` is cwd-relative, so running it
elsewhere silently creates a second digest and the two diverge.

```sh
node "$DSH_HOME/skills/dsh-updates-summary/scripts/collect.mjs" --out "$PWD/.dsh-updates-digest.json"
```

| Option | Meaning |
|---|---|
| `--repo PATH` | dsh repository path (env: `DSH_REPO`) |
| `--from V` | start version/tag of the range |
| `--to V` | end version/tag of the range |
| `--slug owner/repo` | upstream repository slug |
| `--offline` | skip all network calls |
| `--out FILE` | write the JSON digest to FILE |
| `--human` | print a human-readable summary instead of JSON |
| `-h`, `--help` | print help and exit |

The digest resolves the repo, the installed version, the previous installed
version, the newest upstream version on any channel, the range, release notes
and the commit log. Every field is documented in
[`reference/digest-schema.md`](reference/digest-schema.md).

### Exit codes

| Exit | Status | What the skill does |
|---|---|---|
| 0 | OK | continue |
| 2 | REPO_NOT_FOUND | asks you for the dsh repo path, then re-runs with `--repo` |
| 3 | NO_UPSTREAM | reports that upstream is unreachable; suggests `GITHUB_TOKEN` or `--offline` |
| 4 | NO_INSTALLED / NO_PREVIOUS | asks for an explicit `--from` (and optionally `--to`) |
| 5 | OUT_WRITE_FAILED | `--out` was not writable; the digest was printed to stdout instead |

## Repository layout

```
SKILL.md                        the skill itself - start here
reference/digest-schema.md      every digest field and exit code
scripts/collect.mjs             the collector: repo, versions, notes, commits
```

## Report rules

- Breaking and attention items lead, and every item is attributed to its
  release version.
- Nothing is invented: every line traces to the digest.
- A section that has commits but no release note is still covered, from the
  commit subjects, and marked as coming from the commit log.
- Low-signal churn (tests, docs, refactors, style, CI) is summarized with counts
  rather than listed.
- Pre-releases are labelled as pre-releases and never presented as stable.
- A commit SHA appears only when it disambiguates something the reader needs,
  such as a revert.

## Limitations

- The report is deliberately concise. The commit log is an input for catching
  omissions, not report content, and there is no per-commit appendix.
- Scope is dsh itself. It does not diff plugins or unrelated repositories.
- Release-note parsing depends on upstream note formatting; when the collector
  reports a notice, a short limitations note is added to the report.

## License

MIT - see [LICENSE](LICENSE).
