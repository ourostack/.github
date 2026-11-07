#!/usr/bin/env node
// Brand audit: checks every surface in brand/surfaces.json against the bytes in brand/provenance.json.
//
//   node brand/tools/audit.mjs                 # text on a terminal, JSON otherwise
//   node brand/tools/audit.mjs --format text   # force text (CI uses this)
//   node brand/tools/audit.mjs --only site:    # only surfaces whose id starts with "site:"
//   node brand/tools/audit.mjs --only site:ouroboros.bot --origin http://localhost:4321
//                                              # audit one website's build served elsewhere (a PR's CI build
//                                              # or preview): its origin, sitemap and absolute same-site URLs
//                                              # are read from --origin instead of the registered origin
//
// Exit codes: 0 every surface is current (held and waiting surfaces are listed, not failed),
// 1 at least one surface is stale or unregistered, 2 usage, 3 environment not ready (no GitHub token, network).
// BRAND_REF=<commit> checks that commit's canonical bytes instead of main's (CI sets it on pull requests).
// Needs Node 20+ and a GitHub token in GH_TOKEN or GITHUB_TOKEN (or a signed-in `gh`) for READMEs and social previews.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BRAND = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const format = opt("--format") ?? (process.stdout.isTTY ? "text" : "json");
const only = opt("--only") ?? "";
const originOverride = opt("--origin");
if (originOverride !== undefined) {
  if (!/^https?:\/\/[^/]+$/.test(originOverride)) usage(`--origin must be a bare origin like http://localhost:4321, not ${originOverride}`);
  if (!only.startsWith("site:") || only === "site:") usage("--origin needs --only <one website id>, for example --only site:ouroboros.bot");
}
if (!["text", "json"].includes(format)) usage(`--format must be text or json, not ${format}`);
if (args.includes("--help") || args.includes("-h")) usage();

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("usage: node brand/tools/audit.mjs [--format text|json] [--only <id prefix>] [--origin <url> with --only <website id>]\n");
  process.exit(message ? 2 : 0);
}

const registry = JSON.parse(readFileSync(join(BRAND, "surfaces.json"), "utf8"));
const provenance = new Map(JSON.parse(readFileSync(join(BRAND, "provenance.json"), "utf8")).map((e) => [e.file, e]));
if (originOverride !== undefined && !registry.surfaces.some((x) => x.id === only && x.kind === "website")) usage(`--origin needs --only to name one registered website exactly; ${only} is not one`);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
const GH = token();

// ---------- fetching, with a small cache and bounded concurrency ----------
const cache = new Map();
let active = 0;
const queue = [];
async function slot(fn) {
  if (active >= 8) await new Promise((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}
function get(url, headers = {}) {
  const key = url + JSON.stringify(headers);
  if (!cache.has(key)) {
    cache.set(
      key,
      slot(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await fetch(url, { headers: { "user-agent": "ourostack-brand-audit", ...headers }, redirect: "follow" });
            const body = Buffer.from(await res.arrayBuffer());
            return { status: res.status, url: res.url, type: res.headers.get("content-type") ?? "", body };
          } catch (err) {
            if (attempt >= 2) return { status: 0, url, type: "", body: Buffer.alloc(0), error: String(err.cause?.code ?? err.message) };
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }
      }),
    );
  }
  return cache.get(key);
}
const ghHeaders = () => (GH ? { authorization: `Bearer ${GH}`, accept: "application/vnd.github+json" } : { accept: "application/vnd.github+json" });
async function ghJson(path) {
  const res = await get(`https://api.github.com${path}`, ghHeaders());
  if (res.status !== 200) throw new EnvError(`GitHub API ${path} answered ${res.status || res.error}`);
  return JSON.parse(res.body.toString("utf8"));
}
async function ghGraphql(query) {
  const res = await slot(() =>
    fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { ...ghHeaders(), "content-type": "application/json", "user-agent": "ourostack-brand-audit" },
      body: JSON.stringify({ query }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) })),
  );
  if (res.status !== 200 || res.json.errors) throw new EnvError(`GitHub GraphQL answered ${res.status}: ${JSON.stringify(res.json.errors ?? res.json).slice(0, 200)}`);
  return res.json.data;
}
class EnvError extends Error {}

// ---------- asset helpers ----------
function asset(path) {
  const entry = provenance.get(path);
  if (!entry) throw new Error(`brand/surfaces.json names ${path}, which brand/provenance.json does not list`);
  return entry;
}
const raw = (path) => registry.canonicalRaw + path;
function imageSize(buf) {
  if (buf.subarray(1, 4).toString() === "PNG") return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i < buf.length - 9; ) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(12, 16).toString() === "VP8X")
    return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  return null;
}
async function sameBytes(url, path) {
  const res = await get(url);
  if (res.status !== 200) return `${url} answered ${res.status || res.error}`;
  const want = asset(path).sha256;
  const have = sha(res.body);
  return have === want ? null : `${url} is not brand/${path} (sha256 ${have.slice(0, 12)}, want ${want.slice(0, 12)})`;
}

// ---------- checks, one per kind; each returns a list of problems ----------
const checks = {
  async "github-readme"(s) {
    let text;
    if (s.path) {
      const data = await ghJson(`/repos/${s.repo}/contents/${s.path}`);
      text = Buffer.from(data.content, "base64").toString("utf8");
    } else {
      const data = await ghJson(`/repos/${s.repo}/readme`);
      text = Buffer.from(data.content, "base64").toString("utf8");
    }
    const head = text.split("\n").slice(0, 25).join("\n");
    const url = raw(s.header);
    const problems = [];
    if (!head.includes(url)) {
      const found = head.match(/https:\/\/raw\.githubusercontent\.com\/ourostack\/\.github\/main\/brand\/[^"' )]+/);
      problems.push(found ? `README header is ${found[0].replace(registry.canonicalRaw, "brand/")}, want brand/${s.header}` : `README has no brand/${s.header} header in its first 25 lines`);
    }
    return { problems, fix: `Open a README-only PR in ${s.repo} whose first lines are the header block in brand/AGENTS.md with brand/${s.header}; merge it when green.` };
  },
  async "github-social-preview"(s) {
    const [owner, name] = s.repo.split("/");
    const data = await ghGraphql(`{repository(owner:"${owner}",name:"${name}"){usesCustomOpenGraphImage openGraphImageUrl}}`);
    const r = data.repository;
    const problems = [];
    if (!r.usesCustomOpenGraphImage) problems.push("no custom social preview");
    else {
      const p = await sameBytes(r.openGraphImageUrl, s.image);
      if (p) problems.push(`social preview ${p.replace(r.openGraphImageUrl, "image")}`);
    }
    return {
      problems,
      fix: `Upload brand/${s.image} at https://github.com/${s.repo}/settings (General > Social preview > Edit > Upload an image). GitHub has no API for this; a signed-in browser does it.`,
    };
  },
  async "npm-readme"(s) {
    const res = await get(`https://registry.npmjs.org/${s.package.replace("/", "%2f")}`);
    if (res.status !== 200) throw new EnvError(`npm registry answered ${res.status || res.error} for ${s.package}`);
    const readme = JSON.parse(res.body.toString("utf8")).readme ?? "";
    const ok = readme.split("\n").slice(0, 25).join("\n").includes(raw(s.header));
    return { problems: ok ? [] : [`npm README lacks brand/${s.header}`], waiting: ok ? undefined : s.updatesWith, fix: `Ships with ${s.updatesWith}.` };
  },
  async note(s) {
    const problems = [];
    for (const url of s.check ?? []) {
      const res = await get(url);
      if (res.status !== 200) problems.push(`${url} answered ${res.status || res.error}`);
    }
    return { problems, fix: "Restore the file; a brand update must never break what a surface serves." };
  },
  async website(s) {
    const problems = [];
    // --origin: read this site from another host (a PR build), mapping the registered origin onto it.
    const registered = s.origin;
    const rehost = (u) => (originOverride && u.startsWith(registered) ? originOverride + u.slice(registered.length) : u);
    if (originOverride) s = { ...s, origin: originOverride, sitemap: s.sitemap && rehost(s.sitemap), base: s.base.startsWith("http") ? rehost(s.base) : s.base };
    const pages = new Set(Object.keys(s.pages ?? {}));
    if (s.sitemap) {
      const locs = await sitemapLocs(s.sitemap, problems);
      for (const loc of locs) pages.add(new URL(loc).pathname);
    }
    const base = s.base.startsWith("http") ? s.base : s.origin + s.base;
    const checked = new Map();
    const check = (url, path) => {
      if (!checked.has(url)) checked.set(url, sameBytes(url, path));
      return checked.get(url);
    };
    await Promise.all(
      [...pages].sort().map(async (path) => {
        const res = await get(s.origin + path);
        const where = path;
        if (res.status !== 200) return problems.push(`${where}: answered ${res.status || res.error}`);
        if (new URL(res.url).origin !== new URL(s.origin).origin) return problems.push(`${where}: redirects off-site to ${res.url}`);
        const html = res.body.toString("utf8");
        const abs = (href) => rehost(new URL(href.replace(/&amp;/g, "&"), res.url).href);
        const tags = [...html.matchAll(/<(link|meta)\b[^>]*>/gi)].map((m) => m[0]);
        const attr = (tag, a) => tag.match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];
        const links = tags.filter((t) => /^<link/i.test(t));
        const metas = tags.filter((t) => /^<meta/i.test(t));
        const rel = (r) => links.filter((t) => (attr(t, "rel") ?? "").toLowerCase().split(/\s+/).includes(r)).map((t) => attr(t, "href"));
        const meta = (k) => metas.find((t) => attr(t, "property") === k || attr(t, "name") === k);

        if (s.icon) {
          const icons = rel("icon");
          const svg = links.find((t) => /\bicon\b/i.test(attr(t, "rel") ?? "") && /svg/.test(attr(t, "type") ?? attr(t, "href") ?? ""));
          const href = svg ? attr(svg, "href") : icons[0];
          if (!href) problems.push(`${where}: no rel=icon`);
          else {
            const p = await check(abs(href), s.icon);
            if (p) problems.push(`${where}: icon ${p}`);
          }
        }
        if (s.appleTouchIcon) {
          const href = rel("apple-touch-icon")[0];
          if (!href) problems.push(`${where}: no apple-touch-icon`);
          else {
            const p = await check(abs(href), s.appleTouchIcon);
            if (p) problems.push(`${where}: apple-touch-icon ${p}`);
          }
        }
        const og = meta("og:image") && attr(meta("og:image"), "content");
        const tw = meta("twitter:image") && attr(meta("twitter:image"), "content");
        const ogMode = s.pages?.[path]?.og ?? s.og;
        if (!og) problems.push(`${where}: no og:image`);
        else {
          if (tw && abs(tw) !== abs(og)) problems.push(`${where}: twitter:image differs from og:image`);
          if (!tw) problems.push(`${where}: no twitter:image`);
          if (ogMode === "composed") {
            const img = await get(abs(og));
            const size = img.status === 200 ? imageSize(img.body) : null;
            if (img.status !== 200) problems.push(`${where}: og:image answered ${img.status || img.error}`);
            else if (!size || size[0] !== 1200 || size[1] !== 630) problems.push(`${where}: og:image is ${size ? size.join("x") : "not an image"}, want 1200x630`);
            else if (s.legacyOg && s.legacyOg.includes(sha(img.body))) problems.push(`${where}: og:image is a pre-storybook card`);
          } else if (ogMode) {
            const p = await check(abs(og), ogMode);
            if (p) problems.push(`${where}: og:image ${p}`);
          }
        }
        const scene = s.pages?.[path]?.hero;
        if (scene) {
          if (!html.includes(`data-brand-scene="${scene}"`)) problems.push(`${where}: no hero marked data-brand-scene="${scene}"`);
          for (const want of [`scenes/${scene}-1536.avif`, `phone/${scene}-768.avif`]) {
            if (!html.includes(base + want) && !html.includes(new URL(base + want).pathname)) problems.push(`${where}: hero does not use brand/${want}`);
          }
        }
        // Every storybook file the page references must be the canonical bytes.
        const basePath = new URL(base).pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const refs = new Set([...html.matchAll(new RegExp(`(?:https?://[^"'\\s,)]+)?${basePath}[^"'\\s,)?#]+`, "g"))].map((m) => m[0]));
        for (const ref of refs) {
          const url = abs(ref);
          if (new URL(url).pathname.startsWith(new URL(base).pathname) && new URL(url).origin === new URL(base).origin) {
            const rel = new URL(url).pathname.slice(new URL(base).pathname.length);
            if (!provenance.has(rel)) problems.push(`${where}: references ${url}, which is not a brand file`);
            else {
              const p = await check(url, rel);
              if (p) problems.push(`${where}: ${p}`);
            }
          }
        }
      }),
    );
    return {
      problems: [...new Set(problems)].sort(),
      pages: pages.size,
      fix: `In ${s.repo}, copy each named brand/ file byte-for-byte to ${base}<same path>, reference it as brand/AGENTS.md describes, and deploy.`,
    };
  },
};

async function sitemapLocs(url, problems, depth = 0) {
  const res = await get(url);
  if (res.status !== 200) {
    problems.push(`sitemap ${url} answered ${res.status || res.error}`);
    return [];
  }
  const xml = res.body.toString("utf8");
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  const here = new URL(url).origin;
  const child = (l) => (originOverride ? here + new URL(l).pathname : l);
  if (/<sitemapindex/.test(xml) && depth < 2) return (await Promise.all(locs.map((l) => sitemapLocs(child(l), problems, depth + 1)))).flat();
  return locs;
}

// ---------- organization coverage: every repository is registered or excluded ----------
async function coverage() {
  const repos = [];
  for (let page = 1; page < 10; page++) {
    const batch = await ghJson(`/orgs/${registry.org}/repos?per_page=100&page=${page}`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  const readmes = new Set(registry.surfaces.filter((s) => s.kind === "github-readme" && !s.path).map((s) => s.repo.split("/")[1]));
  const socials = new Set(registry.surfaces.filter((s) => s.kind === "github-social-preview").map((s) => s.repo.split("/")[1]));
  const out = [];
  for (const r of repos) {
    if (r.name in (registry.excluded ?? {}) || r.archived) continue;
    const missing = [!readmes.has(r.name) && "README", !socials.has(r.name) && "social preview"].filter(Boolean);
    if (missing.length)
      out.push({
        id: `unregistered:${r.name}`,
        status: "unregistered",
        problems: [`ourostack/${r.name} has no ${missing.join(" or ")} entry in brand/surfaces.json`],
        fix: "Add it to brand/surfaces.json (draw its header with the prompt chain in brand/provenance.json), or list it under excluded with the reason.",
      });
  }
  return out;
}

// ---------- canonical bytes: main serves what provenance records ----------
async function canonical() {
  const used = new Set();
  for (const s of registry.surfaces) for (const k of ["header", "image"]) if (s[k]) used.add(s[k]);
  const problems = [];
  await Promise.all(
    [...used].map(async (p) => {
      const local = sha(readFileSync(join(BRAND, p)));
      if (local !== asset(p).sha256) problems.push(`brand/${p} on disk does not match provenance.json`);
      // BRAND_REF lets a pull request check its own commit instead of main.
      const ref = process.env.BRAND_REF;
      const live = await sameBytes(ref ? raw(p).replace("/main/brand/", `/${ref}/brand/`) : raw(p), p);
      if (live) problems.push(live);
    }),
  );
  return { id: "canonical:brand", kind: "canonical", status: problems.length ? "stale" : "current", problems, fix: "Commit the file and its provenance entry together, then let main serve them (python3 brand/tools/derive.py --check)." };
}

// ---------- run ----------
const results = [];
let envError = null;
async function run(s) {
  if (!s.id.startsWith(only)) return;
  if (originOverride && s.id !== only) return;
  try {
    const r = await checks[s.kind](s);
    let status = r.problems.length ? "stale" : "current";
    if (status === "stale" && s.held) status = "held";
    if (status === "stale" && r.waiting) status = "waiting";
    results.push({ id: s.id, kind: s.kind, status, problems: r.problems, ...(r.pages ? { pages: r.pages } : {}), ...(status === "held" ? { reason: s.held } : {}), ...(status === "current" ? {} : { fix: r.fix }) });
  } catch (err) {
    if (!(err instanceof EnvError)) throw err;
    envError ??= err.message;
    results.push({ id: s.id, kind: s.kind, status: "unchecked", problems: [err.message], fix: GH ? "Retry; check network access to the named host." : "Set GH_TOKEN (or sign in with `gh auth login`) and rerun." });
  }
}
await Promise.all(registry.surfaces.map(run));
if ("canonical:brand".startsWith(only) || only === "") results.push(await canonical().catch((e) => ({ id: "canonical:brand", kind: "canonical", status: "unchecked", problems: [e.message] })));
if (only === "" || "unregistered:".startsWith(only)) results.push(...(await coverage().catch((e) => [{ id: "unregistered:?", status: "unchecked", problems: [e.message], fix: "Set GH_TOKEN and rerun." }])));
results.sort((a, b) => a.id.localeCompare(b.id));

const count = (st) => results.filter((r) => r.status === st).length;
const summary = { current: count("current"), stale: count("stale"), unregistered: count("unregistered"), held: count("held"), waiting: count("waiting"), unchecked: count("unchecked") };
const failed = summary.stale + summary.unregistered > 0;
const exit = failed ? 1 : summary.unchecked ? 3 : 0;

if (format === "json") {
  process.stdout.write(JSON.stringify({ ok: exit === 0, summary, items: results, count: results.length }, null, 2) + "\n");
} else {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const c = (code, t) => (color ? `\x1b[${code}m${t}\x1b[0m` : t);
  const mark = { current: c(32, "●"), stale: c(31, "✖"), unregistered: c(31, "✖"), held: c(33, "▲"), waiting: c(33, "▲"), unchecked: c(31, "?") };
  process.stdout.write(`BRAND AUDIT  ${registry.surfaces.length} surfaces in brand/surfaces.json\n\n`);
  for (const r of results) {
    const extra = r.pages ? c(2, ` (${r.pages} pages)`) : "";
    process.stdout.write(`${mark[r.status]} ${r.status.padEnd(12)} ${r.id}${extra}\n`);
    if (r.status !== "current") {
      for (const p of r.problems.slice(0, 12)) process.stdout.write(`    ${p}\n`);
      if (r.problems.length > 12) process.stdout.write(`    … ${r.problems.length - 12} more (--format json lists all)\n`);
      if (r.reason) process.stdout.write(c(2, `    held: ${r.reason}\n`));
      if (r.fix) process.stdout.write(c(2, `    fix: ${r.fix}\n`));
    }
  }
  process.stdout.write(`\n${Object.entries(summary).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ")}\n`);
  process.stdout.write(exit === 0 ? c(32, "Every surface carries the brand.\n") : exit === 1 ? c(31, "Stale surfaces above. A branding update is done only when this is green.\n") : c(31, `Some surfaces could not be checked: ${envError}\n`));
}
process.exit(exit);
