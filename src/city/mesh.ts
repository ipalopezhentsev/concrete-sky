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

// pos3 face1 uv2 size2 tint1 info2 — 44 bytes a vertex rather than 64. The vertex shader
// turns the face index into a normal, unpacks the tint from one float and splits material
// and style apart again; at these triangle counts the fetch costs more than the unpacking.
export const VERTEX_LAYOUT = [3, 1, 2, 2, 1, 2];
export const FLOATS_PER_VERTEX = 11;

/**
 * Writes one box (12 floats: x0 y0 z0 x1 y1 z1 r g b mat style seed) into the buffers.
 * `skipFaces` is a bitmask of faces to leave out of the index buffer, for faces that are
 * buried inside another box. Their vertices are still written but never referenced, so
 * they cost nothing to draw.
 */
export function emitBox(
  d: ArrayLike<number>, o: number, vertices: Float32Array, v: number, indices: Uint32Array, idx: number,
  baseVertex: number, skipFaces: number,
): { v: number; idx: number } {
  const x0 = d[o], y0 = d[o + 1], z0 = d[o + 2];
  const ex = d[o + 3] - x0, ey = d[o + 4] - y0, ez = d[o + 5] - z0;
  const ext = [ex, ey, ez];
  // 8 bits per channel packed into one float: exact up to 2^24, so it survives the round trip
  const u8 = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const tint = u8(d[o + 6]) * 65536 + u8(d[o + 7]) * 256 + u8(d[o + 8]);
  const matStyle = d[o + 9] + d[o + 10] * 64;
  const seed = d[o + 11];
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const w = ext[face.wh[0]], h = ext[face.wh[1]];
    for (let c = 0; c < 4; c++) {
      const sel = face.corners[c];
      vertices[v++] = x0 + sel[0] * ex;
      vertices[v++] = y0 + sel[1] * ey;
      vertices[v++] = z0 + sel[2] * ez;
      vertices[v++] = f;
      vertices[v++] = CORNER_UV[c][0] * w;
      vertices[v++] = CORNER_UV[c][1] * h;
      vertices[v++] = w;
      vertices[v++] = h;
      vertices[v++] = tint;
      vertices[v++] = matStyle;
      vertices[v++] = seed;
    }
    if (skipFaces & (1 << f)) continue;
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
  for (let i = 0; i < n; i++) ({ v, idx } = emitBox(boxes, i * 12, vertices, v, indices, idx, i * 24, 0));
  return { vertices, indices: indices.slice(0, idx) };
}

/** Just the positions of a vertex buffer, for the depth-only passes. */
export function positionsOf(vertices: Float32Array, floats: number): Float32Array {
  const count = floats / FLOATS_PER_VERTEX;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = i * FLOATS_PER_VERTEX, t = i * 3;
    out[t] = vertices[s];
    out[t + 1] = vertices[s + 1];
    out[t + 2] = vertices[s + 2];
  }
  return out;
}
