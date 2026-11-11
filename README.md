# DIY
DIY is a 3D sandbox for anyone deciding what to build a career around. Take apart a robotic arm, a motorcycle, a prosthetic or a bioreactor — orbit them, click any part to learn what it does, then rebuild them piece by piece. No courses, no grades, nothing to finish. Just a cheap way to find out which machine you can’t stop looking at.

## Running it

You need [Node.js](https://nodejs.org) 18.17 or newer. Check with:

```
node -v
```

Then, in this folder:

```
npm install
npm run dev
```

Open <http://localhost:3000>.

The first `npm install` downloads the dependencies and takes a couple of minutes.
After that, `npm run dev` starts in a few seconds.

## What's here

```
app/page.tsx        the app: landing page, 3D viewport, left rail, guide cards
app/layout.tsx      page shell
app/globals.css     Tailwind plus a dark background
data/machines.json  model paths, scales and hotspot positions
public/models/      the 3D models (35 MB) - the app loads these at runtime
scripts/            the model pipeline: see scripts/README.md
```

`data/machines.json` is where you move a hotspot or swap in a new model, without
touching any code. `app/page.tsx` holds the 3D scene and the interface.

## The machines

Seven use real 3D models:

| Machine | Model | How it works |
| --- | --- | --- |
| Robotic Arm | `robot-arm-parts.glb` + `robot-arm-complete.glb` | 23 separate parts you assemble step by step |
| Motorcycle | `motorcycle.glb` | one piece, 5 labelled hotspots |
| Prosthetic | `prosthetic-arm.glb` | one piece, 6 hotspots |
| Tablet | `tablet.glb` | one piece, 4 hotspots |
| Laptop | `laptop.glb` | one piece, 7 hotspots |
| 3D Printer | `printer-3d.glb` | one piece, 6 hotspots |
| Bioreactor | `bioreactor.glb` | one piece, 7 hotspots |

The Automobile, House and Smartphone are still built from simple shapes in code.

## Controls

- **Drag** to orbit, **scroll** to zoom
- **W A S D** to move, **Shift** to go faster, **Q / E** down and up, **R** to recentre
- **Click a part or a glowing dot** to open its guide card
- The left rail has machines, lessons, components, a player and settings

## Changing a model

Replace the file in `public/models/` and keep the same name, then adjust that
machine's `scale` and `spots` in `data/machines.json`.

Rather than guessing the new coordinates, measure them:

```
python3 scripts/hotspots.py check motorcycle   # how far each spot is from the mesh
python3 scripts/hotspots.py snap motorcycle    # corrected coordinates to paste back
```

Then look at the result:

```
npm run build
npx next start -p 3300        # leave running in another terminal
node scripts/qa.js out/qa
```

`scripts/README.md` has the full pipeline, including what these checks cannot
catch — chiefly a label sitting neatly on the wrong part, which passes both.

## Putting it online

Import this repo at [vercel.com](https://vercel.com). The free tier covers it.
Vercel gives you a public URL and you can add your own domain later.
