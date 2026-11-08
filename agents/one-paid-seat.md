# One paid seat, ever

Shared guidance for every agent and person working in ourostack and spoonjoy repositories. Each repository's AGENTS.md points here.

**arimendelow is the only member of ourostack and spoonjoy, and the only account that holds a paid seat in the Ouro Labs enterprise.** Ari, 2026-11-07: "only me as member, ever - everyone else outside collaborator, nobody else paid ever!!!".

## How people and agents get access

- **Contributors** are outside collaborators on public repositories, or send PRs from forks. Both are free.
- **Nobody else is ever made an org member, invited to an org, or given access to a private repository.** Each of those takes a paid seat (GitHub's [license rules](https://docs.github.com/en/enterprise-cloud@latest/billing/reference/github-license-users)).
- **Agents act as Ari** (his signed-in `gh`) **or through a GitHub App.** Never create a machine account and add it to an org.

Only enterprise owners can invite outside collaborators, and members cannot create repositories: both are enterprise policies at https://github.com/enterprises/ouro/settings/member_privileges.

## The seat guard

Every [PR clock](prs-merge-within-30-minutes.md#the-pr-clock) run leads the pinned issue with one line:

- `🟢 Seats: 1 (arimendelow)`: as it should be.
- `🔴 Seats: 2. Only arimendelow may hold a seat: ...`: names each extra account and why it holds a seat (org member, pending org invitation, outside collaborator on a private repository, pending private repository invitation). Make it an outside collaborator on public repositories only, or remove it.
- `⚪ Seats: not checked`: the token could not read org membership, so the guard says nothing rather than call it clear.

The code is [`tools/pr-clock/seat-guard.mjs`](../tools/pr-clock/seat-guard.mjs); its test feeds a fake second member and expects red.
