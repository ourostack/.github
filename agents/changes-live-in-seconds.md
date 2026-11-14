# A change goes live in seconds: single-digit minutes is the outer limit

Shared guidance for every agent and person working in ourostack, spoonjoy and arimendelow repositories. Each repository's AGENTS.md points here.

**A change cannot take more than single-digit minutes to go live.** Ari, 2026-11-13: "generally, changes to these websites cannot take more than single-digit minutes", and "***changes cannot take more than single-digit minutes to get deployed***".

**The clock runs from "I want to make a change" to live for users.** It counts everything in between: CI, any queue, the merge, the release and the deploy, not just the time CI spends working. Earlier the same day, with the ouro-ui merge queue taking about 25 minutes per PR, Ari said that "should take that long to merge ALL the prs / in fact, they should all be merged winthin SINGLE DIGIT MINUTES".

**The target is the fastest we can build, seconds wherever a design allows it.** Single-digit minutes is the outer limit, never the goal, and the numbers are illustrative: the aim is excellence. Ari, 2026-11-13: "i will also clarify that the times i am giving you are demonstrative. if you can design a CI that goes from "i want to make a change" to "live" in seconds, that is what you should do :) pURSUE EXCELLENCEEEE". He pointed at dhh, who "WAS able to get omarchy, an entire operating system, to be installable in single digit SECONDS. he is your tony stark in this scenario".

**No slowness is acceptable just because it is familiar.** Ari, 2026-11-13: "pursue excellence, and stop being accepting of this absurdity!!!!! … we OWN all this, it's FLEDGLING, there is ZERO reason we are not pursuing excellence - shortest possible times, things moving as quickly as possible, the whole shebang!" and "THE PURSUIT OF EXCELLENCE REQUIRES NO JUSTIFICATION :)".

## Make the gate faster; never trade it for speed

Never skip, weaken or bypass a check to go faster. Make the check itself fast:

- Fix a slow test at its cause, rather than raising its timeout.
- Shard by measured time, cache what doesn't change, and split long jobs so they run side by side.
- Run only the checks a change can affect, where that selection is provably safe.
- Deploy straight from main, so a merge is a release.

If the current design can't meet the limit, redesign the pipeline (the queue, the release, the deploy) rather than accept the slowness. Ari, 2026-11-13: "get this … through ASAP, and totally redesign the way we approach it if needed". A slow pipeline is a bug to fix now, not a fact to report.

## When a change takes longer

Whoever sees a change take longer says so on that repository's CI-speed issue, with measurements: where the time went, step by step. Then they fix it, or name who will. Don't just wait.

Desk's [fast-honest-ci skill](https://github.com/ourostack/desk/blob/main/plugins/desk/skills/fast-honest-ci/SKILL.md) has the how: measuring a pipeline, finding its critical path and making each step faster without hiding a failure.

Merging fast is part of this clock: see [Every PR merges fast](prs-merge-within-30-minutes.md).
