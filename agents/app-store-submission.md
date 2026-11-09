# App Store submission: sign-in that passes App Review

Shared guidance for every agent and person shipping an Apple app from ourostack, spoonjoy or arimendelow repositories, and for every app that starts from Ouro UI for Apple or the native app shell. Each app repository's AGENTS.md points here.

**When an app offers a third-party login (Google, GitHub, Facebook, Microsoft, X and so on), Sign in with Apple comes first: full width, before those buttons and before any password form, on iPhone, iPad and Mac.**

App Review rejected Spoonjoy for Mac 1.0 on 2026-11-02 under [Guideline 4.8, Login Services](https://developer.apple.com/app-store/review/guidelines/#login-services). The build did offer Sign in with Apple, but last on the screen. The reviewer said the app "does not appear to offer as an equivalent login option" a service that keeps data to name and email, lets people hide their email, and does no ad tracking without consent, and noted that Sign in with Apple meets all three. The fix was [spoonjoy-apple#245](https://github.com/spoonjoy/spoonjoy-apple/pull/245).

## Before you submit

1. **Run the check in CI.** `apple-distribution-kit review login-services --root .` ([the kit manual's CI step](https://github.com/ourostack/apple-distribution-kit/blob/main/docs/manual.md#pre-submission-guideline-48-login-services); the kit isn't on npm yet, so CI builds it from source) exits 1 when a third-party login appears without Sign in with Apple, when Sign in with Apple comes after it in the same view, or when an app's `.entitlements` lacks `com.apple.developer.applesignin`.
2. **Check the signed build, not only the source.** The archive log's entitlements block, or `codesign -d --entitlements - <app>`, must show `com.apple.developer.applesignin`. The App ID needs the Sign in with Apple capability for the profile to carry it.
3. **Account deletion (Guideline 5.1.1(v)).** An app that creates accounts lets people delete the account from inside the app.
4. **Review notes.** Give working demo credentials, and say where Sign in with Apple is.

## If App Review rejects under 4.8 anyway

Fix the order in a new build and resubmit with it. In the same Resolution Center reply, say plainly where Sign in with Apple is and what changed. Replying "we already offer it" without a new build invites a second round.

## A platform's first version takes no What's New

An app's first version on a platform (for example the first Mac version of an app already on iPhone) cannot carry What's New. App Store Connect answers HTTP 409 "Attribute 'whatsNew' cannot be edited at this time" if the listing sends one. The same applies when a rejected first version is renamed and resubmitted. Leave `whatsNew` out of that platform's listing until a version on it has been released. Spoonjoy Mac 1.1 hit this in [stage run 42546769458](https://github.com/spoonjoy/spoonjoy-apple/actions/runs/42546769458), and [spoonjoy-apple#252](https://github.com/spoonjoy/spoonjoy-apple/pull/252) fixed it.
