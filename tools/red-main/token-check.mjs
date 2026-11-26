// Prints what REARM_MERGES_TOKEN can do in each repo auto-revert.json enables, and a ::warning where it cannot revert
// (a revert needs write: contents to push the branch and pull requests to open it). Read-only; run by auto-revert.yml before it acts.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CONFIG = JSON.parse(readFileSync(new URL("./auto-revert.json", import.meta.url), "utf8"));

export async function check(repos, get, probe) {
  const lines = [];
  for (const repo of repos) {
    let perms = null;
    try {
      perms = (await get(`/repos/${repo}`)).permissions ?? null;
    } catch (e) {
      lines.push(`::warning::${repo}: the token cannot read the repository (${e.message}), so auto-revert cannot revert there.`);
      continue;
    }
    // permissions.push only says the account may push; a fine-grained token without Contents write still gets 403, so ask the write door itself.
    let write = !!perms?.push;
    if (write && probe) {
      try {
        write = await probe(repo);
      } catch (e) {
        // This check only reports; a dropped connection here must not stop the revert step that follows it.
        lines.push(`::warning::${repo}: could not tell whether the token may write (${e.cause?.message ?? e.message}); auto-revert still tries.`);
        continue;
      }
    }
    const can = { read: !!perms?.pull, write };
    lines.push(`${repo}: read ${can.read ? "yes" : "no"}, write (contents and pull requests) ${can.write ? "yes" : "no"}`);
    if (!can.write) lines.push(`::warning::${repo}: the token has no write access, so auto-revert cannot push a revert or open its pull request there.`);
  }
  return lines;
}

const api = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

// Creating a ref from an impossible sha is refused with 422 when the token may write and 403/404 when it may not; nothing is created.
const probeWrite = async (repo) => {
  const r = await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json" },
    body: JSON.stringify({ ref: "refs/heads/auto-revert/token-probe", sha: "0".repeat(40) }),
  });
  return r.status !== 403 && r.status !== 404;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const enabled = Object.entries(CONFIG.repos).filter(([, c]) => c.enabled).map(([r]) => r);
  for (const l of await check(enabled, api, probeWrite)) console.log(l);
}
