// Background generation of textures, city regions and map tiles.

import { mapRailStations, mapStations, mapTile } from "./city/mapdata";
import { buildPlanRegion } from "./city/plan";
import { setWorldSeed } from "./math";
import { generateLayer, generateNoise } from "./textures";

export type WorkerRequest =
  | { type: "noise"; seed: number }
  | { type: "layer"; layer: number; seed: number }
  | { type: "region"; rx: number; rz: number; seed: number; faceCull: boolean }
  | { type: "map"; tx: number; tz: number; seed: number };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "noise") {
    const noise = generateNoise(msg.seed);
    postMessage({ type: "noise", noise }, { transfer: [noise.buffer] });
  } else if (msg.type === "layer") {
    const l = generateLayer(msg.seed, msg.layer);
    postMessage({ type: "layer", layer: msg.layer, ...l }, { transfer: [l.albedo.buffer, l.normal.buffer] });
  } else if (msg.type === "map") {
    setWorldSeed(msg.seed);
    const blocks = mapTile(msg.tx, msg.tz);
    const stations = mapStations(msg.tx, msg.tz);
    const railStations = mapRailStations(msg.tx, msg.tz);
    postMessage({ type: "map", tx: msg.tx, tz: msg.tz, blocks, stations, railStations },
      { transfer: [blocks.buffer, stations.buffer, railStations.buffer] });
  } else {
    setWorldSeed(msg.seed);
    const m = buildPlanRegion(msg.rx, msg.rz, msg.faceCull);
    const transfer: ArrayBuffer[] = [m.vertices.buffer as ArrayBuffer, m.positions.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer];
    for (const c of m.colliders) transfer.push(c.boxes.buffer as ArrayBuffer);
    postMessage({ type: "region", mesh: m }, { transfer });
  }
};
