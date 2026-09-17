// GPU pass timing via EXT_disjoint_timer_query_webgl2 (when the browser exposes it).

import type { GL } from "./gl";

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

export class GpuTimer {
  private ext: TimerExt | null;
  private pending: { name: string; q: WebGLQuery }[] = [];
  private free: WebGLQuery[] = [];
  private active: { name: string; q: WebGLQuery } | null = null;
  readonly avg = new Map<string, number>();

  constructor(private gl: GL) {
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
  }

  get available(): boolean {
    return this.ext !== null;
  }

  begin(name: string): void {
    if (!this.ext) return;
    this.end();
    const q = this.free.pop() ?? this.gl.createQuery()!;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = { name, q };
  }

  end(): void {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }

  /** Averaged GPU time of all passes, in ms; 0 when timers are unavailable. */
  get total(): number {
    let sum = 0;
    for (const v of this.avg.values()) sum += v;
    return sum;
  }

  /** Collect finished queries; call once per frame. */
  poll(): void {
    if (!this.ext) return;
    const gl = this.gl;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    while (this.pending.length) {
      const { name, q } = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      this.free.push(q);
      if (disjoint) continue;
      const prev = this.avg.get(name);
      this.avg.set(name, prev === undefined ? ms : prev + (ms - prev) * 0.05);
    }
  }

  summary(): string {
    if (!this.ext) return "gpu timers unavailable";
    return [...this.avg].map(([k, v]) => `${k} ${v.toFixed(2)}`).join("  ");
  }
}
