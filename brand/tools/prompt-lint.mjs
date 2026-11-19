#!/usr/bin/env node
// Prompt lint: checks an image prompt written to the one-shot template in agents/art-prompting.md
// before anything is generated. It is deterministic: it reads the words, not the picture.
//
//   node brand/tools/prompt-lint.mjs <file.prompt.md> [more files]   # errors and warnings as text
//   node brand/tools/prompt-lint.mjs --json <file>                  # one JSON document
//   node brand/tools/prompt-lint.mjs --strict <file>                # warnings fail too
//   node brand/tools/prompt-lint.mjs --rate brand/provenance.json   # one-shot rate from logged candidates
//
// Exit codes: 0 no errors (warnings are listed), 1 at least one error (or warning with --strict), 2 usage.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SECTIONS = ["Story", "Camera", "Composition", "Cast", "Props", "Setting", "Light", "Palette", "Must not", "Output", "References"];
export const FIGURE_FIELDS = ["What", "Material", "Height", "Outfit", "Expression", "Pose", "Limbs", "Hands", "Facing"];

const GUIDE = "agents/art-prompting.md";

// Each risky phrasing names what it produced and where that was seen, so the warning carries its evidence.
const RISKS = [
  {
    id: "pointing",
    test: (s) => /\bpoint(s|ed|ing)?\b/i.test(s.replace(/\b(vanishing|focal|safe|contact|single|one|crop|mid|view)[ -]points?\b|\bpoints? of view\b|\bpoints? to (one|a|the) vanishing\b/gi, "")),
    message: "\"point\" draws an index finger even with \"whole mitten\" (ouro-ui-windows and -android cores, #103; CIT scene-interview). Give the hand a job: rest it on something or hold a prop, and let the arm and head show the direction.",
  },
  {
    id: "open-hand",
    test: (s) => /\bopen(,? relaxed)? (mitten|hand|palm)s?\b|\bholds? out (an? |one |both )?(open )?(mitten|hand|palm)s?\b|\bwav(e|es|ing)\b(?! of)|\bspread (fingers|hands?|mittens?|palms?)\b/i.test(s),
    message: "An open, held-out or waving hand comes back with spread fingers or a second thumb (airship cand-A and cand-C, #105, LinkedIn door). Close the mitten round something: a rail, a prop, a shoulder.",
  },
  {
    id: "fingers",
    test: (s) => /\bfingers?\b/i.test(s) && !/\b(no|never|not|without)\b[^.;]*\bfingers?\b/i.test(s),
    message: "Fingers are never drawn in this universe: mittens with one thumb (art-one-universe.md).",
  },
  {
    id: "dated-device",
    test: (s) => /\b(smart ?phones?|phones?|laptops?|monitors?|tablets?|computers?|televisions?|tvs?|screens?)\b/i.test(s.replace(/\b(face|visor) screens?\b/gi, "")) && !/\b(current|latest|this year's|vintage|antique|rotary|brass|wooden|typewriter|no |never )/i.test(s),
    message: "A device with no generation named comes out a few years old (notched phones in the Android header, #106). Say current-generation (edge-to-edge glass, thin even bezels) or clearly vintage.",
  },
  {
    id: "clone",
    test: (s) => /\b(identical|matching|clones? of|copies of)\s+(\w+\s+){0,2}(robots?|agents?|helpers?)\b|\b(robots?|agents?|helpers?)\s+(that |who )?(are |look )?(identical|alike|clones|copies)\b/i.test(s),
    message: "Agents described as copies come out as clones (art brief round 1; housesitter, #93). Give each agent its own block, colour, outfit, prop and expression.",
  },
  {
    id: "motif",
    test: (s) => /\b(trails? of light|glowing (braided )?trails?|light ?paths?|lines? of light|ribbons? of light|threads? of (warm )?(gold )?light|light streaks?|glowing paths?)\b/i.test(s),
    message: "A light path or trail repeated across pictures reads as a meaningless motif (#113). Keep it only if it does something in this story, and say what.",
  },
  {
    id: "single-rope-climb",
    test: (s) => /\bclimb\w*\b[^.;]*\b(a|the|one) (single )?(rope|shroud|line)\b/i.test(s),
    message: "A figure climbing one rope came back not gripping it, or with a foot off it, in two of three airship candidates (#115). Use a support for every contact: a rope ladder's rungs, a mast step.",
  },
];

const NEGATION = /^\s*(no|never|not|nothing|without|don't|do not)\b/i;

// A figure block for one of the shared universe's people (not an agent, robot or pet).
const isPerson = (what) => /\b(person|people|man|woman|human|captain|ari)\b/i.test(what) && !/\b(robot|agent|snake|pet|stoker)\b/i.test(what);
// Neck length, not just width: "a natural neck about four tenths of the head's width" still drew stalks (ourostack).
const NECK_LENGTH = /\bneck\b[^.;]*\b(short|hidden|tucked|covered|third|quarter)\b|\b(short|hidden|tucked|covered)\b[^.;]*\bneck\b|\bno (visible )?neck\b/i;
const HEAD_SIZE = /\bhead\b[^.;]*\b(third|quarter|fifth|sixth|seventh|eighth|half|\d+(\.\d+)? heads?|times|head-widths?)\b/i;
const WRAP = /\b(blankets?|throws?|shawls?|ponchos?|cloaks?|capes?|quilts?|stoles?)\b/i;
const EDGE = /\b(hem|hems|hemmed|fringe|fringed|tassels?|folded|fold|edge|edges|border|binding|overlap)\b/i;

function sentences(text) {
  return text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function parse(text) {
  const sections = new Map();
  const figures = [];
  // Text before the first "##" (a title, or a whole prompt not yet in the template) is still scanned for risks.
  let section = "Preamble";
  let figure = null;
  sections.set(section, []);
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith("###")) {
      section = h2[1].trim();
      figure = null;
      sections.set(section, sections.get(section) ?? []);
      continue;
    }
    if (h3 && section === "Cast") {
      figure = { name: h3[1].trim(), fields: new Map(), lines: [] };
      figures.push(figure);
      continue;
    }
    sections.get(section).push(line);
    if (figure) {
      figure.lines.push(line);
      const field = /^\s*[-*]\s*\**([A-Za-z ]+?)\**\s*:\s*(.*)$/.exec(line);
      if (field) figure.fields.set(field[1].trim().toLowerCase(), field[2].trim());
    }
  }
  const body = (name) => (sections.get(name) ?? []).join("\n").trim();
  return { sections, figures, body };
}

export function lint(text) {
  const { sections, figures, body } = parse(text);
  const errors = [];
  const warnings = [];
  const err = (where, message) => errors.push({ where, message });
  const warn = (where, message, id) => warnings.push({ where, message, id });

  for (const name of SECTIONS) {
    if (!sections.has(name)) err(name, `missing section "## ${name}" (template order: ${SECTIONS.join(", ")})`);
    else if (!body(name)) err(name, "section is empty; write \"None.\" if nothing belongs here");
  }

  const story = body("Story");
  if (story && sentences(story).length > 1) err("Story", "tell the story in one sentence: one subject, one action, one relationship");

  const camera = body("Camera");
  if (camera) {
    if (!/\b(\d+\s?mm|lens)\b/i.test(camera)) err("Camera", "name the lens (for example 35 mm)");
    if (!/\beye[ -]level\b/i.test(camera)) err("Camera", "name the eye level: where the camera sits relative to the figures");
    if (!/\bone vanishing point\b|\bsingle vanishing point\b/i.test(camera)) err("Camera", "say \"one vanishing point\" and where it is; without it the perspective broke (airship v10)");
  }

  const composition = body("Composition");
  if (composition) {
    if (!/\bsafe\b/i.test(composition)) err("Composition", "mark the headline or overlay safe area that must stay calm");
    if (!/\bcrop\b/i.test(composition)) err("Composition", "name the crop band every important figure must sit inside");
  }

  if (sections.has("Cast") && figures.length === 0) err("Cast", "give one \"### <figure>\" block per figure");
  for (const f of figures) {
    const where = `Cast: ${f.name}`;
    for (const field of FIGURE_FIELDS) {
      const value = f.fields.get(field.toLowerCase());
      if (value === undefined) err(where, `missing "- ${field}:"`);
      else if (!value) err(where, `"${field}" is empty`);
    }
    const limbs = f.fields.get("limbs") ?? "";
    const hands = f.fields.get("hands") ?? "";
    const facing = f.fields.get("facing") ?? "";
    const height = f.fields.get("height") ?? "";
    const material = f.fields.get("material") ?? "";
    const expression = f.fields.get("expression") ?? "";
    if (limbs && !/\b(no|none|zero|one|two|three|four|exactly|\d+)\b/i.test(limbs)) err(where, "Limbs: count them (\"exactly two arms, each from its own shoulder, and two legs\")");
    const hasArms = /\barms?\b/i.test(limbs) && !/\b(no|zero|0)\s+arms\b/i.test(limbs);
    if (hasArms && hands && !/\b(left|right|near|far|front|back|both|each|upper|lower)\b/i.test(hands)) err(where, "Hands: say what each hand does (near and far, or left and right), or \"both\" for one shared job");
    if (facing && !/\b(camera|viewer|us)\b/i.test(facing)) err(where, "Facing: state it against the camera (\"back to the camera\", \"three-quarter view toward the camera\"); \"toward the door\" alone drew the agent walking out (LinkedIn door r4, r6)");
    if (height && !/\b(times|×|\d+(\.\d+)?x|half|third|quarter|level with|height|tall as|knee|waist|shoulder|hip|reference|smallest|tallest)\b/i.test(height)) err(where, "Height: give it relative to another figure or prop (\"about half Loop's height\"); \"bigger\" and \"large\" swung Ouro too big (#88, #102)");
    if (/\bglass\b/i.test(material) && !/\b(smooth|seamless)\b/i.test(material)) warn(where, "\"glass\" alone came out as tiled cells or facets on every airship candidate; say \"smooth, seamless\"", "glass-cells");
    if (expression && /^(happy|smiling|a smile|smile|cute|friendly|neutral|calm)\.?$/i.test(expression)) warn(where, "Expression: a stock word gives the stock smile (#114). Name the feeling of this moment and the face or pose that shows it", "stock-expression");
    const what = f.fields.get("what") ?? "";
    const block = f.lines.join("\n");
    if (isPerson(what)) {
      if (!NECK_LENGTH.test(block)) warn(where, "a person with no neck length came back with a stalk of a neck rising out of the collar (chart-room, playwright-focus-proof, ouro-hx, labs, ouroboros; 2026-11-18). In Build say \"a short, natural neck, about a third of the head's height, the head sitting right on the collar\", or hide it under a scarf or collar", "neck");
      if (!HEAD_SIZE.test(f.fields.get("build") ?? "")) warn(where, "a person with no head size in Build came back with a small head on broad shoulders or an 8-head mannequin body (ouro-md, ouroboros; 2026-11-18). Give the head against the body: \"a head about one-seventh of the standing height, shoulders about two and a half head-widths across\"", "head-size");
    }
    for (const s of sentences(block.replace(/^\s*[-*]\s*/gm, ""))) {
      const kept = s.split(/[,;:(]/).filter((c) => c.trim() && !NEGATION.test(c)).join(",");
      if (WRAP.test(kept) && !EDGE.test(block)) {
        warn(where, "a blanket or throw worn over clothes with no edge named faded into the jumper and coat under it (ourostack meadow, 2026-11-18). Name its edge where it meets the clothes: \"a folded-over hem with a thin shadow line where it sits on the jumper\", or a fringe", "garment-edge");
        break;
      }
    }
  }

  const mustNot = body("Must not");
  if (mustNot && !/^\s*[-*]\s+\S/m.test(mustNot)) err("Must not", "list each banned thing as its own bullet");
  const output = body("Output");
  if (output && !/\b\d{3,5}\s?[x×]\s?\d{3,5}\b/.test(output)) err("Output", "give the generation size in pixels (for example 1536x1024) and the shipped crops");

  const positive = [];
  for (const [name, lines] of sections) {
    // Bans, references and the frame's own size and crops don't draw anything.
    if (["Must not", "References", "Composition", "Output"].includes(name)) continue;
    for (const s of sentences(lines.join("\n").replace(/^\s*[-*]\s*/gm, ""))) {
      // A clause that starts with "no" or "never" is a ban, not a request; only the rest can draw something.
      const kept = s.split(/[,;:(]/).filter((c) => c.trim() && !NEGATION.test(c));
      if (kept.length) positive.push({ name, s: kept.join(","), shown: s });
    }
  }
  const seen = new Set();
  for (const risk of RISKS) {
    for (const { name, s, shown } of positive) {
      if (risk.test(s) && !seen.has(risk.id + name)) {
        seen.add(risk.id + name);
        warn(name, `${risk.message} Found: "${shown.trim().slice(0, 100)}"`, risk.id);
      }
    }
  }
  const all = [...sections.values()].flat().join("\n");
  if (/\b(scarf|scarves|cape|flag|pennant|ribbon|streamer|tassel)\b/i.test(all) && !/\bwind\b/i.test(all)) {
    warn("Setting", "soft things (a scarf, a flag) with no wind named hang wrong: a loose scarf end read as a third limb (airship, #115); name one wind direction in the setting and repeat it on each soft item", "wind");
  }
  return { errors, warnings };
}

// One-shot rate: every whole candidate generated straight from a prompt and blind-hunted, logged in
// provenance.json as a generation step with "step": "candidate" and "hunt": { "blockers": [...] }.
export function oneShotRate(provenance) {
  const candidates = [];
  for (const entry of provenance) {
    for (const g of entry.generation ?? []) {
      if (g.step === "candidate" && g.hunt && Array.isArray(g.hunt.blockers)) {
        candidates.push({ file: entry.file, batch: g.batch, candidate: g.candidate, blockers: g.hunt.blockers.length });
      }
    }
  }
  const unique = new Map(candidates.map((c) => [`${c.batch}/${c.candidate}`, c]));
  const list = [...unique.values()];
  const clean = list.filter((c) => c.blockers === 0).length;
  return { candidates: list.length, clean, rate: list.length ? clean / list.length : null, list };
}

function main(argv) {
  const json = argv.includes("--json");
  const strict = argv.includes("--strict");
  const rateAt = argv.indexOf("--rate");
  if (rateAt >= 0) {
    const path = argv[rateAt + 1];
    if (!path) return usage("--rate needs a provenance.json path");
    const result = oneShotRate(JSON.parse(readFileSync(path, "utf8")));
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (!result.candidates) console.log("one-shot rate: no candidates logged yet (see agents/art-prompting.md#3-the-loop)");
    else console.log(`one-shot rate: ${result.clean}/${result.candidates} whole candidates had zero blockers (${Math.round(result.rate * 100)}%)`);
    return 0;
  }
  const files = argv.filter((a) => !a.startsWith("--"));
  if (!files.length) return usage("name at least one prompt file");
  const report = files.map((file) => ({ file, ...lint(readFileSync(file, "utf8")) }));
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const r of report) {
      for (const e of r.errors) console.log(`${r.file}: error [${e.where}] ${e.message}`);
      for (const w of r.warnings) console.log(`${r.file}: warn  [${w.where}] ${w.message}`);
      console.log(`${r.file}: ${r.errors.length} error(s), ${r.warnings.length} warning(s)${r.errors.length ? "" : " - ready to generate"}`);
    }
    if (report.some((r) => r.errors.length || r.warnings.length)) console.log(`Template and evidence: ${GUIDE}`);
  }
  return report.some((r) => r.errors.length || (strict && r.warnings.length)) ? 1 : 0;
}

function usage(message) {
  console.error(`prompt-lint: ${message}\nusage: node brand/tools/prompt-lint.mjs [--json] [--strict] <file.prompt.md>... | --rate <provenance.json>`);
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
