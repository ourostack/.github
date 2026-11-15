# Art: one universe, different galaxies, one bar

Shared guidance for every agent and person making pictures for ourostack, spoonjoy, arimendelow and CIT surfaces: sites, READMEs, social cards, decks, banners, comics and app art. Each repository's AGENTS.md points here.

**Every brand lives in one shared universe; each has its own galaxy; every picture meets the same bar.** Ari, 2026-11-14, first: "on art style, should be distinct between CIT + ouro, but equally beautiful and polished and professional … make sure this reaches all agents working on all our stuff across all machines and desks so that by the time y'all return control, all art across all surfaces is up to snuff :) surprise and delight, everywhere and forever <3". Then, a minute later: "maybe think less different universes and more same universe different galaxies? that is probably better - it IS the same universe, i overcorrected with multiverse".

- **Shared across the universe:** the light, the materials and the craft, and the same kind of faceless person and small agent. CIT's frosted-glass art is the standard to match. Ari on it: "this art is so much more beautiful and engaging than the 'storybook' style".
- **Each galaxy's own:** its places, its palette and its signature.
  - **CIT:** Captain and Stoker on the navy stage. Canon: CIT-pages [`pages/VISUAL-LANGUAGE.md#the-duo`](https://github.com/gim-home/CIT-pages/blob/main/pages/VISUAL-LANGUAGE.md#the-duo); kit: CIT's [`_meta/guides/brand-kit.md`](https://github.com/gim-home/CIT/blob/main/_meta/guides/brand-kit.md).
  - **Ouro:** its own cast, places and palette, never a copy of CIT's cast. Canon: [`brand/`](../brand/) here. Ouro stays on-model with `brand/ouro.png`: one round "O" curl, one head with that face, one short tail tip.
  - **Other brands** (Spoonjoy and the rest): their own galaxy in the same universe.
- **One vision per picture, never a camel** (Ari: "no camel (aka horse built by committee)"). Don't bolt every idea from every reviewer onto one picture.

## The bar every picture meets

- **Beautiful, polished and professional.** Someone who met Ari while representing CIT, such as a customer, a partner or a colleague, should come away trusting him, and the people he represents. Cute is fine; amateur, garish or "Pixar-cute, not CIO-ready" is not.
- **Every surface gets its own picture.** One universe means shared light, materials and cast, not one scene reused. No two surfaces show the same composition, setting or staging; each picture tells its own surface's story. Ari, 2026-11-15, on finding ui.ouroboros.bot's hero and ouroboros.bot's home hero nearly the same: "we need diversity of photos!! does that need to be said?" Before shipping, compare a new picture with every other surface's art (`brand/surfaces.json` and each site's heroes) and change it if it echoes one.
- **It reads in a fraction of a second.** One subject, one action and one clear relationship. If a picture needs a caption to make sense, it fails. Ari, 2026-11-14: "someone is landing on these surfaces, they have a fraction of a second of attention to give, what can we do to surprise, delight, and engage them?"
- **Every element earns its place in this picture.** Glow, light paths, floating cards and glowing screens are welcome when they make sense in the scene. What fails is a motif copied into every picture whether or not it means anything there, and a symbol a viewer can't read. Ari, 2026-11-15, after lanes stripped glows everywhere: "i dont have something against glowing paths and such, it just became this weird thing that was in all the images even when it didnt make sense". No generated text, letters or logos; composite real logo files afterwards.
- **Fix what's wrong; keep what works.** A redraw changes only the thing that failed and keeps everything that was working. Never turn one question into a sweep across every picture. Ari: "dont overcorrect!"
- **Agents are small and cute, and individuals.** Ari: "agents must always stay small and cute!" They are never clones ("why are all the agents clones?"), never adult-height humanoids, and never creepy.
- **Agents are real, expressive characters.** Like the Captain, each agent is dressed for its scene (goggles and a scarf on an airship, an apron in a workshop, a cap on a ride) and shows what it feels in this moment: concentration, delight, surprise, pride, a sleepy yawn. Show it with its face or visor, its pose and its props, never the same stock smile everywhere. Ari, 2026-11-15: "agents can be more expressive.......have fun with it!!!! make these feel like real, expressive characters - express using clothes, expressions, etc".
- **People don't break the three smells.** From [ouroboros.bot](https://ouroboros.bot/): you're doing it by hand; you're teaching it twice; control keeps coming back to you. People decide and judge; agents do the work. People never push, carry, build or type, and never hover to approve every step.
- **No recognizable humans** (Ari, 2026-11-14). People are faceless, in the shared universe's figure style; never a likeness of a real person.
- **Everything makes physical sense.** Check hands, tools, legs and seats zoomed in. CIT's figures wear mittens with a thumb and never point with a finger.
- **Devices are current-generation or clearly vintage, never a few years old.** Ari, 2026-11-15, on phones with a notch but no Dynamic Island: "use either very modern devices, or vintage ones - here, you're using phones that are recognizably 5ish years old … make all art greenfield! using tech that would feel dated (but not vintage) it makes the art read as dated." Today's phones, laptops and screens, or an obvious antique (rotary phone, brass telescope, typewriter); nothing in between.
- **No picture fades into the page.** Hard edges, no text glow, and words beside or above the art, never over it.

## How to check a picture before anyone sees it

Before generating, write the prompt to the one-shot template in [art-prompting.md](art-prompting.md) and lint it; most blockers below start as a missing or risky word in the prompt.

1. Compare each character, zoomed in, side by side with its reference sheet.
2. Look at the picture at about 400 px wide, as on a phone, and at every crop it will be cut to.
3. Show it to a fresh reviewer who sees only the picture, and ask what is happening in one sentence. If they hesitate or read something else, fix it or drop it.
4. **Blind defect hunt: no picture ships without it.** Give a fresh reviewer only the image and crops of each figure at 4x. Don't tell them what changed and don't share the author's description. Ask: "list everything physically wrong".
   - Count heads, arms, hands, legs and tails per figure, and trace every limb to its joint.
   - Check that every held object has a hand holding it.
   - Check each object's facing against the camera and its use (a ship's wheel faces the bow, a door hangs on its hinges).
   - Check any device that reads dated: anything that isn't current-generation or clearly vintage.
   - Check day and night separately.

   Sort what the reviewer finds:
   - **Blockers, fixed to zero:** anything physically wrong (limbs, holds, facing, mechanism orientation, a dated device, impossible geometry such as a door that can't fit its opening), and any defect you can see at the shipped size or at 2x, mushy hands included.
   - **Polish, visible only in the 4x crops** (render noise on metal, a missing contact shadow): fix it if it's cheap, otherwise log it on the review list and ship.

   It ships only when that reviewer finds no blockers. The author's notes and a "fixed what was asked" check never count as a pass. Ari, 2026-11-15, after reviewers twice passed an airship hero whose person had three arms and whose helm faced the camera.

Whoever sees art on a surface that misses this bar fixes it, or tells that surface's owner with the evidence.
