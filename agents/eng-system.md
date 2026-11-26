# Our engineering system: apply it to any repo

The one page any agent follows to make a repository or product the best it can be, in ourostack, spoonjoy or anywhere else Ari works. Hand an agent this page and a list of repos; it has everything needed to do the work.

## The goal

**The shortest dev loop at the highest confidence.** Ari, 2026-11-19: by "best possible", "i mostly mean shortest dev loop possible with highest confidence possible". The loop runs from "I want to make a change" to live for users; confidence means main stays green and what lands is proven. **[The pursuit of excellence does not need justification](https://bjornjohansen.com/pursuit-of-excellence/):** a faster loop needs no savings case. Measurements choose the order of the work, never whether a shorter loop is worth having. The rules this page serves: [a change goes live in seconds](changes-live-in-seconds.md), [every PR merges fast](prs-merge-within-30-minutes.md) and [ship the smallest unit that lands](ship-the-smallest-unit.md). This page makes the loop short; [keep the work moving, and count only what ships](keep-the-work-moving.md) keeps it from sitting idle.

Keep overhead as light as possible: a check over prose, an edit over a new skill, deleting over adding. Every step leaves a repository's always-loaded instructions the same size or smaller.

## 0. Measure the loop

Before any step, and again after each one:

```sh
node tools/pr-clock/loop.mjs owner/repo --days 7   # from a clone of ourostack/.github; needs a logged-in gh
```

It prints the median and p90 from PR opened to merged, merged to live (the first successful deployment after the merge; `--env` picks one) and opened to live, the share of the time the default branch was red and of its commits whose checks ended red, and the checks that turned it red most often. A repository without deployments reports its loop to merge; add a deployment record to its deploy job so "live" can be measured. Then find where the time goes with Desk's `fast-honest-ci` skill. Record the before and after numbers in the PR that changes them; a step that makes neither number better in that repo gets dropped, with the reason.

## Before you start

- Update Desk. Its `fast-honest-ci`, `curator` and `lesson-capture` skills carry the general rules ([desk#1119](https://github.com/ourostack/desk/pull/1119), [desk#1150](https://github.com/ourostack/desk/pull/1150)): turn a correction into a check before writing prose, and never pay to test the same tree twice.
- Work one repository at a time, one PR per step, published as [every PR merges fast](prs-merge-within-30-minutes.md) says.
- Your organization may restrict GitHub Actions from outside it. Then copy the script in, and don't call it from here.

## The steps, per repository

1. **A fast linter with a baseline.** If the repo has no linter, add oxlint (TypeScript) or the language's fast equivalent, run in CI's existing quality step. Record the hits that already exist per file and rule, so only new hits fail and a PR can't raise its own baseline. It should add seconds, not minutes. Example: [spoonjoy-v2#740](https://github.com/spoonjoy/spoonjoy-v2/pull/740).
2. **AGENTS.md: every rule is a check or a judgment.** For each "never" or "always" line, do one of three things. Name the check that enforces it, as "(enforced: …)". Turn it into a check whose error names the fix. Or delete it, if no check could ever fail on it ("keep it simple") or something else already enforces it. Prove "already enforced" before deleting. Move CI and release mechanics out to `contributing/` docs. Then hold the cut: copy Desk's [`agents-md-budget.mjs`](https://github.com/ourostack/desk/blob/main/plugins/desk/skills/lesson-capture/agents-md-budget.mjs) into the repository, run `--set` once and run it in CI, so AGENTS.md grows only by a PR that raises its budget and says why. Example: [spoonjoy-v2#798](https://github.com/spoonjoy/spoonjoy-v2/pull/798). Examples: [ouro-ui#1928](https://github.com/ourostack/ouro-ui/pull/1928), [ouroboros#1382](https://github.com/ourostack/ouroboros/pull/1382), [spoonjoy-v2#748](https://github.com/spoonjoy/spoonjoy-v2/pull/748).
3. **Delete agent leftovers.** Old planning files, notes and scratch scripts committed into a product repo get copied by the next agent. Delete them in one PR; Git keeps the history. Example: [ouro-md#188](https://github.com/ourostack/ouro-md/pull/188).
4. **Comments: measure, don't ban.** Sample about 150 comments that sit inside code, plus 50 doc blocks, and sort each one: repeats the code, out of date, excuses a shortcut, should be a check, or useful. In our repos 62–81% were useful, so we fail only the bad kinds: doc blocks left describing nothing, and one-liners that repeat the code. Example: [ouro-ui#1943](https://github.com/ourostack/ouro-ui/pull/1943).
5. **Never test the same tree twice.** A push to the default branch skips any job whose git tree (`HEAD^{tree}`) already passed the full suite on its PR or in the merge queue, and links that proof. It runs everything when there is no proof. Skip a job in its `if:`, before a runner starts. Examples: [ouro-ui#1945](https://github.com/ourostack/ouro-ui/pull/1945), [#1947](https://github.com/ourostack/ouro-ui/pull/1947). In ouro-ui a proven push runs 2 jobs (about 4 job-minutes) instead of about 102 (about 485). It only helps when main hasn't moved since the PR's run, which was 2 of 3 pushes in a small first sample; measure that rate before counting savings. Measured over 73 hours, runs cancelled by a newer push were only 3% of ouro-ui's minutes; most cancels were fail-fast after a red job.
6. **Expensive runners wait.** macOS (and other costly) PR jobs start only after a cheap check confirms the commit is still the PR's head. Batch review fixes into one push. Shard counts are set from measured times and can't grow unchecked ([desk#1150](https://github.com/ourostack/desk/pull/1150)).
7. **One statechart pass on the scariest state machine.** Use [pstack's `/statechart`](https://github.com/cursor/plugins/tree/main/pstack/skills/statechart) on whatever syncs, queues or retries. It writes a small model, checks every order of events, and draws the path to each broken rule. On Spoonjoy's offline sync queue, about two hours found a bug that loses user edits, with the fix in [spoonjoy-apple#393](https://github.com/spoonjoy/spoonjoy-apple/pull/393). Keep it as a review artifact for that code only if it finds something real.
8. **One trunk.** Branches live hours, have one author (a person and their agents) and are deleted on merge (`branch-prune` here does it). A release branch is cut when needed and deleted after its release (`branch-prune` deletes one 14 days after its tip was tagged). Fix a bug on main, then cherry-pick it to a release branch; never fix on the release branch and merge down. Unfinished work lands behind a flag, never on a long branch. Before adding a merged-tree build (a merge queue) against red main, read what turns main red: in ouro-ui, after it left its queue, main's CI pushes failed 14–29% of the time, but most red commits were checks the next commit passed (a runner-speed gate, a macOS lane), and a queue would only turn those into dequeues. Fix the most frequent red check first; a queue pays only for clean merges that break each other. Source: [trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/).

9. **The release path runs where runners are free.** Measure queue wait apart from work, per runner pool: when one pool queues, every job that a release waits on (plan, publish, record, promote) moves to a pool that isn't queuing, proven first by a probe that runs its steps there and, for builds, compares the outputs file by file. Watchers that poll GitHub read slowly while jobs wait for runners and quickly only near the end, and they treat a quota refusal as a wait, not an answer. In one app on 2026-11-23, Linux jobs waited a median 21 minutes while Windows and Macs started in 1-7. Moving the release path off Linux, plus the steps above, took merge to the release users get from 67 minutes to 36.

## What we chose not to adopt

- No blanket comment ban: measured, most of our comments earn their place (step 4).
- No ban on Markdown in a desk: it is the desk's format. Leftovers in product repos are step 3.
- Lint is not proof of behaviour: only tests and runs of the real app prove that.
- Taste review stays for what checks can't measure.
- PR volume is not a goal; time to merge and time to live are.

## Feeding back

Ideas come in as "drops" (a talk, a post, a site) and are tried on our own repos first; a step is listed here only once it has shipped and paid off. Sources so far: Lauren Tan, ["All Code Is Slop (Except Mine)"](https://youtu.be/O_zcc6Xl12g); Vincent's ["OpenClaw CI cost reduction"](https://vincent.build/openclaw-ci-cost-reduction/); [trunkbaseddevelopment.com](https://trunkbaseddevelopment.com/); and Bjørn Johansen's ["The pursuit of excellence does not need justification"](https://bjornjohansen.com/pursuit-of-excellence/).

When a step needs changing, change it here, by PR. A lesson for every agent goes into the Desk skill that owns it (`fast-honest-ci` for CI, `curator` for turning corrections into checks), not into a repository's AGENTS.md.
