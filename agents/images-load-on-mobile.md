# Images must load on the recipient's phone

Shared guidance for every agent working in ourostack repositories. Each repository's AGENTS.md points here. Ari: "always do images in a way that will load on mobile."

**An image in a PR, issue, comment or message counts only if the person reading it, on the device they read it on, sees it.** The procedure (how to attach, how to check, what the check can and cannot prove) lives in one place: the `visual-proof` skill's "Proof must render where the recipient reads it" section in [ourostack/desk](https://github.com/ourostack/desk/pull/1665) (the PR is open; use the skill once merged). Don't copy the procedure here or into another repository.

The rules that bind every ourostack repository:

- **Never use a `blob/` or `raw.githubusercontent.com` link as proof an image loads.** For a private repository it needs a sign-in the recipient's client may not carry, and a token in the URL expires and leaks.
- **Use the platform's own attachment** (GitHub's upload into the PR or issue, Teams' own file or image attachment) so access follows the thread's own permissions. Never move private code or images to a public repository, CDN or paste site, and never bypass sign-in or widen access to make a link load.
- **Read the upload back.** After posting, fetch the post and confirm the attachment is present and served. That proves the endpoint and the web view only.
- **Mobile is unverified until someone has seen it there.** Native GitHub Mobile and Teams rendering is not yet verified. Say "web rendering confirmed, native mobile not confirmed" rather than "loads on mobile".
- **Public site and README art** (`brand/`) is a separate case: it ships as files on the site and passes the brand audit, with phone crops (see [AGENTS.md](../AGENTS.md)).
