# Model pipeline

Everything needed to take a Meshy export and turn it into a machine in the sandbox.
Run these from the project root.

## Adding a machine

1. **Generate the model.** Prompts live in the Meshy Prompt Pack. One sheet per
   machine, parts laid out in a single row with real gaps between them.

2. **Normalise it.** The sandbox does *not* normalise models when it loads them:
   it multiplies the raw GLB coordinates by the machine's `scale` and nothing
   else, while hotspot positions are written as if every model were one unit
   across. A model straight out of gltfpack is whatever size Meshy made it, so
   it will come in at the wrong scale with every hotspot misplaced.

   ```
   python3 scripts/normalise.py --check public/models/thing.glb
   python3 scripts/normalise.py raw.glb public/models/thing.glb
   ```

   `scripts/pose.py` does this itself, across all the parts at once, so a parts
   model does not need a separate pass.

3. **Clean it up.**

   ```
   python3 scripts/prep.py scripts/ raw.glb public/models/thing.glb '{"keep": [...]}'
   ```

   Keeps the islands you want, drops ground plates, normalises size, shrinks
   textures. Run it with no options first to see what islands exist.

4. **Add it to `data/machines.json`** with its model path, a scale, and a rough
   guess at each hotspot position.

5. **Measure the hotspots properly.**

   ```
   python3 scripts/hotspots.py box thing      # bounding box and heights
   python3 scripts/hotspots.py check thing    # how far each spot is from the mesh
   python3 scripts/hotspots.py snap thing     # snapped coordinates to paste back
   ```

6. **Look at it.**

   ```
   npm run build
   npx next start -p 3300        # leave running in another terminal
   node scripts/qa.js out/qa
   ```

## What each check can and cannot catch

| | `hotspots.py check` | `qa.js` | Your eyes |
| --- | --- | --- | --- |
| Hotspot floating off the model | yes | no | sometimes |
| Hotspot buried inside the model | yes | no | no |
| Labels overlapping each other | no | yes | yes |
| Model failing to load, or black | no | yes | yes |
| **Label on the wrong part** | **no** | **no** | **yes** |

That last row is the important one. A hinge marker sitting neatly on the front
edge of a laptop is on the surface, does not overlap anything, and is wrong.
Both scripts pass it. Always look at the screenshots.

## The files

| | |
| --- | --- |
| `glb.py` | shared GLB reader: chunks, accessors, quantised attributes |
| `prep.py` | island filter, normalise, texture resize |
| `toweb.py` | GLB to glTF JSON plus JPEGs, for hosts that will not serve `.glb` |
| `hotspots.py` | measure and snap hotspot positions against real geometry |
| `qa.js` | render every machine, check labels, write screenshots |

## Coordinates

Hotspots are in normalised model units: largest dimension scaled to 1.0, centred
on x and z, base at y = 0. So `y: 0.5` is half the model's height whatever its
real size, and the numbers stay valid if you swap in a different model of the
same machine.

`[x, y, z, viewAngleDeg]` — x left to right, y base to top, z back to front, and
the angle the camera swings to when that part is selected (0 = front).
