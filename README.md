# Concrete Sky

A moody, experimental first-person run through an endless brutalist city,
playable in the browser. You run across podium decks, climb stairs onto
rooftops, and cross bridges between towers while the sky changes above you.
Cars stream along the avenues and flyers cross the air above the streets.
Take a parked flyer from a landing pad, fly to another roof and step out,
shoot other flyers out of the sky, or take a car and drive. Hunters come after
you on foot, in cars and in flyers, and there's nothing to do but stay ahead
of them (or turn them off with H).

Everything is generated in code, with no image or sound files:
- the city
- the textures: board-formed and precast concrete, asphalt, paving
- the clouds and the weather
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
| E | get into a parked car, a passing car or a parked flyer / step out |
| left mouse / F | shoot (on foot while the hunters are on, and in a flyer) |
| V | chase camera or cockpit view (in a vehicle) |
| R | return to the last roof you stood on |
| H | hunters on / off |
| N | skip to the next weather |
| L | hold the current weather / let it drift again |
| F3 | stats (fps, GPU, position) |
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
an autopilot. It flies the air corridors and shoots at passing flyers, runs
along the podium decks and over their bridges, then drives a cross street,
giving way to avenue traffic. Each scene brings in the next weather. There are
no hunters in the demo. It also starts by itself after 45 seconds on the first
title screen. Click, tap or press a key to take over wherever it is, including
the vehicle it is in. Esc goes back to the title screen.

Every visit generates a new city. Its number is shown on the title screen and
in F3, and `?seed=12345` brings a particular city back.

URL options: `?seed=12345`, `?demo` (start in the demo) / `?demo=0` (never start it by itself), `?hunters=0` (no hunters), `?weather=golden%20hour`, `?vehicle=1` / `?vehicle=car` (start in a vehicle), `?scale=0.7` (internal resolution),
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

On an Intel UHD 770 at 1920×1080 this runs at roughly 80–85 fps uncapped;
an RTX 3060 Laptop GPU runs it at roughly 500+ fps.

Requires WebGL2 with `EXT_color_buffer_float`, which every current desktop
browser has. When `EXT_clip_control` is available, the game uses it for
reversed-Z depth.

## How it works

| file | |
|---|---|
| `src/city/generate.ts` | Deterministic city on an 88 m grid. Streets are canyons; each block is a raised podium (18, 24 or 30 m) linked to its neighbours by bridges, which become stepped bridges when the heights differ. On top of the podiums sit skyscrapers with setbacks and open sky lobbies, mid-rise towers with stairs wrapping around the outside up to their roofs, terraces, and parkour pillars. Switchback stair towers climb up from the street. The city is made only of boxes, meshed in batches of 3×3 blocks. |
| `src/worker.ts`, `src/world.ts` | Web Worker pool that generates textures and city regions, streams regions in and out around the player, and draws simplified distant regions. |
| `src/textures.ts` | Tileable procedural materials (value noise, fbm, height → normal maps). |
| `src/shaders.ts` | Sky and cloud shadows; shadow-mapped sun; procedural recessed windows and road markings with anti-aliased edges; wet reflections; street-lamp pools; canyon mist; ACES tone mapping, bloom, grain and speed blur. |
| `src/renderer.ts`, `src/gl.ts` | WebGL2 render passes, 4× MSAA HDR target, shadow map. |
| `src/player.ts` | Runner movement, box collision, stepping, ledge climbing, camera bob, roll and FOV kick. |
| `src/weather.ts` | Nine mood states (clear sky, drifting cumulus, white noon, overcast, rain, fog, golden hour, storm light, blue hour) that blend smoothly. |
| `src/audio.ts` | Web Audio synthesis (including flyer engine and street rumble). |
| `src/vehicles/traffic.ts` | Endless traffic streams: a vehicle's position is a function of its slot and time, so nothing is simulated. Cars run on the north-south avenues and both elevated expressways (east-west streets hold parked cars, so no traffic crosses); flyers use air corridors above the streets at 48–122 m, above every bridge. Drawn with GPU instancing. |
| `src/vehicles/car.ts` | Drivable car: arcade handling, box collision, kerb stepping. |
| `src/vehicles/parking.ts` | Vehicles standing still: flyers on pads, kerbside cars, and anything the player parked. |
| `src/rides.ts` | The player's side of vehicles: boarding, driving, flying, shooting and their cameras. |
| `src/hunters.ts` | Hunters: spawning as the pressure builds, the chase on foot (the demo's deck autopilot pointed at you over the bridges, direct pursuit otherwise), taking parked or passing vehicles, driving the street grid, flying the canyons and circling at a spot with a clear shot, shooting in bursts, your health. |
| `src/demo.ts` | Demo mode: autopilots for running (along lines probed clear on each deck, over the bridges), flying (street corridors between the traffic layers) and driving (timing avenue crossings against the traffic), and the director that cuts between them. |
| `src/touch.ts` | On-screen touch controls: floating stick, drag to look, hold and tap buttons. |
| `src/effects/combat.ts`, `src/effects/particles.ts` | Bolts (yours and the hunters'), hit tests, falling wrecks, and fire / smoke / spark particles. |
| `src/vehicles/flyer.ts` | The piloted flyer (hover physics, swept box collision, landing, finding a spot to step out) and the hangar of flyers waiting on landing pads. |
| `src/vehicles/models.ts` | Box models of cars, vans, flyers and the hunters on foot (three stride poses). |

## Development

```sh
npm test                      # headless tests: stairs, bridges, climbing, collisions, flying, clear traffic lanes, demo autopilots, hunters
npm run build && npx vite preview --port 4173
node scripts/shots.mjs out "clear sky,rain" deck,street   # screenshots via Chrome/Edge
node scripts/landing.mjs out/landing.png                  # title screen as a visitor sees it
node scripts/bench.mjs [--discrete] [--vsync] [--dpr=2]   # uncapped fps and per-pass GPU ms
node scripts/board-test.mjs out/board.png                 # boards, flies and lands with real key presses
node scripts/vehicles-test.mjs out                        # drives a car, then flies and shoots, in a real browser
node scripts/hunters-test.mjs out                         # hunters close up, shooting one, then waiting to be caught
```

`python/` holds the first prototype (pygame + PyOpenGL), kept for reference.
