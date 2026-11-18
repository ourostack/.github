# Ship the smallest unit that lands, and ship as you go

Shared guidance for every agent and person working in ourostack, spoonjoy and arimendelow repositories. Each repository's AGENTS.md points here.

**Ship the smallest unit that lands.** A change is one verifiable increment that merges to `main` on its own: the smallest one that is correct, tested and useful. Split larger work into a sequence of such increments rather than one ambitious change that waits to land whole.

**Ship as you go: never hold finished work for the end.** Ari, 2026-11-18: "are you not shipping as you go? if you are keeping all your changes to the end, you are working wrong!!! ... this needs to be durable guidance for ALL agents EVER". The person should see the product change through the session, increment by increment, not all at once in a final report.

- **Each increment goes live as soon as it's done.** Once it's reviewed and green, it merges, deploys, and you check the live surface. Then start the next increment. A pass of fixes is a stream of merges, not a branch that grows until the pass ends.
- **Don't wait on a sibling.** "When X lands too", "in one PR with the others" and "after the last item" are signs of batching. Pin, document and publish each release as it ships; the next one follows on its own.
- **Update every surface the change touches in the same PR.** That includes the README, `llms.txt`, docs pages, the site and the screenshots. A change people or models can't see on the surfaces they read hasn't shipped.
- **Say where it's live.** Report each merge with the live URL or the tag it shipped in, so the person can look while you keep working.
- **A surface you can't update is a blocker.** If the page people watch (a results page, a status page) can't change until someone acts, ask that person as soon as you know, with the exact thing needed. Don't carry it as a quiet item for a morning summary.

The direction behind this rule, and the principles it follows, are in the [Epoch 3 RFC](https://github.com/ourostack/desk/blob/main/plugins/desk/docs/agentic-engineering-v3-rfc.md), section "State and flow" (trunk-based, in the smallest unit that lands).
