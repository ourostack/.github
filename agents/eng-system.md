# Our engineering system: apply it to any repo

Shared guidance for any agent asked to bring a repository up to our engineering system, in ourostack, spoonjoy or anywhere else Ari works. Hand an agent this page and a list of repos; it has everything needed to do the work.

The aim is code agents can trust, so an agent checks an agent's work and people review only what checks can't judge. Ari's constraint is to keep overhead as light as possible: prefer a check over prose, an edit over a new skill, and deleting over adding. Every step below should leave a repository's always-loaded instructions the same size or smaller.

Ideas come in as "drops" (a talk, a post) and are tried on our own repos first. A step is listed here only once it has shipped and paid off. Sources so far: Lauren Tan, ["All Code Is Slop (Except Mine)"](https://youtu.be/O_zcc6Xl12g), and Vincent's ["OpenClaw CI cost reduction"](https://vincent.build/openclaw-ci-cost-reduction/).

## Before you start

- Update Desk. Its `fast-honest-ci`, `curator` and `lesson-capture` skills carry the general rules ([desk#1119](https://github.com/ourostack/desk/pull/1119), [desk#1150](https://github.com/ourostack/desk/pull/1150)): turn a correction into a check before writing prose, and never pay to test the same tree twice.
- Work one repository at a time, one PR per step, published as [every PR merges fast](prs-merge-within-30-minutes.md) says. Measure before and after; a step that doesn't pay off in that repo gets dropped, with the reason.
- Your organization may restrict GitHub Actions from outside it. Then copy the script in, and don't call it from here.

## The steps, per repository

1. **A fast linter with a baseline.** If the repo has no linter, add oxlint (TypeScript) or the language's fast equivalent, run in CI's existing quality step. Record the hits that already exist per file and rule, so only new hits fail and a PR can't raise its own baseline. It should add seconds, not minutes. Example: [spoonjoy-v2#740](https://github.com/spoonjoy/spoonjoy-v2/pull/740).
2. **AGENTS.md: every rule is a check or a judgment.** For each "never" or "always" line, do one of three things. Name the check that enforces it, as "(enforced: …)". Turn it into a check whose error names the fix. Or delete it, if no check could ever fail on it ("keep it simple") or something else already enforces it. Prove "already enforced" before deleting. Move CI and release mechanics out to `contributing/` docs. Examples: [ouro-ui#1928](https://github.com/ourostack/ouro-ui/pull/1928), [ouroboros#1382](https://github.com/ourostack/ouroboros/pull/1382), [spoonjoy-v2#748](https://github.com/spoonjoy/spoonjoy-v2/pull/748).
3. **Delete agent leftovers.** Old planning files, notes and scratch scripts committed into a product repo get copied by the next agent. Delete them in one PR; Git keeps the history. Example: [ouro-md#188](https://github.com/ourostack/ouro-md/pull/188).
4. **Comments: measure, don't ban.** Sample about 150 comments that sit inside code, plus 50 doc blocks, and sort each one: repeats the code, out of date, excuses a shortcut, should be a check, or useful. In our repos 62–81% were useful, so we fail only the bad kinds: doc blocks left describing nothing, and one-liners that repeat the code. Example: [ouro-ui#1943](https://github.com/ourostack/ouro-ui/pull/1943).
5. **Never test the same tree twice.** A push to the default branch skips any job whose git tree (`HEAD^{tree}`) already passed the full suite on its PR or in the merge queue, and links that proof. It runs everything when there is no proof. Skip a job in its `if:`, before a runner starts. Examples: [ouro-ui#1945](https://github.com/ourostack/ouro-ui/pull/1945), [#1947](https://github.com/ourostack/ouro-ui/pull/1947). In ouro-ui, re-runs like this had cost about 200,000 Linux minutes in one day.
6. **Expensive runners wait.** macOS (and other costly) PR jobs start only after a cheap check confirms the commit is still the PR's head. Batch review fixes into one push. Shard counts are set from measured times and can't grow unchecked ([desk#1150](https://github.com/ourostack/desk/pull/1150)).
7. **One statechart pass on the scariest state machine.** Use [pstack's `/statechart`](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart) on whatever syncs, queues or retries. It writes a small model, checks every order of events, and draws the path to each broken rule. On Spoonjoy's offline sync queue, about two hours found a bug that loses user edits, with the fix in [spoonjoy-apple#393](https://github.com/spoonjoy/spoonjoy-apple/pull/393). Keep it as a review artifact for that code only if it finds something real.

## What we chose not to adopt

- No blanket comment ban: measured, most of our comments earn their place (step 4).
- No ban on Markdown in a desk: it is the desk's format. Leftovers in product repos are step 3.
- Lint is not proof of behaviour: only tests and runs of the real app prove that.
- Taste review stays for what checks can't measure.
- PR volume is not a goal; time to merge and time to live are.

## Feeding back

When a step needs changing, change it here, by PR. A lesson for every agent goes into the Desk skill that owns it (`fast-honest-ci` for CI, `curator` for turning corrections into checks), not into a repository's AGENTS.md.
