# Interfaces follow Ouro UI

Shared guidance for every agent and person working in ourostack, spoonjoy and arimendelow repositories. Each repository's AGENTS.md points here.

**Every interface a product has, for people or for agents, is built on [Ouro UI](https://ui.ouroboros.bot/).**

- **People's screens use Ouro HX.** On the web, install components from the Ouro UI registry at a release tag (`npx shadcn@latest add ourostack/ouro-ui/<item>#<tag>`) and run Ouro check in CI. On Apple platforms, use `OuroHX` from ourostack/ouro-ui-apple. Don't hand-build a control Ouro HX already has.
- **Agents' doors use Ouro AX.** Declare each action once with ouro-ui-core's `ouro-actions` (one declaration gives the CLI command, MCP and WebMCP tools, App Intent and button), build CLIs and MCP servers on the AX kit, and run the Ouro AX X-ray in CI with its `must` claims passing.
- **Take Ouro from its releases, never by hand.** Install or vendor from a release tag, and record what you took (`.github/ouro-hx-installed.json`, a `Package.swift` version, a lock file) so [Ouro Current](https://ui.ouroboros.bot/current/) can open the update pull request for each new release. A product stays within a day of Ouro UI's releases.
- **Give back.** When Ouro lacks something the product needs, fix it in Ouro with a test that fails without it, release, then adopt the release. Name the product in that pull request.

The [adoption ledger](https://ui.ouroboros.bot/adoption/) measures each product against these from live sources, and the [program issue](https://github.com/ourostack/ouro-ui/issues/1011) tracks the work.
