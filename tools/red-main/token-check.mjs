// Prints what REARM_MERGES_TOKEN can do in each repo auto-revert.json enables, and a ::warning where it cannot revert
// (a revert needs write: contents to push the branch and pull requests to open it). Read-only; run by auto-revert.yml before it acts.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CONFIG = JSON.parse(readFileSync(new URL("./auto-revert.json", import.meta.url), "utf8"));

export async function check(repos, get) {
  const lines = [];
  for (const repo of repos) {
    let perms = null;
    try {
      perms = (await get(`/repos/${repo}`)).permissions ?? null;
    } catch (e) {
      lines.push(`::warning::${repo}: the token cannot read the repository (${e.message}), so auto-revert cannot revert there.`);
      continue;
    }
    const can = { read: !!perms?.pull, write: !!perms?.push };
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const enabled = Object.entries(CONFIG.repos).filter(([, c]) => c.enabled).map(([r]) => r);
  for (const l of await check(enabled, api)) console.log(l);
}
