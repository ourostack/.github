import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { lint, oneShotRate, OURO_ANATOMY } from "./prompt-lint.mjs";

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
  Build: "natural adult proportions: a head about one-seventh of the standing height and a short neck about a third of the head's height",
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

test("a person with no neck length or head size, or a throw with no edge, warns", () => {
  const { Build, ...noBuild } = person;
  const bare = new Set(lint(prompt(`### The person\n${figure({ ...noBuild, Material: "smooth, seamless frosted glass; a natural neck about four tenths of the head's width" })}`)).warnings.map((w) => w.id));
  assert.ok(bare.has("neck") && bare.has("head-size"));

  const agent = lint(prompt(`### The agent\n${figure({ ...noBuild, What: "a small robot agent" })}`)).warnings.map((w) => w.id);
  assert.ok(!agent.includes("neck") && !agent.includes("head-size"));

  const throwOn = (outfit) => lint(prompt(`### The person\n${figure({ ...person, Outfit: outfit })}`)).warnings.map((w) => w.id);
  assert.ok(throwOn("a cream jumper under a tartan throw wrapped round the shoulders").includes("garment-edge"));
  assert.ok(!throwOn("a cream jumper under a tartan throw with a folded-over hem where it sits on the jumper").includes("garment-edge"));
  assert.ok(!throwOn("a cream jumper; no blanket").includes("garment-edge"));
});

test("the unstructured airship prompt that needed fixes fails and names its risky phrasings", () => {
  const old = `THE PERSON at the bow: exactly TWO arms; the far arm reaches out toward the horizon with an open, relaxed mitten (never a pointing finger). THE RIGGER, high on the left climbing a rope shroud toward the envelope.`;
  const { errors, warnings } = lint(old);
  assert.equal(errors.filter((e) => e.message.startsWith("missing section")).length, 11);
  assert.deepEqual(warnings.map((w) => w.id).sort(), ["open-hand", "single-rope-climb"]);
});

const ouro = {
  What: "Ouro, the person's pet snake, from brand/ouro.png",
  Material: "smooth, seamless emerald glass with a pale jade belly",
  Height: "the smallest figure; about as tall as the agent's head",
  Outfit: "none; he is the pet",
  Expression: "curious, head tilted toward the parcel",
  Pose: "curled on the doorstep, belly on the inner curve",
  Limbs: "none: one head, one continuous body, one short tail tip",
  Hands: "none",
  Facing: "head in three-quarter view toward the camera",
};
const withOuro = (fields, extra = "") => prompt(`### The person\n${figure(person)}\n\n### Ouro\n${figure(fields)}\n${extra}`);
const ouroErrors = (text) => lint(text).errors.filter((e) => /Ouro|open "C"|closed/.test(e.message));

test("Ouro's anatomy: an open C with a gap between head and tail tip, or the prompt fails", () => {
  const missing = ouroErrors(withOuro(ouro));
  assert.equal(missing.length, 1);
  assert.match(missing[0].message, /open "C" curl.*two ends of one body.*visible gap/);

  assert.deepEqual(ouroErrors(withOuro(ouro, `- ${OURO_ANATOMY}`)), []);
  assert.deepEqual(lint(withOuro(ouro, `- ${OURO_ANATOMY}`)).warnings, []);

  const story = prompt(`### The person\n${figure(person)}`).replace("A small agent hands its person a parcel.", "A small agent hands its person a parcel while Ouro watches.");
  assert.ok(lint(story).errors.some((e) => e.message.startsWith('Ouro is drawn but has no "### Ouro" cast block')));
});

test("ring, donut, torus and loop for Ouro's body fail, but not in a ban or for the agent called Loop", () => {
  const closed = (pose) => ouroErrors(withOuro({ ...ouro, Pose: pose }, `- ${OURO_ANATOMY}`)).map((e) => e.message);
  for (const pose of ['coiled in one round "O" on the doorstep', "coiled into a ring on the doorstep", "a donut of coils on the step", "curled in a loop on the step", "a glossy torus"]) {
    assert.equal(closed(pose).length, 1, pose);
    assert.match(closed(pose)[0], /describes Ouro's body as closed/);
  }
  assert.deepEqual(closed("curled in an open C beside Loop's feet, about half Loop's height"), []);
  const story = withOuro(ouro, `- ${OURO_ANATOMY}`).replace("A small agent hands its person a parcel.", "A small agent hands its person a parcel while Ouro sits in a ring.");
  assert.ok(lint(story).errors.some((e) => e.where === "Story" && /"ring"/.test(e.message)));
  const banned = withOuro(ouro, `- ${OURO_ANATOMY}`).replace("- No text", "- No closed ring, donut, torus or loop for Ouro's body.\n- No text");
  assert.deepEqual(ouroErrors(banned), []);
});

test("the airship prompt as it was, with Ouro 'coiled in one round \"O\"', now fails", () => {
  const before = read("agents/art-prompting/airship.prompt.md")
    .replace(/^- Body: an open "C" curl.*\n/m, "")
    .replace(/^- Pose: curled in an open "C".*$/m, '- Pose: coiled in one round "O" on the rail cap beside the person\'s far mitten, one short tail tip rising beside his head, belly on the inner curve, casting a soft shadow on the brass.');
  const messages = ouroErrors(before).map((e) => e.message);
  assert.ok(messages.some((m) => m.startsWith("Ouro's body must be described as")));
  assert.ok(messages.some((m) => m.startsWith('"round "O"" describes')));
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
