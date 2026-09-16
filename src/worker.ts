// Background generation of textures and city regions.

import { buildRegion } from "./city/generate";
import { setWorldSeed } from "./math";
import { generateTextures } from "./textures";

export type WorkerRequest = { type: "textures"; seed: number } | { type: "region"; rx: number; rz: number; seed: number };

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "textures") {
    const t = generateTextures(msg.seed);
    postMessage({ type: "textures", ...t }, { transfer: [t.albedo.buffer, t.normal.buffer, t.noise.buffer] });
  } else {
    setWorldSeed(msg.seed);
    const m = buildRegion(msg.rx, msg.rz);
    const transfer: ArrayBuffer[] = [m.vertices.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer];
    for (const c of m.colliders) transfer.push(c.boxes.buffer as ArrayBuffer);
    postMessage({ type: "region", mesh: m }, { transfer });
  }
};
