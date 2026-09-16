// Box -> triangle mesh conversion shared by the city and vehicle models.

// Each face: 4 corners (0 = min, 1 = max per axis) CCW from outside starting
// bottom-left, the normal, and which extents give (width, height).
export const FACES: { corners: number[][]; normal: number[]; wh: [number, number] }[] = [
  { corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], normal: [1, 0, 0], wh: [2, 1] },
  { corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], normal: [-1, 0, 0], wh: [2, 1] },
  { corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], normal: [0, 0, 1], wh: [0, 1] },
  { corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], normal: [0, 0, -1], wh: [0, 1] },
  { corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], normal: [0, 1, 0], wh: [0, 2] },
  { corners: [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]], normal: [0, -1, 0], wh: [0, 2] },
];
export const CORNER_UV = [[0, 0], [1, 0], [1, 1], [0, 1]];

// pos3 normal3 uv2 size2 tint3 info3 (material, style, seed)
export const VERTEX_LAYOUT = [3, 3, 2, 2, 3, 3];
export const FLOATS_PER_VERTEX = 16;

/** Writes one box (12 floats: x0 y0 z0 x1 y1 z1 r g b mat style seed) into the buffers. */
export function emitBox(
  d: ArrayLike<number>, o: number, vertices: Float32Array, v: number, indices: Uint32Array, idx: number,
  baseVertex: number, skipBottom: boolean,
): { v: number; idx: number } {
  const x0 = d[o], y0 = d[o + 1], z0 = d[o + 2];
  const ex = d[o + 3] - x0, ey = d[o + 4] - y0, ez = d[o + 5] - z0;
  const ext = [ex, ey, ez];
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const w = ext[face.wh[0]], h = ext[face.wh[1]];
    for (let c = 0; c < 4; c++) {
      const sel = face.corners[c];
      vertices[v++] = x0 + sel[0] * ex;
      vertices[v++] = y0 + sel[1] * ey;
      vertices[v++] = z0 + sel[2] * ez;
      vertices[v++] = face.normal[0];
      vertices[v++] = face.normal[1];
      vertices[v++] = face.normal[2];
      vertices[v++] = CORNER_UV[c][0] * w;
      vertices[v++] = CORNER_UV[c][1] * h;
      vertices[v++] = w;
      vertices[v++] = h;
      for (let k = 6; k < 12; k++) vertices[v++] = d[o + k];
    }
    if (f === 5 && skipBottom) continue;
    const base = baseVertex + f * 4;
    indices[idx++] = base;
    indices[idx++] = base + 1;
    indices[idx++] = base + 2;
    indices[idx++] = base;
    indices[idx++] = base + 2;
    indices[idx++] = base + 3;
  }
  return { v, idx };
}

/** Mesh for a small list of boxes (12 floats each). */
export function boxesMesh(boxes: number[]): { vertices: Float32Array; indices: Uint32Array } {
  const n = boxes.length / 12;
  const vertices = new Float32Array(n * 24 * FLOATS_PER_VERTEX);
  const indices = new Uint32Array(n * 36);
  let v = 0, idx = 0;
  for (let i = 0; i < n; i++) ({ v, idx } = emitBox(boxes, i * 12, vertices, v, indices, idx, i * 24, false));
  return { vertices, indices: indices.slice(0, idx) };
}
