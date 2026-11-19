# Security policy

This policy covers every ourostack repository that has no `SECURITY.md` of its own, Ouro UI's (ouro-ui, ouro-ui-core, ouro-ui-apple, ouro-ui-windows and ouro-ui-android) among them. Its terms come from [ouro-ui-core's decision record](https://github.com/ourostack/ouro-ui-core/blob/main/docs/decisions/2026-11-19-release-sets-support-company-registry.md).

## Reporting a vulnerability

Don't put details of a vulnerability in a public issue, pull request or discussion.

- Where a repository's **Security** tab shows **Report a vulnerability**, use it. The report stays private between you and the maintainers.
- Where it doesn't yet, open an issue titled "Security: please open a private channel", with no details, and a maintainer will start a private security advisory with you there.

## What happens next

- We acknowledge a report within three working days.
- We fix it in the newest release of each affected package and publish a security advisory with the fix.
- Before ouro-ui-core 1.0 we don't backport fixes to older releases. From 1.0, the previous core minor release gets security fixes for 90 days after the next one ships.

## Supported versions

| Package | Gets security fixes |
| --- | --- |
| Each repository's newest release | Yes |
| Older releases, before core 1.0 | No: update to the newest release |
