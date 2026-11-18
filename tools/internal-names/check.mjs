#!/usr/bin/env node
// Fails when text bound for a public ourostack repository names an internal app, repository or organization.
// The words are kept as SHA-256 hashes in hashes.txt, so this public list names none of them; each word of the text is
// hashed and compared. Words are split on anything but letters, digits and hyphens, and a hyphenated word is checked
// whole and by each run of its parts ("org-name/repo#12" checks "org-name", "org", "name" and "repo").
//
//   node check.mjs --text < body.txt     a pull request's title and body, or any text on stdin
//   node check.mjs <base>..<head>        the messages of the commits in that range, in the current repository
//   node check.mjs --hash <word>         the line to add to hashes.txt for a new word
//
// It never prints the word it found, only where it is, so the log repeats nothing. INTERNAL_NAMES_FILE overrides the list.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const hash = (word) => createHash("sha256").update(word).digest("hex");

/** The hashes on the list: one 64-character hex hash a line; `#` starts a comment. */
export function readList(file) {
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => /^[0-9a-f]{64}$/.test(line)),
  );
}

/** Every candidate a word yields: itself and each run of its hyphen-joined parts, lowercase. */
export function candidates(word) {
  const parts = word.split("-").filter(Boolean);
  const out = new Set();
  for (let from = 0; from < parts.length; from++) for (let to = from + 1; to <= parts.length; to++) out.add(parts.slice(from, to).join("-"));
  return out;
}

/** The 1-based line numbers of `text` that hold a listed word. */
export function findLines(text, list) {
  const lines = [];
  text.split("\n").forEach((line, index) => {
    const words = line.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
    if (words.some((word) => [...candidates(word)].some((candidate) => list.has(hash(candidate))))) lines.push(index + 1);
  });
  return lines;
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const list = readList(process.env.INTERNAL_NAMES_FILE || join(here, "hashes.txt"));
  const [mode, value] = argv;
  if (mode === "--hash" && value) {
    console.log(hash(value.toLowerCase()));
    return 0;
  }
  if (mode === "--text") {
    const lines = findLines(readFileSync(0, "utf8"), list);
    if (!lines.length) return 0;
    console.error(`::error::The text names an internal app, repository or organization on line ${lines.join(", ")}. In a public repository write "an app" or "a consuming app", with no internal repository names, issue numbers or URLs.`);
    return 1;
  }
  if (mode && mode.includes("..")) {
    const log = execFileSync("git", ["log", "--format=%H%x00%B%x01", mode], { encoding: "utf8" });
    const hits = log
      .split("\x01")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [sha, message] = entry.split("\x00");
        return { sha, lines: findLines(message ?? "", list) };
      })
      .filter(({ lines }) => lines.length);
    if (!hits.length) return 0;
    for (const { sha, lines } of hits) console.error(`::error::Commit ${sha.slice(0, 12)}'s message names an internal app, repository or organization on line ${lines.join(", ")}. Reword it ("an app", "a consuming app") and push again.`);
    return 1;
  }
  console.error("usage: check.mjs --text < text | check.mjs <base>..<head> | check.mjs --hash <word>");
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
