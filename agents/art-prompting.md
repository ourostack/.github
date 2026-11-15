# Art prompting: one prompt, one shot

How to write an image prompt that comes back right the first time. The bar every picture meets is [art-one-universe.md](art-one-universe.md); this page is how to reach it without patching.

Ari, 2026-11-15, after one hero took 20 patch rounds and a banner 14 blind reviews: "i feel like these images should not need so many revisions … make sure we're working smart, not hard", and then: "the eventual goal is to be able to confidently one-shot generate our imagery :)".

**What went wrong on 2026-11-15.** None of the eight first generations reviewed that day came back with zero blockers: airship candidates A, B and C, the LinkedIn door's first round, the Ouro UI for Windows and Android cores ([#103](https://github.com/ourostack/.github/pull/103)), the orchard core ([#105](https://github.com/ourostack/.github/pull/105)) and the Ouro HX mark ([#112](https://github.com/ourostack/.github/pull/112)). The day's one-shot rate was 0 of 8. Almost every blocker traces back to a word in the prompt, or a word missing from it:

1. **Hands were given gestures instead of jobs.** "Points at" needed a mitten fix in every scene that used it, even written as "points with the whole mitten", and "an open, relaxed mitten … never a pointing finger" drew spread fingers in two of three airship candidates.
2. **Facing was said against the scene, not the camera.** "Steps through the door" drew the agent walking out toward us, and "at the ship's wheel" turned the wheel to face the camera.
3. **One hand was asked to do two jobs,** so the model added a third arm. Counting the arms and giving each hand one job ended this: none of the three airship candidates had an extra limb.
4. **Material and build were left to the model.** "Glass" alone came out as tiled cells on every candidate, and "faceless person" with no build came out as a stick figure.
5. **Patching made new defects.** Most of what the door's 14 hunts found had been introduced or left by edits and upscaling: a wall with no base, an odd room behind the arch, sharpening halos. Regenerating from a fixed prompt costs less than a third fix.

## 1. The one-shot prompt template

Write the prompt as a Markdown file with these sections, in this order, and send its text to the image tool as it is. [`prompt-lint`](#4-the-checker) checks it before you generate. Two filled prompts pass it: [the airship](art-prompting/airship.prompt.md) (Ouro's galaxy) and [the LinkedIn door](art-prompting/linkedin-door.prompt.md) (CIT's galaxy).

1. **Story: one sentence.** One subject, one action, one relationship. If it needs a second sentence, the picture needs a caption.
   - Airship: "Ari's agents sail his glass-and-brass airship above the clouds at sunrise while he, faceless, looks out from the bow with his pet snake Ouro beside him."
   - Door: "A small glass agent walks away from us through a little door built just for it, beside a tall door built for people, while its person holds the little door open."
2. **Camera: lens, eye level, one vanishing point.** Say where we stand and what all the lines converge on.
   - Airship: "35 mm lens. Eye level: just above the person's head, as if we stand on the stern step behind them … One vanishing point, on the horizon just right of centre, where the deck planks, the rail and the envelope's ribs all converge."
   - Door: "50 mm lens. Eye level: the camera sits at the Stoker's head height, straight on to the wall. One vanishing point, at the centre of the small doorway."
3. **Composition: the safe area and the crop band.** Generate at the size you'll crop from, and say which rows survive every crop and what must stay calm for the headline or overlay.
   - Airship: "crop band is rows 256 to 768 … the upper-left third of the crop band stays calm envelope glass and sky."
   - Door: "crop band is rows 312 to 712 … the left 45% of the banner stays calm navy stage for the line and the logos … the profile photo covers the bottom-left quarter."
4. **Cast: one block per figure,** never one line for a group. Every block has these fields: What, Material, Height (relative to another figure), Outfit (for this scene), Expression (this moment's feeling), Pose, Limbs (counted), Hands (each hand's job), Facing (against the camera). Add Build where the model has no reference for the body.
   - Airship, the person: "Limbs: exactly two arms, each from its own shoulder, and two legs. Hands: … Near (left) mitten: wrapped round the barrel of a short brass spyglass, lowered at the hip. Far (right) mitten: resting closed on the brass rail cap beside Ouro. Facing: body faces the bow (right of frame), seen three-quarters from behind, back mostly to the camera."
   - Door, the Stoker: "Height: the reference height … Expression: eager, shown by its body: a springy mid-stride and the antenna bead glowing brighter … Hands: both mittens swing empty at its sides. Facing: back to the camera, walking away from us into the warm light of its door."
5. **Props: each one's orientation and how it's held or mounted.**
   - Airship: "Ship's wheel … Its axle runs fore and aft, so from this camera the wheel is a narrow, nearly edge-on ellipse with visible spokes and handle pegs."
   - Door: "A teal-glass leaf … hangs on two hinges on the arch's right jamb and is swung open toward the camera to about 70 degrees. A round teal knob sized for a mitten sits on the leaf's free edge."
6. **Setting,** including anything that moves soft things.
   - Airship: "The wind blows from the bow, so everything soft streams back toward the stern (left of frame)."
   - Door: "CIT's house stage: a glossy deep navy-to-indigo glass floor with soft bokeh behind, and nothing else on the stage."
7. **Light:** the key light, the shadows that seat each figure, and any glow with its job in this scene.
   - Airship: "a soft contact shadow under every foot and under Ouro. Ouro's inner glow spills green onto the brass rail."
   - Door: "The warm amber spill from the small door is the key light on both figures and the floor."
8. **Palette:** a short list. Airship: "Sunrise peach and blue sky, cloud white, brass gold and warm oak …" Door: "Deep navy, indigo, frosted white glass, teal and amber."
9. **Must not:** one bullet per ban. Start from the house list (no text, letters, numbers, logos or symbols; no fingers; no third arm; no fades), then add every blocker this scene has had.
   - Airship: "No tiles, cells or facets on the glass bodies." Door: "No room, furniture or scenery visible through the small door."
10. **Output:** the generation size, the number of candidates and every crop it ships as. Airship: "Three candidates, each generated whole at 1536x1024 … a 3072x1024 master … a 5:3 phone crop."
11. **References:** each image, in order, and what to take from it. A reference carries its own poses and defects, so say what not to copy.
    - Airship: "The approved v11 airship master, for the world … only. Its figures are not to be copied … `brand/ouro.png`, for Ouro's exact face and coil."
    - Door: CIT's `ref-spring-standing.jpg`, with the [canon character block](https://github.com/gim-home/CIT/blob/main/_meta/art/duo/kit/canon-prompt.txt) folded into the cast blocks.

## 2. Phrasings that work and phrasings that fail

Evidence for the airship and door is on the [`evidence/art-prompting-2026-11-15`](https://github.com/ourostack/.github/tree/evidence/art-prompting-2026-11-15) branch ([airship candidates](https://github.com/ourostack/.github/tree/evidence/art-prompting-2026-11-15/airship) and [review notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md), [door rounds](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/door/notes.md)).

| Blocker | Failed: what was written, or missing | Worked | Evidence |
| --- | --- | --- | --- |
| Extra or missing limbs | One arm given two jobs (spyglass at the eye and a gesture): a third arm from the same shoulder, passed by two reviewers | "Exactly TWO arms, each from its own shoulder: the near hand … the far arm …": no extra limb in three of three candidates | [#104](https://github.com/ourostack/.github/pull/104), [airship notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md), [core prompt](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/core-prompt.md), [cand-A](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-A.jpg) |
| Hands with fingers | "points at", even "points with the whole mitten"; "an open, relaxed mitten"; "holds out an open mitten" | A job for every hand: "resting closed on the rail cap", "holds the leaf's free edge"; CIT's "round … mittens with one small thumb, like a winter mitten"; "stretches an arm toward a warm light with a closed mitten" | [#103](https://github.com/ourostack/.github/pull/103), [#105](https://github.com/ourostack/.github/pull/105), [cand-A and C crops](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-A-C-crops.jpg), [CIT art log](https://github.com/gim-home/CIT/blob/main/_meta/art/README.md) (scene-interview, explainer-point) |
| Second thumb | A welcoming, open-armed Captain | Each mitten holds or rests on something | [door notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/door/notes.md) |
| Object facing the wrong way | "at the ship's wheel": the wheel faced the camera | "Its axle runs fore and aft, so from this camera the wheel is a narrow, nearly edge-on ellipse" | [airship notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md), [core prompt](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/core-prompt.md) |
| Door or hinge backwards | A door with no hinge side named | "hangs on two hinges on the arch's right jamb … knob on the leaf's free edge" | [door notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/door/notes.md) |
| Figure facing the wrong way | "the Stoker steps through": it walked out toward us (r4, r6) | "back to the camera, walking away from us into …" (r21) | [door rounds](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/door/rounds-r1-r4-r6-r21.jpg) |
| Face lost when turning a figure | Fixing the helm turned Loop into a back view, and his visor disappeared | Body and head given separately: "body faces the bow; head turned three-quarters toward the camera so his visor and both eyes read" | [airship notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md) |
| Inconsistent perspective | No camera line: the gondola's sides and deck disagreed (Ari, on v10) | "ONE camera, one vanishing point: we look across the open deck from slightly above and behind" passed on the next draw | [airship notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md) |
| Clones | Agents drawn from one sheet or described as a group | One block per agent, each with its own colour, outfit, prop and expression: three distinct agents in three of three candidates | [#93](https://github.com/ourostack/.github/pull/93), [cand-B](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-B.jpg) |
| Stock expressions | "friendly", "smiling", or none: the same smile everywhere | A feeling and the face that shows it: "gleeful: eye arcs squeezed into happy crescents"; "tongue-out concentration". Watch "narrowed": Loop's "determined, narrowed-eye" read as angry, so say "eye arcs held level, never slanted inward" | [#114](https://github.com/ourostack/.github/pull/114), [cand-B fixes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-B-three-fixes.jpg) |
| Pasted in, not lit by the scene | "Ouro sits large in the exact centre … smiling at the viewer"; Ouro taken only from his reference | "on the rail cap … casting a soft shadow on the brass … inner glow spills green onto the rail": seated and lit in three of three. His head still faced the camera, as in his reference | [airship notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md), [#103](https://github.com/ourostack/.github/pull/103), [#105](https://github.com/ourostack/.github/pull/105), [cand-C](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-C.jpg) |
| Motif repeated where it means nothing | A style block that carries "a glowing braided trail" or "a thread of warm gold light" into every scene | A glow named for what it does here: "warm amber light from inside spills across the threshold" | [#113](https://github.com/ourostack/.github/pull/113), `brand/provenance.json` header prompts |
| Dated devices | "small blank smartphones", "one widescreen monitor": notched phones from about 2019 | Name the generation (current: edge-to-edge glass, thin even bezels) or pick a vintage object (a brass spyglass) | [#103](https://github.com/ourostack/.github/pull/103), [#106](https://github.com/ourostack/.github/pull/106) |
| Text artifacts | A grid or cut-out left to chance: eye cut-outs read as "?" and ")" | "No text, letters, numbers, logos or symbols anywhere; every sign, page and screen is blank or soft light"; "the window grid must not form a four-square logo" | [#109](https://github.com/ourostack/.github/pull/109), [#103](https://github.com/ourostack/.github/pull/103) |
| Scale errors | "bigger", "large in the exact centre": Ouro too big, then too small; agents with no height came out adult-sized | Height against a named figure: "about half Loop's height", "the top of the Stoker's head is level with the Captain's shoulder" | [#88](https://github.com/ourostack/.github/pull/88), [#102](https://github.com/ourostack/.github/pull/102), [airship notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/notes.md) |
| Contact that can't hold | "climbing a rope shroud … both mittens and both feet on the rope": a foot off the rope in two of three | A support for every contact: a rope ladder's rungs, a step | [cand-B fixes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-B-three-fixes.jpg) |
| Soft things that ignore the wind | A scarf with no wind named hung straight down beside a scarf streaming in the wind | One wind direction in the setting, repeated on each soft item | [cand-B fixes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-B-three-fixes.jpg) |
| Tiled or speckled glass | "glass" alone: cells and facets on every body | "smooth, seamless … glass"; "smooth polished frosted glass … with no dots" | [cand-A](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/airship/cand-A.jpg), [door notes](https://github.com/ourostack/.github/blob/evidence/art-prompting-2026-11-15/door/notes.md) |

## 3. The loop

1. **Lint the prompt** until it has no errors, and fix or justify each warning.
2. **Generate three whole candidates** from the same prompt, in parallel.
3. **Blind-hunt each one once**, as in [art-one-universe.md](art-one-universe.md#how-to-check-a-picture-before-anyone-sees-it): a fresh reviewer, only the picture and 4x crops of each figure, "list everything physically wrong".
4. **Ship any candidate with zero blockers as it is.** Don't patch a clean picture. Polish goes on the review list.
5. **Otherwise, at most two targeted fixes** on the candidate with the fewest blockers, then one more hunt.
6. **Still blocked? Fix the prompt, not the picture.** Turn each blocker into a field, a phrasing from the table above or a Must not line, then go back to step 1.
7. **Log every generation** in `brand/provenance.json` under the file's `generation`, picked or not: the whole prompt (never an excerpt), its inputs and the hunt.

   ```json
   { "step": "candidate", "batch": "airship-2026-11-16", "candidate": "A",
     "prompt": "<the whole prompt text>", "input_images": ["brand/ouro.png"],
     "master_sha256": "…", "picked": true,
     "hunt": { "blind": true, "blockers": [], "polish": ["render noise on the rail at 4x"] } }
   ```

8. **Track the one-shot rate:** the share of whole candidates, straight from a prompt, whose hunt found zero blockers. `node brand/tools/prompt-lint.mjs --rate brand/provenance.json` prints it. The goal is three of three.

## 4. The checker

[`brand/tools/prompt-lint.mjs`](../brand/tools/prompt-lint.mjs) reads a prompt file and needs only Node:

```sh
node brand/tools/prompt-lint.mjs agents/art-prompting/airship.prompt.md   # exit 0: ready to generate
node brand/tools/prompt-lint.mjs --strict --json my-scene.prompt.md       # warnings fail too
```

- **Errors (exit 1):** a missing or empty section; a story longer than one sentence; a camera with no lens, eye level or "one vanishing point"; a composition with no safe area or crop band; a figure with no What, Material, Height, Outfit, Expression, Pose, Limbs, Hands or Facing; limbs not counted; hands not said one by one; facing not stated against the camera; a height not relative to anything; an empty Must not; no output size.
- **Warnings:** the failed phrasings in the table above (pointing, open or waving hands, fingers, a device with no generation, cloned agents, light trails, a free climb on one rope, a soft item with no wind, bare "glass", a stock expression), each with its evidence.

Its tests are in [`brand/tools/prompt-lint.test.mjs`](../brand/tools/prompt-lint.test.mjs): `node --test brand/tools/prompt-lint.test.mjs`.
