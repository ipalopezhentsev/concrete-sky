// Thin WebGL2 helpers: programs, meshes, textures and render targets.

export type GL = WebGL2RenderingContext;

export class Program {
  readonly id: WebGLProgram;
  private locs = new Map<string, WebGLUniformLocation | null>();

  constructor(private gl: GL, vs: string, fs: string) {
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const numbered = src.split("\n").map((l, i) => `${String(i + 1).padStart(4)} ${l}`).join("\n");
        throw new Error(`shader compile failed:\n${gl.getShaderInfoLog(s)}\n${numbered}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(p)}`);
    this.id = p;
  }

  use(): this {
    this.gl.useProgram(this.id);
    return this;
  }

  private loc(name: string): WebGLUniformLocation | null {
    let l = this.locs.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.id, name);
      this.locs.set(name, l);
    }
    return l;
  }

  int(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
    return this;
  }

  float(name: string, v: number): this {
    const l = this.loc(name);
    if (l) this.gl.uniform1f(l, v);
    return this;
  }

  vec(name: string, v: ArrayLike<number>): this {
    const l = this.loc(name);
    if (!l) return this;
    if (v.length === 2) this.gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) this.gl.uniform3f(l, v[0], v[1], v[2]);
    else this.gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    return this;
  }

  mat4(name: string, m: Float32Array): this {
    const l = this.loc(name);
    if (l) this.gl.uniformMatrix4fv(l, false, m);
    return this;
  }

  /** Scalars become floats, arrays become vecs. */
  setAll(values: Record<string, number | ArrayLike<number>>): this {
    for (const [k, v] of Object.entries(values)) {
      if (typeof v === "number") this.float(k, v);
      else this.vec(k, v);
    }
    return this;
  }
}

export class Mesh {
  readonly vao: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  count: number;
  indexed: boolean;

  constructor(
    private gl: GL,
    vertices: Float32Array,
    layout: number[],
    indices: Uint32Array | null = null,
    readonly mode: number = gl.TRIANGLES,
  ) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.buffers.push(vbo);
    const stride = layout.reduce((a, b) => a + b, 0);
    let offset = 0;
    layout.forEach((size, loc) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      offset += size;
    });
    this.indexed = indices !== null;
    if (indices) {
      const ebo = gl.createBuffer()!;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
      this.buffers.push(ebo);
      this.count = indices.length;
    } else {
      this.count = vertices.length / stride;
    }
    gl.bindVertexArray(null);
    Mesh.bound = null;
  }

  draw(count = this.count): void {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    Mesh.bound = this;
    if (this.indexed) gl.drawElements(this.mode, count, gl.UNSIGNED_INT, 0);
    else gl.drawArrays(this.mode, 0, count);
  }

  /**
   * Draw many parts of the index buffer (starts in indices) in one call when
   * WEBGL_multi_draw is available, otherwise one call per part.
   */
  drawRanges(starts: Int32Array, counts: Int32Array, n: number): void {
    if (n <= 0) return;
    const gl = this.gl;
    if (Mesh.bound !== this) {
      gl.bindVertexArray(this.vao);
      Mesh.bound = this;
    }
    const multi = Mesh.multiDraw(gl);
    if (!multi) {
      for (let i = 0; i < n; i++) gl.drawElements(this.mode, counts[i], gl.UNSIGNED_INT, starts[i] * 4);
      return;
    }
    for (let i = 0; i < n; i++) starts[i] *= 4; // byte offsets
    multi.multiDrawElementsWEBGL(this.mode, counts, 0, gl.UNSIGNED_INT, starts, 0, n);
  }

  static bound: Mesh | null = null;

  private static multi: WEBGL_multi_draw | null | undefined;
  private static multiDraw(gl: GL): WEBGL_multi_draw | null {
    if (Mesh.multi === undefined) Mesh.multi = new URLSearchParams(location.search).get("multidraw") === "0" ? null : gl.getExtension("WEBGL_multi_draw");
    return Mesh.multi;
  }

  dispose(): void {
    if (Mesh.bound === this) Mesh.bound = null;
    for (const b of this.buffers) this.gl.deleteBuffer(b);
    this.gl.deleteVertexArray(this.vao);
  }
}

/** A mesh drawn many times with per-instance attributes (divisor 1) from a dynamic buffer. */
export class InstancedMesh {
  readonly vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ebo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private capacity = 0;
  private stride: number;
  readonly indexCount: number;

  constructor(private gl: GL, vertices: Float32Array, layout: number[], indices: Uint32Array, instanceLayout: number[]) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    const stride = layout.reduce((a, b) => a + b, 0);
    let offset = 0;
    layout.forEach((size, loc) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, offset * 4);
      offset += size;
    });
    this.ebo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexCount = indices.length;

    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibo);
    this.stride = instanceLayout.reduce((a, b) => a + b, 0);
    offset = 0;
    instanceLayout.forEach((size, i) => {
      const loc = layout.length + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, this.stride * 4, offset * 4);
      gl.vertexAttribDivisor(loc, 1);
      offset += size;
    });
    gl.bindVertexArray(null);
    Mesh.bound = null;
  }

  draw(data: Float32Array, count: number): void {
    if (count <= 0) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    Mesh.bound = null;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ibo);
    const bytes = count * this.stride * 4;
    if (bytes > this.capacity) {
      this.capacity = Math.max(bytes, this.capacity * 2);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * this.stride);
    gl.drawElementsInstanced(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0, count);
  }
}

export function fullscreenTriangle(gl: GL): Mesh {
  return new Mesh(gl, new Float32Array([-1, -1, 3, -1, -1, 3]), [2]);
}

export function texture2D(gl: GL, size: number, data: Uint8Array, opts: { mipmaps?: boolean } = {}): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (opts.mipmaps) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  return tex;
}

export function textureArray(gl: GL, size: number, layers: number, data: Uint8Array, srgb: boolean): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  const levels = Math.floor(Math.log2(size)) + 1;
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, levels, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, size, size, layers);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, size, size, layers, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  if (aniso) {
    const max = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
    gl.texParameterf(gl.TEXTURE_2D_ARRAY, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
  }
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  return tex;
}

function checkFramebuffer(gl: GL, what: string): void {
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`${what} framebuffer incomplete: 0x${status.toString(16)}`);
}

/**
 * HDR scene target. Renders into a multisampled buffer, resolves into a float
 * texture, and keeps a half-resolution mipmapped copy as the bloom source.
 */
export class SceneTarget {
  readonly msFbo: WebGLFramebuffer | null = null;
  readonly fbo: WebGLFramebuffer;
  readonly color: WebGLTexture;
  readonly bloom: WebGLTexture;
  private bloomFbo: WebGLFramebuffer;
  private renderbuffers: WebGLRenderbuffer[] = [];
  readonly bloomWidth: number;
  readonly bloomHeight: number;

  constructor(private gl: GL, readonly width: number, readonly height: number, readonly samples: number) {
    const fmt = gl.RGBA16F;
    const makeTex = (w: number, h: number, levels: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, levels, fmt, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.color = makeTex(width, height, 1);
    this.bloomWidth = Math.max(1, width >> 1);
    this.bloomHeight = Math.max(1, height >> 1);
    this.bloom = makeTex(this.bloomWidth, this.bloomHeight, Math.floor(Math.log2(Math.max(this.bloomWidth, this.bloomHeight))) + 1);

    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
    this.bloomFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloomFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bloom, 0);
    checkFramebuffer(gl, "bloom");

    const depthBuffer = (multisample: boolean) => {
      const d = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, d);
      if (multisample) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT32F, width, height);
      else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d);
      this.renderbuffers.push(d);
    };
    if (samples > 1) {
      this.msFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
      const c = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, c);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c);
      this.renderbuffers.push(c);
      depthBuffer(true);
      checkFramebuffer(gl, "multisample");
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      depthBuffer(false);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    checkFramebuffer(gl, "scene");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.msFbo ?? this.fbo);
    this.gl.viewport(0, 0, this.width, this.height);
  }

  /** Resolve MSAA samples, then refresh the half-resolution bloom chain. */
  resolve(): void {
    const gl = this.gl;
    if (this.msFbo) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.fbo);
      gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.width, this.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.bloomFbo);
    gl.blitFramebuffer(0, 0, this.width, this.height, 0, 0, this.bloomWidth, this.bloomHeight, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, this.bloom);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.color);
    gl.deleteTexture(this.bloom);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteFramebuffer(this.bloomFbo);
    if (this.msFbo) gl.deleteFramebuffer(this.msFbo);
    for (const r of this.renderbuffers) gl.deleteRenderbuffer(r);
  }
}

/** Small colour target (used for the cloud shadow map). */
export class ColorTarget {
  readonly fbo: WebGLFramebuffer;
  readonly tex: WebGLTexture;

  constructor(private gl: GL, readonly size: number) {
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    checkFramebuffer(gl, "color");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.size, this.size);
  }
}

export class ShadowTarget {
  readonly fbo: WebGLFramebuffer;
  readonly depth: WebGLTexture;

  constructor(private gl: GL, readonly size: number) {
    this.depth = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.depth);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    checkFramebuffer(gl, "shadow");
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind(): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
    this.gl.viewport(0, 0, this.size, this.size);
  }
}

export function bindTexture(gl: GL, unit: number, tex: WebGLTexture, target: number = gl.TEXTURE_2D): void {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, tex);
}
