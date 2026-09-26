// Background generation of textures, city regions and map tiles.

import { mapTile } from "./city/mapdata";
import { buildPlanRegion } from "./city/plan";
import { setWorldSeed } from "./math";
import { generateTextures } from "./textures";

export type WorkerRequest =
  | { type: "textures"; seed: number }
  | { type: "region"; rx: number; rz: number; seed: number; faceCull: boolean }
  | { type: "map"; tx: number; tz: number; seed: number };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "textures") {
    const t = generateTextures(msg.seed);
    postMessage({ type: "textures", ...t }, { transfer: [t.albedo.buffer, t.normal.buffer, t.noise.buffer] });
  } else if (msg.type === "map") {
    setWorldSeed(msg.seed);
    const blocks = mapTile(msg.tx, msg.tz);
    postMessage({ type: "map", tx: msg.tx, tz: msg.tz, blocks }, { transfer: [blocks.buffer] });
  } else {
    setWorldSeed(msg.seed);
    const m = buildPlanRegion(msg.rx, msg.rz, msg.faceCull);
    const transfer: ArrayBuffer[] = [m.vertices.buffer as ArrayBuffer, m.positions.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer];
    for (const c of m.colliders) transfer.push(c.boxes.buffer as ArrayBuffer);
    postMessage({ type: "region", mesh: m }, { transfer });
  }
};
