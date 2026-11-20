# github-browser

For the few GitHub settings that have no API. `browser.mjs` opens a headless Edge on a profile of its own for one account (`~/.local/state/github-browser/profiles/<user>`, or under `GITHUB_BROWSER_HOME`). That profile is seeded from a copy of the person's Edge sign-in files (`EDGE_PROFILE`, including `Device Bound Sessions`, without which Edge drops the device-bound GitHub and Entra cookies), then kept and never written back, so the person's Edge profile and the other accounts' profiles are never touched. It blocks every sign-out request (`/logout`), switches accounts only through GitHub's own switcher (`/switch_account`), never signs in and never types a password. When a profile reads signed out (an expired Enterprise Managed User session), the run retries on a fresh copy of Edge's files and, for an `_<enterprise>` login, finishes Entra single sign-on through `github.com/enterprises/<enterprise>/sso`; the new copy replaces the profile only if it is signed in, otherwise the old one is kept. `GITHUB_BROWSER_RESEED=1` goes straight to a fresh copy, with the same rule. One run per profile at a time.

Switching accounts is server-side state shared by every browser holding the session's cookies: while another account is active, a private Pages site answers 401 to the person's own account. So `close()` also switches back to the account that was active when the run started.

- `copilot-workflow-approval.mjs`: turns off "Require approval for workflow runs" and "Require approval for workflows on automation pull requests" (Settings > Copilot > Cloud agent) on every unarchived repository of `ORG` (default ourostack), or the ones named. `--check` only reports. Our agents push from cloud sessions, and with these on, every push waited for a person to approve its CI.
- `../../brand/tools/upload-social-previews.mjs` uses it for social previews.

Needs Edge, `playwright` (`npm i -g playwright`) and `gh` signed in for the repository list. Edge gets 60 s to open its debugging port, polled every 100 ms, so a ready machine starts in about a second; set `EDGE_START_SECONDS` to change it.

`sudo.mjs`: `awaitSudo(session, {what, redo, resume})` after any step that may show GitHub's "Confirm access". Outside the morning sitting it never prompts: it queues the step with `shepherd signin queue` (one batch message each morning, `resume` is the command to rerun, the process's own command line by default) and throws `signinQueued` (exit 5). With `SIGNIN_LIVE=1`, the sitting itself, it taps "Use GitHub Mobile" when offered (a push to the phone, no window), else reopens Edge in a visible, frontmost window (`session.relaunchHeadful()`) and repeats the step there for a passkey. Either way it prints one line and sends it to Ari's Teams chat with Ouroboros through `workiq create`, with the number GitHub Mobile shows, then waits up to 15 minutes (`sudoTimeout` error, exit 4). Granted sudo lasts a few hours for the browser session, so batch the sudo steps in one session.

## Another account in a signed-in profile

`openAs("arimendelow_microsoft", { via: "arimendelow" })` opens the `arimendelow` profile (whose switcher lists the work account) and switches to the work account, so `s.page` is signed in as `arimendelow_microsoft`; `close()` switches back. A plain `openAs("arimendelow_microsoft")` looks in its own, never-signed-in profile and exits 3. Seeding decrypts the copied `Cookies` into plaintext (macOS keychain key), because an Edge that self-updated past the running one cannot read the old `v10` cookies and drops them (the 2026-11-19 signed-out seed). Reseed with `GITHUB_BROWSER_RESEED=1`.

## Web-only actions as the personal account `arimendelow`

Never ask Ari to sign in. Use `openAs("arimendelow")` from `browser.mjs` (it is the default user): its own profile under `~/.local/state/github-browser/profiles/arimendelow` is already signed in as `arimendelow` (checked 2026-11-19: `loginOf` returns `arimendelow`, and the switcher also lists `arimendelow_microsoft`). Desk's `browser_context` `mine` copies the same profile with the same cookie decryption and is signed in too; Edge has no other profile on this Mac.

```js
import { openAs } from "<clone of ourostack/.github>/tools/github-browser/browser.mjs";
const s = await openAs("arimendelow"); // s.page is a Playwright page signed in as arimendelow
try { /* … */ } finally { await s.close(); }
```

No API covers these: GitHub has no REST or GraphQL call for a repository's social preview image or for deleting a comment's edit-history revisions (GraphQL only has `minimizeComment` and `deleteIssueComment`, which change the comment, not its history). Social previews: `brand/tools/upload-social-previews.mjs`. Edit history: open the comment's "edited" menu and choose "Delete revision" (confirmed reachable on ourostack/ouro-ui#2111 as `arimendelow`). If `openAs` exits 3 (not signed in), the only human step is Ari's passkey at github.com/login as `arimendelow`, relayed by the coordinator.
