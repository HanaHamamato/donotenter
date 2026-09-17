# IRONBOUND — *The Iron Reaches*

An open-world train simulator that runs entirely in the browser. Sixteen
kilometres square of procedural mountain, mill town and coast, 56.8 km of
spline railway cut and filled through it, twelve working stations, and a cargo
economy that pays you by the kilometre, the car and the minute you have left on
the clock.

There are **no art or audio assets in this repository**. Every model is
procedural geometry built at load time (65 models, 32,488 triangles in total),
and every sound is synthesised in Web Audio at runtime — diesel, turbo whistle,
rail rumble, flange squeal, horn, bell, brake hiss, coupler clank, thunder and
the tunnel reverb. The only data files are the three JSON descriptions of the
railway, the stations and the biomes.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts:

| script | what it does |
| --- | --- |
| `npm run build` | production bundle into `dist/` (three.js in its own chunk) |
| `npm run preview` | serve the built bundle on :4173 |
| `npm run gen:world` | regenerate `assets/data/*.json` from the world generator |
| `npm test` | all seven test suites (network, physics, assets, render, terrain, game, UI) |
| `npm run test:quick` | physics + full-game integration + UI |

Requires a WebGL 2 browser. The whole game is ~96 kB of gzipped application
code plus three.js.

---

## Controls

**Driving**

| key | action |
| --- | --- |
| `W` / `↑` | throttle up (8 notches) |
| `S` / `↓` | throttle down |
| `Space` | air brake — hold to apply, release to graduate out |
| `B` | emergency brake |
| `R` | reverser: forward / neutral / back |
| `X` | dynamic brake |
| `Z` | sanders (extra adhesion in the wet) |
| `H` | horn · `L` bell · `F` headlights |

**Working**

| key | action |
| --- | --- |
| `Tab` | cycle the route at the junction ahead |
| `E` | station board / interact |
| `Q` | uncouple everything behind the locomotive (`Shift+Q`: last car only) |
| `G` | re-rail after a derailment (costs credits) |
| `C` / `1`–`5` | camera: chase, cab, orbit, trackside, free fly |
| `M` map · `J` career · `U` depot & upgrades · `T` consist · `P` photo mode · `F3` debug |
| `Esc` pause menu · `F5` quick save · `F9` quick load |

The mouse only steers the camera (pointer lock; drag in orbit view, wheel to
dolly). Coupling is physical: drive gently — under 6 km/h — into a standing car
and it joins your consist.

---

## How it plays

1. **You start at Millford** with a GP-7, two empty boxcars and 500 credits.
2. **Contracts** are posted on the board at their origin station: N cars of
   cargo X to station B before a deadline, priced from rail distance, car count,
   fragility and how badly the destination wants it. Accepting loads your
   compatible empty cars from the yard on the spot.
3. **Delivering** happens by stopping at the destination — cargo sells itself,
   with a time bonus for arriving early and a condition bonus for fragile loads
   that were not slammed, derailed or dropped into a buffer stop. Cargo a station
   does not consume still sells, at a discount and without reputation.
4. **Reputation (0–5 per station)** opens regions; **money** opens locomotives;
   **ten timed deliveries** open passenger running; the last milestone opens the
   Summit Loop. Eight milestones, checked continuously against your career.
5. **Upgrades** — brake rigging, engine tuning, coupler capacity, three tiers
   each — are bought at any station and change the physics immediately.

Physics is a 1-D spline simulation at 60 Hz: tractive effort limited by both
adhesion and power/velocity, Davis-style resistance plus grade and curve
resistance, air-brake propagation car by car from the front, wheel slip with
sanders, body roll from unbalanced lateral acceleration, and derailment when you
exceed a segment's or a curve's limit by too much. Weather changes the adhesion
coefficient — dry 1.00, rain 0.74, storm 0.62, snow 0.55 — so the mountain in
winter is a different railway.

AI trains run the same physics with their own drivers: Dijkstra route planning,
switches thrown as they approach, braking curves for limits and stations, and
absolute-block signalling shared with the player. Their occupancy lights the
signals you read, and yours lights theirs.

---

## The world

| | |
| --- | --- |
| Playable area | 16 km × 16 km, 8×8 chunks of 2 km, four LOD tiers |
| Railway | 56.8 km, 37 spline segments, 36 nodes, 12 stations |
| Earthworks | 15 tunnels (4.68 km), 56 cuttings, 59 embankments |
| Structures | 4 bridges, 4 viaducts (masonry piers over 26 m, timber bents under), swing bridge, causeway, covered bridge |
| Water | open sea with tides, the Alder River and Creek, Portmouth tidal inlet |
| Biomes | plains, forest, coastal, alpine — blended fog, ground tint and scatter |
| Day | 20 real minutes, six keyframed colour states, moonlight and 2,400 stars |
| Weather | clear, overcast, rain, thunderstorm, fog, snow — GPU precipitation, drifting on its own |

Terrain is generated from value-noise FBM with ridged mountains, then the
railway is imposed on it: cover is measured every 8 m and the ground is
reclassified into cutting, embankment, tunnel, bridge or viaduct so nothing
floats and nothing is buried. Vegetation is scattered in 200 m cells by biome
weight, altitude and slope, rejecting the track corridor and the water, and is
instanced with per-prop colour — up to 26,000 instances per species group.

---

## Code layout

```
assets/data/          tracks.json, stations.json, biomes.json — the railway
tools/gen-world.mjs   the world generator that writes those files
tools/test-*.mjs      seven test suites, all runnable headlessly
src/constants.js      every tuning number in one place
src/utils/            math, noise, spline, terrain, geo builder, event bus
src/systems/          28 systems (see below)
src/ui/               HUD, panel sheets, title screen, DOM helper
src/game.js           the simulation: owns every system, one update(dt)
src/main.js           the browser shell: renderer, boot, input, resize, loop
```

Systems, in the order a frame touches them:

`InputManager` → `EconomyManager` → `BlockSystem` → `TrainController` →
`AITrainManager` → `StationManager` → `ContractManager` → `PassengerSystem` →
`TutorialManager` → `SaveManager` → `ProgressionManager` → `UpgradeManager`,
then the world: `BiomeManager`, `WeatherManager`, `SkyManager`/`DayNightCycle`,
`TerrainManager`, `TrackRenderer`, `VegetationManager`, `StructureManager`,
`WaterManager` (all orchestrated by `WorldStreamer`), then `CameraManager`,
`AudioManager`, `PostFX` and the HUD. `AssetManager` and `RollingStockManager`
serve the others; `NotificationManager` carries every message the game emits.

`src/game.js` has no DOM in it, which is why `tools/test-game.mjs` can run a
complete career — driving, coupling, contracting, AI traffic, weather, day/night,
milestones, upgrades, passengers, save and load — with no browser at all, and
`tools/test-ui.mjs` can drive the HUD and every panel under jsdom.

---

## Testing

```
✓ network        splines, arc-length, earthwork classification, corridor queries
✓ train physics  26 checks: forces, brake propagation, coupling, derailment, re-rail
✓ assets         65 procedural models, triangle budgets, no unknown keys
✓ render         tile build queue, bridges, viaducts, tunnels, portals
✓ terrain        surface error under 3 m across 2,307 samples
✓ game           101 integration checks over a whole simulated career
✓ ui             69 DOM checks: HUD writes, every sheet, every button, input mapping
```

---

## Saves

Careers live in `localStorage` under `ironbound.save.v3.{auto,1,2,3}` — an
autosave every 90 seconds, three manual slots, and a save on quit or tab close.
A save holds the clock, the ledger, every station's reputation and stock, every
contract, milestones and upgrades, every vehicle in the world and where it is
standing, your consist and its position on the rails, the switch settings, the
time of day and the weather. Settings are stored separately and survive a new
career.
