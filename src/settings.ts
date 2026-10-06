// Settings: what the player can change about the game, kept in the browser between visits,
// and the dialog they change it in.
//
// Everything is read back through `settings`, so the rest of the game never touches storage.
// A setting either takes hold at once (volumes, the radar, the keys) or, for the few the
// renderer fixes when it builds its targets, on the next load — the dialog says which.

export type Difficulty = "easy" | "normal" | "hard";
export type Quality = "auto" | "low" | "medium" | "high";

/** Things a key can be bound to. Mouse buttons, Esc and the F-keys are not rebindable. */
export const ACTIONS = {
  forward: "run forward",
  back: "run back",
  left: "strafe left",
  right: "strafe right",
  jump: "jump / climb / up",
  sprint: "sprint",
  walk: "walk / down",
  fire: "shoot",
  interact: "get in / out",
  view: "cockpit view",
  roof: "back to last roof",
  map: "map",
  zoomIn: "map zoom in",
  zoomOut: "map zoom out",
  hunters: "hunters on / off",
  music: "music on / off",
  weather: "next weather",
  holdWeather: "hold weather",
  clockBack: "clock back an hour",
  clockOn: "clock on an hour",
  holdClock: "hold the clock",
} as const;
export type Action = keyof typeof ACTIONS;

const DEFAULT_KEYS: Record<Action, string[]> = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  jump: ["Space"],
  sprint: ["ShiftLeft", "ShiftRight"],
  walk: ["ControlLeft", "KeyC"],
  fire: ["KeyF"],
  interact: ["KeyE"],
  view: ["KeyV"],
  roof: ["KeyR"],
  map: ["KeyM"],
  zoomIn: ["Equal", "NumpadAdd"],
  zoomOut: ["Minus", "NumpadSubtract"],
  hunters: ["KeyH"],
  music: ["KeyU"],
  weather: ["KeyN"],
  holdWeather: ["KeyL"],
  clockBack: ["Comma"],
  clockOn: ["Period"],
  holdClock: ["KeyK"],
};

/** Keys the game keeps for itself. */
const RESERVED = new Set(["Escape", "F3", "F4"]);

export interface Settings {
  sfxVolume: number; // 0..1
  musicVolume: number; // 0..1
  music: boolean;
  hunters: boolean;
  difficulty: Difficulty;
  radar: boolean;
  quality: Quality; // applies on reload
  /** Internal resolution: 0 lets it adapt to the frame rate, otherwise a fixed scale. */
  resolution: number;
  detail: number; // multiplier on the distances small and far geometry stop being drawn at
  fov: number; // degrees, on foot at a standstill
  sensitivity: number; // multiplier on the mouse
  invertY: boolean;
  keys: Record<Action, string[]>;
}

const DEFAULTS: Settings = {
  sfxVolume: 0.8,
  musicVolume: 0.7,
  music: true,
  hunters: true,
  difficulty: "normal",
  radar: true,
  quality: "auto",
  resolution: 0,
  detail: 1,
  fov: 76,
  sensitivity: 1,
  invertY: false,
  keys: DEFAULT_KEYS,
};

const STORE = "settings";

function load(): Settings {
  const s: Settings = { ...DEFAULTS, keys: structuredClone(DEFAULT_KEYS) };
  try {
    // the music switch was kept on its own before there was a settings dialog
    if (localStorage.getItem("music") === "off") s.music = false;
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Partial<Settings>;
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (k === "keys" || saved[k] === undefined || typeof saved[k] !== typeof DEFAULTS[k]) continue;
      (s as unknown as Record<string, unknown>)[k] = saved[k];
    }
    // only actions that still exist, so a saved layout survives actions being added or dropped
    for (const a of Object.keys(DEFAULT_KEYS) as Action[]) {
      const codes = saved.keys?.[a];
      if (Array.isArray(codes)) s.keys[a] = codes.filter((c) => typeof c === "string").slice(0, 2);
    }
  } catch {}
  return s;
}

export const settings = load();

export function saveSettings(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
    localStorage.removeItem("music");
  } catch {}
}

/** Which action a key is bound to, if any. */
const lookup = new Map<string, Action>();
function rebuildLookup(): void {
  lookup.clear();
  for (const [a, codes] of Object.entries(settings.keys)) for (const c of codes) lookup.set(c, a as Action);
}
rebuildLookup();

export function actionOf(code: string): Action | undefined {
  return lookup.get(code);
}

/** True if any key bound to `action` is in `held`. */
export function held(keys: Set<string>, action: Action): boolean {
  return settings.keys[action].some((c) => keys.has(c));
}

/** A key code as the player would name it. */
export function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  const names: Record<string, string> = {
    Space: "space", ShiftLeft: "shift", ShiftRight: "right shift", ControlLeft: "ctrl", ControlRight: "right ctrl",
    AltLeft: "alt", AltRight: "right alt", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Minus: "−", Equal: "=", Backquote: "`", Enter: "enter", Tab: "tab", CapsLock: "caps lock",
    NumpadAdd: "num +", NumpadSubtract: "num −",
  };
  return names[code] ?? code.replace(/^Numpad/, "num ").toLowerCase();
}

/** The first key bound to an action, for hints ("E  get in"); empty if none is. */
export function keyFor(action: Action): string {
  const c = settings.keys[action][0];
  return c ? keyName(c) : "";
}

// --- the dialog

type Change = keyof Settings;

const QUALITY_TEXT: Record<Quality, string> = { auto: "auto", low: "low", medium: "medium", high: "high" };

export class SettingsDialog {
  open = false;
  private root: HTMLElement;
  private body: HTMLElement;
  private capture: { action: Action; slot: number; el: HTMLElement } | null = null;
  private loadedQuality = settings.quality;

  /** `onChange` hears about every change, once it has been saved. */
  constructor(private onChange: (what: Change) => void) {
    this.root = document.getElementById("settings")!;
    this.body = this.root.querySelector(".body")!;
    this.root.querySelector(".close")!.addEventListener("click", () => this.setOpen(false));
    this.root.querySelector(".reset")!.addEventListener("click", () => this.resetKeys());
    // nothing in here is a click on the title screen behind it
    for (const type of ["pointerdown", "click", "wheel"]) this.root.addEventListener(type, (e) => e.stopPropagation());
    // While the dialog is open the keyboard belongs to it: a key is either a new binding or
    // nothing at all, never a game action going on underneath.
    window.addEventListener("keydown", (e) => {
      if (!this.open) return;
      if (this.capture) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.bind(e.code);
        return;
      }
      if (e.code === "Escape") {
        e.preventDefault();
        this.setOpen(false);
      }
      // (stopping it here leaves the browser's own handling alone: tab and space still work)
      e.stopImmediatePropagation();
    }, { capture: true });
    this.build();
  }

  setOpen(on: boolean): void {
    this.open = on;
    this.root.hidden = !on;
    if (!on) this.capture = null;
    else this.build();
  }

  private changed(what: Change): void {
    saveSettings();
    this.onChange(what);
  }

  private build(): void {
    this.body.textContent = "";
    const section = (title: string) => {
      const h = document.createElement("h3");
      h.textContent = title;
      this.body.append(h);
    };
    const row = (label: string, control: HTMLElement, note = "") => {
      const r = document.createElement("label");
      r.className = "row";
      const name = document.createElement("span");
      name.textContent = label;
      if (note) {
        const n = document.createElement("small");
        n.textContent = note;
        name.append(n);
      }
      r.append(name, control);
      this.body.append(r);
    };
    const slider = <K extends Change>(key: K, min: number, max: number, step: number, show: (v: number) => string) => {
      const wrap = document.createElement("span");
      wrap.className = "slider";
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(settings[key]);
      const out = document.createElement("output");
      out.textContent = show(settings[key] as number);
      input.addEventListener("input", () => {
        (settings as unknown as Record<string, number>)[key] = Number(input.value);
        out.textContent = show(Number(input.value));
        this.changed(key);
      });
      wrap.append(input, out);
      return wrap;
    };
    const check = <K extends Change>(key: K) => {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = settings[key] as boolean;
      input.addEventListener("change", () => {
        (settings as unknown as Record<string, boolean>)[key] = input.checked;
        this.changed(key);
      });
      return input;
    };
    const choice = <K extends Change>(key: K, options: [string | number, string][]) => {
      const select = document.createElement("select");
      for (const [value, text] of options) {
        const o = document.createElement("option");
        o.value = String(value);
        o.textContent = text;
        select.append(o);
      }
      select.value = String(settings[key]);
      select.addEventListener("change", () => {
        const v = typeof settings[key] === "number" ? Number(select.value) : select.value;
        (settings as unknown as Record<string, unknown>)[key] = v;
        this.changed(key);
        if (key === "quality") this.build(); // to show or clear the reload note
      });
      return select;
    };
    const percent = (v: number) => `${Math.round(v * 100)}%`;

    section("sound");
    row("effects volume", slider("sfxVolume", 0, 1, 0.05, percent));
    row("music volume", slider("musicVolume", 0, 1, 0.05, percent));
    row("music", check("music"));

    section("game");
    row("hunters", check("hunters"));
    row("difficulty", choice("difficulty", [["easy", "easy"], ["normal", "normal"], ["hard", "hard"]]));
    row("radar map", check("radar"), "always on while you play");

    section("graphics");
    const reload = settings.quality !== this.loadedQuality;
    row("quality", choice("quality", (Object.keys(QUALITY_TEXT) as Quality[]).map((q) => [q, QUALITY_TEXT[q]])),
      reload ? "takes effect on reload" : "anti-aliasing and shadow detail");
    if (reload) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "reload now";
      b.addEventListener("click", () => location.reload());
      row("", b);
    }
    row("resolution", choice("resolution", [[0, "adaptive"], [0.5, "50%"], [0.7, "70%"], [0.85, "85%"], [1, "100%"]]));
    row("draw distance", choice("detail", [[0.7, "near"], [1, "normal"], [1.3, "far"]]));
    row("field of view", slider("fov", 60, 100, 1, (v) => `${v}°`));

    section("mouse");
    row("sensitivity", slider("sensitivity", 0.25, 3, 0.05, (v) => `${v.toFixed(2)}×`));
    row("invert look", check("invertY"));

    section("keys");
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "click a key to change it, then press the new one · delete clears it · esc cancels";
    this.body.append(hint);
    for (const a of Object.keys(ACTIONS) as Action[]) {
      const cell = document.createElement("span");
      cell.className = "keys";
      for (let slot = 0; slot < 2; slot++) {
        const b = document.createElement("button");
        b.type = "button";
        const code = settings.keys[a][slot];
        b.textContent = code ? keyName(code) : "—";
        b.classList.toggle("empty", !code);
        b.addEventListener("click", (e) => {
          e.preventDefault(); // a label around a button would pass the click on
          this.startCapture(a, slot, b);
        });
        cell.append(b);
      }
      row(ACTIONS[a], cell);
    }
  }

  private startCapture(action: Action, slot: number, el: HTMLElement): void {
    this.capture?.el.classList.remove("listening");
    this.capture = { action, slot, el };
    el.classList.add("listening");
    el.textContent = "press a key";
  }

  private bind(code: string): void {
    const { action, slot } = this.capture!;
    this.capture = null;
    const list = settings.keys[action];
    if (code === "Delete" || code === "Backspace") list.splice(slot, 1);
    else if (code !== "Escape" && !RESERVED.has(code)) {
      // a key does one thing: take it off whatever had it before
      for (const codes of Object.values(settings.keys)) {
        const i = codes.indexOf(code);
        if (i >= 0) codes.splice(i, 1);
      }
      if (slot < list.length) list[slot] = code;
      else list.push(code);
    }
    rebuildLookup();
    this.changed("keys");
    this.build();
  }

  private resetKeys(): void {
    settings.keys = structuredClone(DEFAULT_KEYS);
    rebuildLookup();
    this.changed("keys");
    this.build();
  }
}
