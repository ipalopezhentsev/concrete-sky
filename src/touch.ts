// On-screen controls for phones and tablets: a floating stick under the left
// thumb, drag to look with the right, and buttons for the rest.

const STICK_RADIUS = 56; // px
const LOOK_GAIN = 2.2; // touch pixels -> mouse pixels

export type TouchMode = "foot" | "car" | "flyer";

const JUMP_LABEL: Record<TouchMode, string> = { foot: "jump", car: "brake", flyer: "up" };

export class TouchControls {
  /** Stick direction, +x right, +z forward, length = deflection (0..1). */
  moveX = 0;
  moveZ = 0;
  stick = 0;
  /** Look movement since the last frame, in mouse pixels. */
  lookDX = 0;
  lookDY = 0;
  readonly held = new Set<string>();
  private stickId = -1;
  private origin = [0, 0];
  private lookId = -1;
  private lookLast = [0, 0];
  private mode: TouchMode | null = null;
  private shownAt = 0;
  private readonly base: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly jump: HTMLElement;

  constructor(private root: HTMLElement, onTap: (action: string) => void) {
    this.base = root.querySelector(".stick")!;
    this.knob = root.querySelector(".knob")!;
    this.jump = root.querySelector('[data-hold="jump"]')!;

    root.addEventListener("pointerdown", (e) => this.down(e));
    root.addEventListener("pointermove", (e) => this.move(e));
    for (const type of ["pointerup", "pointercancel"]) root.addEventListener(type, (e) => this.up(e as PointerEvent));
    root.addEventListener("contextmenu", (e) => e.preventDefault());

    for (const b of root.querySelectorAll<HTMLElement>("[data-hold]")) {
      const name = b.dataset.hold!;
      b.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        b.setPointerCapture(e.pointerId);
        this.held.add(name);
        b.classList.add("on");
      });
      const release = () => {
        this.held.delete(name);
        b.classList.remove("on");
      };
      b.addEventListener("pointerup", release);
      b.addEventListener("pointercancel", release);
    }
    for (const b of root.querySelectorAll<HTMLElement>("[data-tap]")) {
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      // on click, so the tap is used up here and doesn't land on the title screen a pause brings up;
      // and not from the tap that brought the controls up
      b.addEventListener("click", () => {
        if (performance.now() - this.shownAt > 400) onTap(b.dataset.tap!);
      });
    }
  }

  show(on: boolean): void {
    if (on && this.root.hidden) this.shownAt = performance.now();
    this.root.hidden = !on;
    if (!on) this.reset();
  }

  /** Let go of everything (pause, lost focus). */
  reset(): void {
    this.stickId = this.lookId = -1;
    this.moveX = this.moveZ = this.stick = 0;
    this.lookDX = this.lookDY = 0;
    this.held.clear();
    this.releaseStick();
    for (const b of this.root.querySelectorAll(".on")) b.classList.remove("on");
  }

  /** Show the buttons that make sense on foot, in a car or in a flyer. */
  setMode(mode: TouchMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.root.dataset.mode = mode;
    this.jump.textContent = JUMP_LABEL[mode];
  }

  private down(e: PointerEvent): void {
    e.preventDefault();
    if (e.clientX < window.innerWidth / 2 && this.stickId < 0) {
      this.stickId = e.pointerId;
      this.origin = [e.clientX, e.clientY];
      this.base.style.left = `${e.clientX}px`;
      this.base.style.top = `${e.clientY}px`;
      this.base.classList.add("on");
      this.setKnob(0, 0);
    } else if (this.lookId < 0) {
      this.lookId = e.pointerId;
      this.lookLast = [e.clientX, e.clientY];
    } else return;
    this.root.setPointerCapture(e.pointerId);
  }

  private move(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      let dx = e.clientX - this.origin[0], dy = e.clientY - this.origin[1];
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        // drag the stick along behind the thumb
        const pull = (len - STICK_RADIUS) / len;
        this.origin[0] += dx * pull;
        this.origin[1] += dy * pull;
        dx -= dx * pull;
        dy -= dy * pull;
        this.base.style.left = `${this.origin[0]}px`;
        this.base.style.top = `${this.origin[1]}px`;
      }
      this.moveX = dx / STICK_RADIUS;
      this.moveZ = -dy / STICK_RADIUS;
      this.stick = Math.hypot(this.moveX, this.moveZ);
      this.setKnob(dx, dy);
    } else if (e.pointerId === this.lookId) {
      this.lookDX += (e.clientX - this.lookLast[0]) * LOOK_GAIN;
      this.lookDY += (e.clientY - this.lookLast[1]) * LOOK_GAIN;
      this.lookLast = [e.clientX, e.clientY];
    }
  }

  private up(e: PointerEvent): void {
    if (e.pointerId === this.stickId) {
      this.stickId = -1;
      this.moveX = this.moveZ = this.stick = 0;
      this.releaseStick();
    } else if (e.pointerId === this.lookId) {
      this.lookId = -1;
    }
  }

  /** Back to its resting place in the corner. */
  private releaseStick(): void {
    this.base.classList.remove("on");
    this.base.style.left = this.base.style.top = "";
    this.setKnob(0, 0);
  }

  private setKnob(dx: number, dy: number): void {
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
}
