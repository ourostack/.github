import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lint, oneShotRate } from "./prompt-lint.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const figure = (fields) => Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`).join("\n");
const prompt = (cast, extra = "") => `# Test scene

## Story
A small agent hands its person a parcel.

## Camera
35 mm lens. Eye level: at the person's chest. One vanishing point, at the centre of the door.

## Composition
Safe area: the left third stays calm. Crop band: rows 256 to 768.

## Cast

${cast}

## Props
- Parcel: a small box, held level in the agent's mittens.

## Setting
A doorstep at dusk. ${extra}

## Light
Warm lamp light from the door.

## Palette
Navy, amber and teal.

## Must not
- No text, letters, numbers, logos or symbols.

## Output
Three candidates at 1536x1024.

## References
1. The cast reference sheet.
`;

const person = {
  What: "the person",
  Material: "smooth, seamless frosted glass",
  Height: "about 1.4 times the agent's height",
  Outfit: "an amber cardigan",
  Expression: "pleased surprise, head tilted back",
  Pose: "standing in the doorway",
  Limbs: "exactly two arms and two legs",
  Hands: "near mitten takes the parcel; far mitten rests on the door frame",
  Facing: "three-quarters toward the camera",
};

test("the two filled examples are ready to generate, with no warnings", () => {
  for (const path of ["agents/art-prompting/airship.prompt.md", "agents/art-prompting/linkedin-door.prompt.md"]) {
    const { errors, warnings } = lint(read(path));
    assert.deepEqual(errors, [], path);
    assert.deepEqual(warnings, [], path);
  }
});

test("a figure missing its hands and facing is an error, and facing must be against the camera", () => {
  const { Hands, Facing, ...rest } = person;
  const missing = lint(prompt(`### The person\n${figure(rest)}`)).errors.map((e) => e.message);
  assert.ok(missing.includes('missing "- Hands:"'));
  assert.ok(missing.includes('missing "- Facing:"'));

  const sceneFacing = lint(prompt(`### The person\n${figure({ ...person, Facing: "toward the door" })}`)).errors;
  assert.ok(sceneFacing.some((e) => e.message.startsWith("Facing: state it against the camera")));
});

test("uncounted limbs, unsplit hands and an absolute height are errors", () => {
  const { errors } = lint(prompt(`### The person\n${figure({ ...person, Limbs: "arms and legs", Height: "large" })}`));
  assert.deepEqual(errors.map((e) => e.message.split(":")[0]).sort(), ["Height", "Limbs"]);
  const mittensOnly = lint(prompt(`### The person\n${figure({ ...person, Hands: "mittens" })}`)).errors;
  assert.ok(mittensOnly.some((e) => e.message.startsWith("Hands: say what each hand does")));
});

test("the phrasings that drew fingers and dated devices warn, but bans in Must not don't", () => {
  const risky = lint(prompt(`### The person\n${figure({ ...person, Pose: "points at the parcel with an open mitten beside a laptop" })}`));
  const ids = new Set(risky.warnings.map((w) => w.id));
  for (const id of ["pointing", "open-hand", "dated-device"]) assert.ok(ids.has(id), id);

  const banned = lint(prompt(`### The person\n${figure(person)}`).replace("- No text", "- No pointing, no open mitten, no fingers, no laptop.\n- No text"));
  assert.deepEqual(banned.warnings, []);
  assert.equal(lint(prompt(`### The person\n${figure(person)}`)).warnings.length, 0);
});

test("the unstructured airship prompt that needed fixes fails and names its risky phrasings", () => {
  const old = `THE PERSON at the bow: exactly TWO arms; the far arm reaches out toward the horizon with an open, relaxed mitten (never a pointing finger). THE RIGGER, high on the left climbing a rope shroud toward the envelope.`;
  const { errors, warnings } = lint(old);
  assert.equal(errors.filter((e) => e.message.startsWith("missing section")).length, 11);
  assert.deepEqual(warnings.map((w) => w.id).sort(), ["open-hand", "single-rope-climb"]);
});

test("one-shot rate counts whole candidates whose blind hunt found no blockers", () => {
  const provenance = [
    { file: "scenes/a.webp", generation: [
      { step: "candidate", batch: "a-1", candidate: "A", hunt: { blockers: ["third arm"] } },
      { step: "candidate", batch: "a-1", candidate: "B", hunt: { blockers: [] } },
      { step: "fix", hunt: { blockers: [] } },
    ] },
    { file: "scenes/a-dark.webp", generation: [{ step: "candidate", batch: "a-1", candidate: "B", hunt: { blockers: [] } }] },
    { file: "scenes/b.webp", generation: [{ step: "candidate", batch: "b-1", candidate: "A", hunt: { blockers: [] } }] },
  ];
  const { candidates, clean, rate } = oneShotRate(provenance);
  assert.equal(candidates, 3);
  assert.equal(clean, 2);
  assert.equal(rate, 2 / 3);
  assert.equal(oneShotRate([]).rate, null);
});
