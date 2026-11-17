# github-browser

For the few GitHub settings that have no API. `browser.mjs` opens a headless Edge on a scratch copy of the local profile's sign-in files and switches it to one account through GitHub's own account switcher (`/switch_account`). It never signs in, never types a password, never touches the person's own browser, and moves the scratch copy to the Trash when it closes. Switching accounts is server-side state shared by every copy of the profile: while another account is active, a private Pages site answers 401 to the person's own account everywhere. So `close()` switches back to the account that was active when the copy opened.

- `copilot-workflow-approval.mjs`: turns off "Require approval for workflow runs" and "Require approval for workflows on automation pull requests" (Settings > Copilot > Cloud agent) on every unarchived repository of `ORG` (default ourostack), or the ones named. `--check` only reports. Our agents push from cloud sessions, and with these on, every push waited for a person to approve its CI.
- `../../brand/tools/upload-social-previews.mjs` uses it for social previews.

Needs Edge, `playwright` (`npm i -g playwright`) and `gh` signed in for the repository list. Edge gets 60 s to open its debugging port, polled every 100 ms, so a ready machine starts in about a second; set `EDGE_START_SECONDS` to change it.

`sudo.mjs`: `awaitSudo(session, {what, redo})` after any step that may show GitHub's "Confirm access". It taps "Use GitHub Mobile" when offered (a push to the phone, no window), else reopens Edge in a visible, frontmost window (`session.relaunchHeadful()`) and repeats the step there for a passkey. Either way it prints one line and sends it to Ari's Teams chat with Ouroboros through `workiq create`, with the number GitHub Mobile shows, then waits up to 15 minutes (`sudoTimeout` error, exit 4). Granted sudo lasts a few hours for the browser session, so batch the sudo steps in one session.
