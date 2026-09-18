---
name: dsh-updates-summary
description: Summarize every aspect of dsh (DeepSeek Harness) changes between the installed version and the newest published version across all channels (alpha/beta/rc/stable), then write a Markdown report. Use for "what's new in dsh", "summarize dsh updates/changelog", or deciding whether to upgrade dsh.
whenToUse: Any request to summarize dsh release/update history, enumerate what changed since the installed dsh, or diff an installed dsh version against the newest published release, whether or not that release is installed.
---

# dsh Updates Summary

Produce a complete but focused, evidence-backed summary of every dsh change
between the **installed** version and the **newest published** version, then
write it to a Markdown file in the working directory. Cover every category -
new features, improvements, performance, bug fixes, chores, dependencies,
breaking/API changes, and removals - but do not enumerate commits: group
related changes into short themed bullets. Completeness means no change is
missed, not that every commit gets its own line. Aim for a report the reader
can scan in a couple of minutes (roughly 60-120 lines).

## Inputs

- the dsh repo path (only needed when auto-discovery fails)
- optional explicit `from` and `to` versions

## Step 1 - Collect the digest

Run the bundled collector once. Its default home is
`$DSH_HOME/skills/dsh-updates-summary`; if this skill was loaded, prefer the
resource-base directory reported with it.

```sh
# Run from the project root. --out is cwd-relative, so the digest lands at
# <cwd>/.dsh-updates-digest.json; running from elsewhere silently creates a
# second digest and the two diverge.
node "$DSH_HOME/skills/dsh-updates-summary/scripts/collect.mjs" --out "$PWD/.dsh-updates-digest.json"
```

Then read `.dsh-updates-digest.json` with the read tool. The collector resolves
the repo, the installed version, the previous installed version, the newest
upstream version (any channel), the range, release notes, and the commit log.
Every field and exit code is documented in `reference/digest-schema.md`.

## Step 2 - Handle failures

| exit | status | action |
|---|---|---|
| 0 | OK | continue to step 3 |
| 2 | REPO_NOT_FOUND | **ask the user for their dsh repo path**, then re-run with `--repo <path>` |
| 3 | NO_UPSTREAM | report that upstream could not be reached; suggest `GITHUB_TOKEN` or `--offline` |
| 4 | NO_INSTALLED / NO_PREVIOUS | ask for explicit `--from` (and optionally `--to`) |
| 5 | OUT_WRITE_FAILED | `--out` could not be written; the digest was printed to stdout instead - use it from there |

If the repo cannot be found autonomously you MUST ask the user for the path
before doing anything else. Never guess a path and never silently skip the task.

## Step 3 - Build the report

Use BOTH sources so nothing is missed:

- `sections` - the release-note narrative, already delta-filtered against
  everything at or before the range start (cumulative release notes are
  subtracted, including reworded repeats).
- `commits.sections` - the granular commit log (`features`, `fixes`,
  `performance`, `other`, `unattributed`), which catches changes that never
  made the release notes.

Rules:

- Lead with breaking/attention items.
- Attribute every item to its release version.
- English output by default; match the user if they asked for another language.
- Never invent an item: every line must trace to the digest.
- Fold duplicate commit entries into their release-note counterpart.
- When a section has commits but no release note (for example
  `commits.sections.performance` is non-empty while `sections.performance` is
  empty), cover it from the commit subjects and mark those bullets as coming
  from the commit log. Never drop a change silently.
- If `notices` is non-empty, add a short limitations note.
- If `installedAhead` is non-empty, mention the extra commits the installed
  build carries beyond the tag.
- If `latest.channel` is a pre-release, say so; never present a pre-release as
  stable.
- **Be concise.** Group related entries into one themed bullet and describe the
  user-facing effect; never paste the full per-commit list. The commit log is an
  input for catching omissions, not report content.
- Represent low-signal churn (tests, docs, refactors, style, CI) as a one-line
  summary with counts per type, and mention only notable individual items.
- Include a commit SHA only when it disambiguates something the reader needs
  (for example a revert, or a change with no release note).

## Step 4 - Write the report file

Write to `<cwd>/dsh-updates-<from>-to-<to>.md`, using the digest
`range.from` and `range.to` verbatim. Example:
`dsh-updates-0.1.5-alpha.1-to-0.1.5-rc.1.md`.

Structure (omit a section only when it has no items):

    # dsh updates: <from> -> <to>
    _Installed <installed>; latest <latest>; <n> releases; <m> commits; <dates>; channel <channel>_

    ## 1. Breaking changes and attention items
    ## 2. New features
    ## 3. Improvements
    ## 4. Performance
    ## 5. Bug fixes
    ## 6. Other changes (chores, docs, dependencies, CI)
    ## 7. Plugin and API changes
    ## 8. Removals and deprecations
    ## 9. Coverage and sources

Formatting rules:

- One short bullet per distinct change, tagged with its release version (or
  grouped under a release heading).
- Do NOT include a per-commit appendix or dump `commits.sections`. Fold
  duplicates into their release-note counterpart.
- Summarize low-signal churn (tests, docs, refactors, style, CI) with counts,
  not a list.
- Keep output scannable: target roughly 60-120 lines.

In section 9 list the release URLs, the compare URL, the npm package URL, and
any `notices`.

## Step 5 - Reply

Summarize the same content in chat (do not only link the file) and name the
written file.

## Quality gate

- Range matches the rule: installed != latest -> installed..latest;
  installed == latest -> previous..installed.
- Every digest release appears somewhere; every breaking item is in section 1.
- The report is concise: no per-commit listing or full commit-log dump, and
  related commits are grouped by theme.
- The report file exists at the stated path and is non-empty.
