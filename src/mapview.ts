// The map: a plan of the city around the runner, drawn from the network it is built on.
//
// Nothing here is a second, simplified city. The streets on the map are the ground the blocks
// leave between them, which is literally how the streets on the ground come about, so a lane
// that looks like a dead end on the map is one — and the arterials, the railways over them
// and the rivers are the same splines the traffic, the trains and the boats run down.
//
// Drawing is split in two so that having the map open costs almost nothing. The plan itself
// goes onto an off-screen canvas a good margin larger than the panel, and is redrawn only
// when the zoom changes, a tile arrives, or the runner walks far enough to reach the margin.
// Every frame does one blit of that, plus the marker and the furniture on top.

import { arterialRoutes, MAP_REACH, MAP_TILE, riverRoutes } from "./city/mapdata";
import { ARTERY_HALF, RIVER_HALF } from "./city/network";
import type { World } from "./world";

/** How wide a view of the city the panel shows, in metres. */
const ZOOMS = [500, 1000, 2000, 4000];
/** How far past the panel the off-screen plan reaches, in CSS pixels. */
const MARGIN = 110;
/** Width of a railway deck, which rides over the arterial it follows. */
const RAIL_WIDE = 10.4;

const INK = {
  paving: "#5b626b", // the ground between the blocks, which is to say the streets
  block: "#21242a",
  artery: "#848d98",
  rail: "#c8a05a",
  water: "#2d5673",
  you: "#f2efe9",
};

export class MapView {
  open = false;
  private zoom = 1;
  private ctx: CanvasRenderingContext2D;
  private plan = document.createElement("canvas");
  private planCtx = this.plan.getContext("2d")!;
  /** Where the off-screen plan is centred, and what it was drawn from. */
  private planAt: [number, number] = [NaN, NaN];
  private planZoom = -1;
  private planVersion = -1;
  private planSize = 0;
  private waiting = 0;

  constructor(private canvas: HTMLCanvasElement, private world: World) {
    this.ctx = canvas.getContext("2d")!;
  }

  /** Metres across the panel at the current zoom. */
  get across(): number {
    return ZOOMS[this.zoom];
  }

  /** Tiles of the view still being worked out. Zero once the plan on screen is complete. */
  get pending(): number {
    return this.waiting;
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.canvas.parentElement!.hidden = !on;
    if (on) this.planZoom = -1; // redraw from scratch: the tiles may have been evicted
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  /** One step in (`-1`) or out (`+1`). */
  zoomBy(step: number): void {
    const z = Math.max(0, Math.min(ZOOMS.length - 1, this.zoom + step));
    if (z !== this.zoom) {
      this.zoom = z;
      this.planZoom = -1;
    }
  }

  /**
   * Draw the map centred on (x, z), with the runner facing `yaw`.
   *
   * Cheap to call every frame: it works out whether the plan underneath is still good for
   * where the runner is standing and only redraws it when it is not.
   */
  draw(x: number, z: number, yaw: number): void {
    const side = this.canvas.clientWidth;
    if (!this.open || side < 8) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(side * dpr)) {
      this.canvas.width = this.canvas.height = Math.round(side * dpr);
      this.planZoom = -1;
    }
    const scale = side / this.across; // CSS pixels per metre

    this.ensurePlan(x, z, side, scale, dpr);

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, side, side);
    // the plan, shifted by however far the runner has walked since it was drawn
    const ox = (x - this.planAt[0]) * scale, oz = (z - this.planAt[1]) * scale;
    ctx.drawImage(this.plan, -MARGIN - ox, -MARGIN - oz, this.planSize, this.planSize);

    this.marker(ctx, side / 2, side / 2, yaw, scale);
    this.furniture(ctx, side, scale);
  }

  /** Redraw the off-screen plan if the panel has outgrown it, or what it holds has changed. */
  private ensurePlan(x: number, z: number, side: number, scale: number, dpr: number): void {
    const size = side + MARGIN * 2;
    const moved = Math.max(Math.abs(x - this.planAt[0]), Math.abs(z - this.planAt[1])) * scale;
    if (this.planZoom === this.zoom && this.planVersion === this.world.mapVersion &&
        this.planSize === size && moved < MARGIN - 1) return;
    if (this.plan.width !== Math.round(size * dpr)) this.plan.width = this.plan.height = Math.round(size * dpr);
    this.planSize = size;
    this.planZoom = this.zoom;
    this.planVersion = this.world.mapVersion;
    this.planAt = [x, z];

    const ctx = this.planCtx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // world -> plan pixels: the centre of the plan is the point it was drawn around
    const half = size / 2;
    const px = (wx: number) => (wx - x) * scale + half;
    const pz = (wz: number) => (wz - z) * scale + half;
    const reach = (half / scale) + MAP_REACH; // metres from the centre the plan has to cover

    ctx.fillStyle = INK.paving;
    ctx.fillRect(0, 0, size, size);

    // The blocks, painted over the paving: what is left showing is the street network, kerb
    // to kerb, because that is exactly how each block was pulled back off its own edges.
    const tiles = this.tilesFor(x, z, reach);
    ctx.fillStyle = INK.block;
    ctx.beginPath();
    for (const t of tiles) {
      let i = 0;
      while (i < t.length) {
        const n = t[i++];
        ctx.moveTo(px(t[i]), pz(t[i + 1]));
        for (let k = 1; k < n; k++) ctx.lineTo(px(t[i + k * 2]), pz(t[i + k * 2 + 1]));
        ctx.closePath();
        i += n * 2;
      }
    }
    ctx.fill();

    // `dashed` marks the railways out from the roads they ride over. The dash is measured in
    // line widths rather than pixels, so it reads as sleepers at every zoom instead of
    // closing up into a solid stripe when the line is drawn fat.
    const stroke = (pts: Float32Array, width: number, colour: string, dashed = false) => {
      const w = Math.max(1, width * scale);
      ctx.strokeStyle = colour;
      ctx.lineWidth = w;
      // a round cap on a dash eats a whole line width out of the gap either side of it
      ctx.lineCap = dashed ? "butt" : "round";
      ctx.lineJoin = "round";
      ctx.setLineDash(dashed ? [w * 1.9, w * 1.3] : []);
      ctx.beginPath();
      ctx.moveTo(px(pts[0]), pz(pts[1]));
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(px(pts[i]), pz(pts[i + 1]));
      ctx.stroke();
      ctx.setLineDash([]);
    };

    // The rivers, laid over everything the blocks left: the channel is cut out of the ground,
    // so the water really does run under the bridges rather than stopping either side of them.
    for (const pts of riverRoutes(x, z, reach)) stroke(pts, RIVER_HALF * 2, INK.water);

    // The arterials. They already show as the widest gaps between the blocks; drawn again in
    // their own colour they read as the through-routes they are instead of as more street.
    const arteries = arterialRoutes(x, z, reach);
    for (const a of arteries) stroke(a.pts, ARTERY_HALF * 2, INK.artery);
    // and the elevated railways, which are carried above those same roads
    for (const a of arteries) if (a.rail) stroke(a.pts, RAIL_WIDE, INK.rail, true);
  }

  /** Tiles covering a square of `reach` metres either side of the runner, nearest first. */
  private tilesFor(x: number, z: number, reach: number): Float32Array[] {
    const t0x = Math.floor((x - reach) / MAP_TILE), t1x = Math.floor((x + reach) / MAP_TILE);
    const t0z = Math.floor((z - reach) / MAP_TILE), t1z = Math.floor((z + reach) / MAP_TILE);
    const want: [number, number, number][] = [];
    for (let tx = t0x; tx <= t1x; tx++)
      for (let tz = t0z; tz <= t1z; tz++) {
        const dx = (tx + 0.5) * MAP_TILE - x, dz = (tz + 0.5) * MAP_TILE - z;
        want.push([dx * dx + dz * dz, tx, tz]);
      }
    want.sort((a, b) => a[0] - b[0]);
    const tiles = this.world.mapTiles(want.map(([, tx, tz]) => [tx, tz] as [number, number]));
    this.waiting = want.length - tiles.length;
    return tiles;
  }

  /** The runner: an arrow the way they are facing, with the cone of what they can see. */
  private marker(ctx: CanvasRenderingContext2D, cx: number, cy: number, yaw: number, scale: number): void {
    ctx.save();
    ctx.translate(cx, cy);
    // screen up is -z, and the runner's forward is (sin yaw, cos yaw) in the world
    ctx.rotate(Math.PI - yaw);
    const cone = Math.min(120, Math.max(34, 150 * scale));
    ctx.fillStyle = "rgba(242, 239, 233, 0.16)";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, cone, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = INK.you;
    ctx.strokeStyle = "rgba(12, 13, 15, 0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** North, a scale bar, and a word while the plan is still coming in. */
  private furniture(ctx: CanvasRenderingContext2D, side: number, scale: number): void {
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.textBaseline = "alphabetic";

    // north, which is -z, the way the map is drawn
    ctx.save();
    ctx.translate(side - 24, 26);
    ctx.fillStyle = "rgba(242, 239, 233, 0.7)";
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(4.5, 4);
    ctx.lineTo(0, 1.5);
    ctx.lineTo(-4.5, 4);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillText("N", 0, 17);
    ctx.restore();

    // a round number of metres, as near a quarter of the panel as one comes
    const nice = [50, 100, 200, 500, 1000, 2000];
    const target = this.across / 4;
    const metres = nice.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
    const bar = metres * scale;
    const y = side - 16, x0 = 16;
    ctx.strokeStyle = "rgba(242, 239, 233, 0.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y - 4);
    ctx.lineTo(x0, y);
    ctx.lineTo(x0 + bar, y);
    ctx.lineTo(x0 + bar, y - 4);
    ctx.stroke();
    ctx.fillStyle = "rgba(242, 239, 233, 0.75)";
    ctx.textAlign = "left";
    ctx.fillText(`${metres} m`, x0, y - 10);

    // above the scale bar: the bottom right corner belongs to the zoom buttons
    if (this.waiting > 0) {
      ctx.fillStyle = "rgba(242, 239, 233, 0.55)";
      ctx.fillText("surveying…", x0, y - 28);
    }
  }
}
