# Concrete Sky

A moody, experimental first-person run through an endless brutalist city,
playable in the browser. You run across podium decks, climb stairs onto
rooftops, and cross bridges between towers while the day turns and the
weather changes above you.
Long stairs wrap around the podium corners from the street, and open lifts
run beside some of them. Stair and lift towers on the block corners climb to
skyways 36 or 42 m up, some railed, some covered and some just a bare
concrete beam. Where a bridge has fallen, its broken stubs are still there to
jump at a sprint.
Cars stream along the avenues and flyers cross the air above the streets.
People walk the pavements round the blocks, busiest at the rush hours and
thinning out at night and in the rain, and they step out of your way.
Take a parked flyer from a landing pad, fly to another roof and step out,
shoot other flyers out of the sky, or take a car and drive. Hunters come after
you on foot, in cars and in flyers, and there's nothing to do but stay ahead
of them (or turn them off with H). Health kits, white cases with a red cross,
turn up near you while you're hunted, and a downed hunter sometimes leaves one
(hanging in mid-air, if they were flying); run, drive or fly through one to heal. Under some of the avenues there is a subway:
find an entrance, take the stair down, and ride a train to the next station.
M opens a map of the streets, railways, subway lines and rivers around you.

Everything is generated in code, with no image or sound files:
- the city
- the textures: board-formed, bush-hammered ribbed, plywood-formed and precast
  concrete (with tie holes, rust runs, salt bloom and rain streaks), asphalt,
  paving
- the sky: the sun's arc through a real day, the clouds and the weather
- the sound: wind, drones, rain and footsteps

## Play locally

```sh
npm install
npm run dev        # http://localhost:5173
```

Click the page to capture the mouse.

| key | |
|---|---|
| mouse | look |
| W A S D / arrows | run |
| Shift | sprint |
| Ctrl / C | walk |
| Space | jump; hold it while running into a ledge up to ~2.3 m high to climb it |
| E | get into a parked car, a passing car or a parked flyer, or board a train standing at a platform / step out |
| left mouse / F | shoot (on foot while the hunters are on, and in a flyer) |
| V | chase camera or cockpit view (in a vehicle) |
| R | return to the last roof you stood on |
| H | hunters on / off |
| U | music on / off (remembered; `?music=0` starts with it off) |
| N | skip to the next weather |
| L | hold the current weather / let it drift again |
| , / . | wind the clock back / forward an hour (hold to run the day past) |
| K | hold the clock where it is / let it run again |
| F3 | stats (fps, GPU, position) |
| F4 | copy stats to the clipboard |
| Esc | pause |

**In a flyer:** the mouse steers and W flies where you look. A / D strafe,
Space / Ctrl climb and descend, and Shift boosts. The left mouse button (or F)
fires bolts toward the crosshair, with a little aim assist. A hit flyer catches
fire, falls and explodes on impact. Cars can be shot too: passing ones, parked
ones, and any you left somewhere. They blow up into the air and land as burning
wrecks, which stay in the street and can't be driven again. Set down on any roof or deck and press E
to step out. The flyer stays where you left it.

**In a car:** W accelerates, S brakes and then reverses, and A / D steer.
Space is the handbrake and Shift boosts. The mouse looks around, and the view
drifts back behind the car. Stop and press E to get out. You can take a parked
car, or step into the avenue and take a passing one.

**Subway:** some avenues have a line under them, and the map shows both the
line and a ring at every entrance. An entrance is a stair down off the pavement,
doubling back on itself for twenty metres or so, into a passage over the tracks
and down again onto an island platform. Trains call every twenty-four seconds,
one each way, half a cycle apart. Press E beside one standing with its doors
open to get on, walk about inside while it runs, and press E again at a stop to
step out — the caption tells you which station it is. It is a real way across
the city: the stops are a few hundred metres apart and the train does not stop
for traffic.

**Hunters:** figures in long dark coats with red visors, and black cars and
flyers. The first ones turn up about ten seconds after you start. Up to two
are out at first, and one more can join every 45 seconds, up to five. They run
the decks and follow you over the bridges from block to block, and jump down
after you when you drop into the street. When you get out of reach they take
the nearest parked flyer or car, or pull someone out of a passing one. Their
own cars drive the street grid and plough through traffic to run you down.
Their flyers come along the street canyons, then circle above you and fire
red bolts. The bar at the top shows your health. It comes back after a few
seconds without a hit, and the red edge of the screen flashes when you're hit.
Red arrows at the edge of the screen point to hunters out of view. On foot,
the mouse fires a sidearm (one hit takes a runner down), and you can run
hunters over in a car. Their cars and flyers take three hits. If they get you,
whatever you were in blows up and you're back on the last roof you stood on.
They back off for a while after that, and the pressure eases a little.

**On a phone or tablet:** tap the title screen to play (it goes full screen
where the browser allows). Your left thumb places a stick wherever it lands:
push lightly to walk, further to run, all the way to sprint. Drag with your
right thumb to look. Jump climbs ledges; in a car it is the handbrake, and in
a flyer the up / down buttons climb and descend and fire shoots. To get in or
out, tap the prompt at the bottom of the screen. The buttons at the top go
back to the last roof, turn the hunters on or off, change the weather, switch
the vehicle view and pause. On foot, fire shoots while the hunters are on.
It plays best held sideways.

**Demo:** *watch the demo* on the title screen (or `?demo`) hands the city to
an autopilot. It flies an arterial's air corridor, runs along the podium decks
and over their bridges, drives an arterial, and sails the river where there is
one within reach. Each scene brings in the next weather. There are
no hunters in the demo. It also starts by itself after 45 seconds on the first
title screen. Click, tap or press a key to take over wherever it is, including
the vehicle it is in. Esc goes back to the title screen.

Every visit generates a new city. Its number is shown on the title screen and
in F3, and `?seed=12345` brings a particular city back.

**Time of day:** the city keeps a clock, and one real minute is one hour in it,
so a full day takes 24 minutes. It starts mid-afternoon and runs down through
the long light into the golden hour, sunset, the blue hour and a moonlit night
before dawn comes back round. The sun travels a real arc — up out of the
north-east, high in the south, down into the north-west — and every shadow in
the city swings with it. After it sets the lamps and the windows come on, the
stars come out, and the moon takes over as the light: always full, always
opposite the sun, so it rises as the sun goes down and casts its own shadows. `,` and `.` wind the clock an
hour at a time, K holds it, and `?time=19:25` starts wherever you like.
`?weather=` also takes a moment — `dawn`, `sunrise`, `white noon`,
`golden hour`, `sunset`, `blue hour`, `midnight` — which sets the hour as well
as the sky.

URL options: `?seed=12345`, `?demo` (start in the demo) / `?demo=0` (never start it by itself), `?hunters=0` (no hunters), `?weather=overcast`, `?time=19:25` (the hour to start at), `?daylength=300` (real seconds in a day; `0` stops the clock), `?vehicle=1` / `?vehicle=car` (start in a vehicle), `?scale=0.7` (internal resolution),
`?dpr=2` (render at full device pixel ratio), `?msaa=0|2|4`,
`?shadowsize=1024|2048|4096`, `?prepass=0`, `?pose=x,y,z,yaw,pitch`.

## Publish

`npm run build` writes a static site to `dist/` that works from any static
host or sub-path. The included GitHub Actions workflow
(`.github/workflows/pages.yml`) runs the tests, builds the site and publishes
it to GitHub Pages on every push to `main`. To turn it on, open the
repository settings and set Pages › Source to *GitHub Actions*.

## Graphics card

The page asks the browser for the high-performance GPU
(`powerPreference: "high-performance"`), but on Windows laptops Chrome and
Edge pick one GPU for the whole browser. If the title screen says it's
running on integrated graphics, open Windows Settings › System › Display ›
Graphics, set your browser to *High performance*, and restart the browser.
When frames get slow, the game also lowers its internal resolution
automatically. Press F3 to see the GPU in use and per-pass GPU timings.

### Performance

What keeps the game fast:

- **Pixel ratio:** it renders at CSS-pixel resolution, so high-DPI screens
  don't pay 4× the pixels.
- **Anti-aliasing:** 2× MSAA on integrated GPUs, 4× on discrete ones.
- **Culling:** only city blocks inside the view are drawn, nearest first.
  A depth pre-pass means only the visible surface of each pixel gets shaded.
  It is off on Apple GPUs (iPhone, iPad, Mac), where it made surfaces flicker;
  `?prepass=1` turns it back on.
- **Level of detail:** small detail (steps, railings, fins) is dropped
  beyond 230 m.
- **Sun shadows:** the shadow map is re-rendered only after moving 12 m or
  when the sun moves.
- **Cloud shadows:** they come from a small texture updated each frame.
- **Sky:** it is drawn last, and only where no building covers it.
- **Bloom:** it works from a half-resolution copy.

What keeps it quick to start (the loading line counts from 0 to 100 across all of it):

- **Textures:** the noise texture and the eight material layers each have their own
  seed, so the worker pool builds all nine at once instead of one thread
  building them in a row.
- **Hashing:** every block, river and window comes out of one 64-bit mix,
  tens of millions of times per city. It is 32-bit arithmetic rather than
  BigInt, which is about eleven times faster for bit-for-bit the same numbers
  — a seed still brings back the city it always did, and a test in
  `tests/traversal.test.ts` holds it to that.
- **Rivers:** `riverNear` runs for every square metre of ground, since each
  river cuts its own valley. It compares squared distances and takes no square
  root until it knows which stretch of water won.
- **Spawn:** the search for somewhere to start is the one part that has to run
  on the main thread, so it hands back a step at a time and the page keeps
  counting through it. `?pose=` skips it, since the answer would be thrown away.

On an Intel UHD 770 at 1920×1080 this runs at roughly 80–85 fps uncapped;
an RTX 3060 Laptop GPU runs it at roughly 500+ fps.

Requires WebGL2 with `EXT_color_buffer_float`, which every current desktop
browser has. When `EXT_clip_control` is available, the game uses it for
reversed-Z depth.

## How it works

| file | |
|---|---|
| `src/city/network.ts` | The road network the city is laid out on: an endless, deterministic plan of arterials, streets and the blocks between them, from a jittered Voronoi diagram with through-routes added, plus the landform the whole thing sits on and the rivers that cut it. |
| `src/city/plan.ts` | The city built on that network. Every block is a polygon rather than a cell of a grid, so a podium is a wall of turned boxes wrapped round an outline. Also the ground tiles, the roads, their bridges over the rivers and railways, the stairs and lifts up to the decks, the spawn, and the subway — a cut-and-cover box under an arterial, set deep enough that nothing the surface builds reaches down to it, so the only place the two meet is the hole in the pavement the entrance comes up through. A station is laid dead level and sits on a whole node of the line, which is what lets the flat concrete and the boxes standing on it agree where they begin and end. |
| `src/city/generate.ts` | Shared geometry primitives — the box builder, region assembly, stairs, lift shafts, pylons — and the older fixed-grid city they were written for, which is no longer built (the tests still cover it). Deterministic city on an 88 m grid. Streets are canyons; each block is a raised podium (18, 24 or 30 m) linked to its neighbours by bridges, which become stepped bridges when the heights differ. On top of the podiums sit skyscrapers (with setbacks, sky lobbies, cross or split plans, pilotis and plant-floor bands; their height is limited by their footprint), bundled towers, slab blocks with detached service cores, courtyard megablocks, gate towers joined by a high bridge block, inverted-ziggurat towers that cantilever outward as they rise, mid-rise towers with stairs wrapping around the outside up to their roofs, terraces, and parkour pillars. Street crossings may get skyways at 36 or 42 m (below the lowest flyer corridor), reached by stair or lift pylons on the podium corners. The stairs are two long flights with one turn. Where two podiums have no bridge, there are often broken stubs with a gap to jump. A slowly varying district density decides where the dense high-rise quarters are. From the street, a stair wraps around one podium corner (two long flights and a landing on a pier), and many blocks also have an open lift in another corner. The city is made only of boxes, meshed in batches of 3×3 blocks. |
| `src/lifts.ts` | Lifts: open platforms on a fixed timetable (their height is a function of time, like the traffic). They add their platforms to the collision boxes, keep riders on while they move, lift anyone they come down on, and are drawn with instancing. |
| `src/worker.ts`, `src/world.ts` | Web Worker pool that generates textures and city regions, streams regions in and out around the player, and draws simplified distant regions. The texture set goes out as nine independent jobs and comes back in whatever order the pool finishes them. |
| `src/textures.ts` | Tileable procedural materials (value noise, fbm, height → normal maps): four concrete finishes with stains, plus asphalt and paving. Each layer draws on a stream of random numbers of its own, so the pool can build them all at once and still get the same set. The city shader adds weathering on top: streaks running down from the top of walls and dirt at their foot. |
| `src/shaders.ts` | Sky and cloud shadows; shadow-mapped sun (and moon: a disc with maria and a halo, over a hashed star field that comes out after dusk); procedural recessed windows and road markings with anti-aliased edges; wet reflections; street-lamp pools; canyon mist; ACES tone mapping, bloom, grain and speed blur. |
| `src/renderer.ts`, `src/gl.ts` | WebGL2 render passes, 4× MSAA HDR target, shadow map. |
| `src/player.ts` | Runner movement, box collision, stepping, ledge climbing, camera bob, roll and FOV kick. |
| `src/daylight.ts` | The clock and the sun. Real spherical astronomy at a fixed latitude and date puts the sun in the sky for a given hour, so it rises north of east, crosses high in the south and sets north of west, and the shadows swing round with it. A table keyed by sun elevation — not by the clock — gives the light and the sky for that moment, which means dawn and dusk come out of the same entries. Below −6° the moon takes over: always full, always opposite the sun, so it rises as the sun sets. |
| `src/weather.ts` | Eight mood states (clear sky, drifting cumulus, hard light, high haze, overcast, rain, fog, storm light) that blend smoothly. A state does not set the light — it tints and dims whatever the clock is giving, as a fraction of the sky's own brightness, so one `overcast` is a white glare at noon, a dull smear at sunset and a lid over a dark city at two in the morning. |
| `src/audio.ts` | Web Audio synthesis (including flyer engine and street rumble). |
| `src/music.ts` | The generative score, after early-90s London ambient techno: extended minor chords on swept, detuned pads, FM bells through a ping-pong echo and a long synthetic hall, a sub on the chord roots, a wandering band of noise, and a soft broken beat at 86 bpm that drifts in for a stretch of bars and away again. Chords come at random from a daylight set and a darker phrygian one, leaning dark as gloom and night come in. Scheduled a fraction of a second ahead on the audio clock. |
| `src/vehicles/metro.ts` | The subway timetable, and the ride. A train is a function of the clock like everything else that moves here, but this one stops: each cycle is a dwell at one station and a run to the next, the same cycle on every line, so asking which train belongs to a platform is one piece of arithmetic — and the worker that built the tunnel and the frame drawing it get the same answer. |
| `src/vehicles/traffic.ts` | Endless traffic streams: a vehicle's position is a function of its slot and time, so nothing is simulated. Cars drive the arterials, following each one's spline; flyers use air corridors over the same arterials at 48–122 m, above every bridge; trains run the elevated railways and boats the rivers. Drawn with GPU instancing. |
| `src/vehicles/car.ts` | Drivable car: arcade handling, box collision, kerb stepping. |
| `src/vehicles/parking.ts` | Vehicles standing still: flyers on pads, kerbside cars, and anything the player parked. |
| `src/rides.ts` | The player's side of vehicles: boarding, driving, flying, shooting and their cameras. |
| `src/hunters.ts` | Hunters: spawning as the pressure builds, the chase on foot (the demo's deck autopilot pointed at you over the bridges, direct pursuit otherwise), taking parked or passing vehicles, driving the street grid, flying the canyons and circling at a spot with a clear shot, shooting in bursts, your health. |
| `src/demo.ts` | Demo mode: autopilots for running (along lines probed clear on each deck, over the bridges), flying (street corridors between the traffic layers) and driving (timing avenue crossings against the traffic), and the director that cuts between them. |
| `src/touch.ts` | On-screen touch controls: floating stick, drag to look, hold and tap buttons. |
| `src/city/mapdata.ts`, `src/mapview.ts` | The map (M, or the `map` button): a plan of the city around you, drawn from the same network it is built on rather than from a second, simpler city — so the streets on it are the ground the blocks leave between them, exactly as they are underfoot. Block outlines are cut into 800 m tiles and worked out in the same worker pool that builds the city, always behind whatever it is streaming; the arterials, the railways over them and the rivers are the same splines the traffic, the trains and the boats run down, walked again on each redraw. The plan goes onto an off-screen canvas larger than the panel and is only redrawn when the zoom changes, a tile arrives, or you reach its margin, so keeping the map open costs nothing measurable. |
| `src/effects/combat.ts`, `src/effects/particles.ts` | Bolts (yours and the hunters'), hit tests, falling wrecks, and fire / smoke / spark particles. |
| `src/vehicles/flyer.ts` | The piloted flyer (hover physics, swept box collision, landing, finding a spot to step out) and the hangar of flyers waiting on landing pads. |
| `src/vehicles/models.ts` | Box models of cars, vans, flyers and the hunters on foot (three stride poses). |

## Development

```sh
npm test                      # headless tests: stairs, lifts, bridges, pylons and skyways, running lines, gap jumps, climbing, collisions, flying, clear traffic lanes, demo autopilots, hunters
npm run build && npx vite preview --port 4173
node scripts/shots.mjs out "clear sky,rain" deck,street   # screenshots via Chrome/Edge
node scripts/landing.mjs out/landing.png                  # title screen as a visitor sees it
node scripts/bench.mjs [--discrete] [--vsync] [--dpr=2]   # uncapped fps and per-pass GPU ms
node scripts/board-test.mjs out/board.png                 # boards, flies and lands with real key presses
node scripts/vehicles-test.mjs out                        # drives a car, then flies and shoots, in a real browser
node scripts/hunters-test.mjs out                         # hunters close up, shooting one, then waiting to be caught
node scripts/map-test.mjs out                             # opens the map, waits for its tiles, zooms through the levels
```

`python/` holds the first prototype (pygame + PyOpenGL), kept for reference.
