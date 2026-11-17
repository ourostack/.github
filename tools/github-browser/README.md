# github-browser

For the few GitHub settings that have no API. `browser.mjs` opens a headless Edge on a profile of its own for one account (`~/.local/state/github-browser/profiles/<user>`, or under `GITHUB_BROWSER_HOME`). That profile is seeded once from a copy of the person's Edge sign-in files (`EDGE_PROFILE`), then kept and never written back, so the person's Edge profile and the other accounts' profiles are never touched. It blocks every sign-out request (`/logout`), switches accounts only through GitHub's own switcher (`/switch_account`), never signs in and never types a password. `GITHUB_BROWSER_RESEED=1` replaces a profile with a fresh copy, after the person adds an account in their own Edge. One run per profile at a time.

Switching accounts is server-side state shared by every browser holding the session's cookies: while another account is active, a private Pages site answers 401 to the person's own account. So `close()` also switches back to the account that was active when the run started.

- `copilot-workflow-approval.mjs`: turns off "Require approval for workflow runs" and "Require approval for workflows on automation pull requests" (Settings > Copilot > Cloud agent) on every unarchived repository of `ORG` (default ourostack), or the ones named. `--check` only reports. Our agents push from cloud sessions, and with these on, every push waited for a person to approve its CI.
- `../../brand/tools/upload-social-previews.mjs` uses it for social previews.

Needs Edge, `playwright` (`npm i -g playwright`) and `gh` signed in for the repository list. Edge gets 60 s to open its debugging port, polled every 100 ms, so a ready machine starts in about a second; set `EDGE_START_SECONDS` to change it.

`sudo.mjs`: `awaitSudo(session, {what, redo})` after any step that may show GitHub's "Confirm access". It taps "Use GitHub Mobile" when offered (a push to the phone, no window), else reopens Edge in a visible, frontmost window (`session.relaunchHeadful()`) and repeats the step there for a passkey. Either way it prints one line and sends it to Ari's Teams chat with Ouroboros through `workiq create`, with the number GitHub Mobile shows, then waits up to 15 minutes (`sudoTimeout` error, exit 4). Granted sudo lasts a few hours for the browser session, so batch the sudo steps in one session.
