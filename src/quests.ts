// Jobs: people around the city with something that needs taking somewhere.
//
// One of them is always waiting not far off, a thin amber light standing over their head.
// Walk up and talk to them and they hand over the job: a parcel for someone on a tower roof,
// a letter for someone on a platform two stations down the line, something they lost up on
// a deck, the survey lamps on the roofs that have gone out. Some things are fragile and do not
// survive a drop of more than a storey; some are the kind of thing the hunters want, and bring
// more of them out while you carry it; some are needed by a time. Nothing is saved, and the
// people and places are made up fresh for each job out of whatever the city has streamed in.

import type { Pad, Roof } from "./city/generate";
import { blocksIn, type Vec2 } from "./city/network";
import { centroid, deckOf, groundAt, inEntrance, pavementAt, pavementOf, shrink, stationWay, WALK, type Station } from "./city/plan";
import type { Particles } from "./effects/particles";
import type { Hunters } from "./hunters";
import type { Vec3 } from "./math";
import type { Pedestrians } from "./pedestrians";
import type { Colliders } from "./player";
import { WALKER_STRIDES } from "./vehicles/models";
import { InstanceList } from "./vehicles/traffic";

/** What the jobs are laid out over: what the city has streamed in. */
export interface QuestWorld {
  roofs(): Iterable<Roof>;
  pads(): Iterable<Pad>;
  stations(): Iterable<Station>;
}

/** Where the runner is this frame, and what they are doing. */
export interface Runner {
  pos: Vec3;
  /** On foot (not in anything, a train included). */
  foot: boolean;
  flyer: boolean;
  /** Vertical speed on foot, for telling a drop from a step. */
  vy: number;
  /** How hard whatever carries the parcel was knocked this frame, 0..1. */
  jolt: number;
  /** The hunters got them this frame. */
  caught: boolean;
}

type Kind = "pavement" | "deck" | "roof" | "platform" | "pad";

interface Place {
  x: number;
  y: number;
  z: number;
  face: number;
  kind: Kind;
  /** How the place is put in words: "on a roof 48 m up". */
  where: string;
  /** And in a few, for the line along the top of the screen: "on a roof". */
  short: string;
  station?: Station;
}

interface Person {
  name: string;
  /** "the beekeeper": said once, when they are met. */
  what: string;
  coat: Vec3;
}

interface Item {
  name: string;
  /** Breaks in a fall of more than a storey, or a crash. */
  fragile: boolean;
  /** The hunters want it: more of them while it is carried, and gone if they catch you. */
  hot: boolean;
  tint: Vec3;
}

/**
 * One thing to do. `take` is a hand-over from someone (or something lying there, with no
 * one); `give` hands over what is carried, and maybe gets something else back; `lamp` is a
 * light to touch.
 */
interface Step {
  kind: "take" | "give" | "lamp";
  at: Place;
  who: Person | null;
  item: Item | null;
  /** What gets said when it is done. */
  line: string;
  done: boolean;
}

interface Job {
  giver: Person;
  /** Said by the giver when the job is taken on. */
  brief: string;
  steps: Step[];
  /** Steps can be done in any order (the lamps). */
  any: boolean;
  /** Seconds to do it in, from when it was taken on; Infinity for no hurry. */
  limit: number;
  thanks: string;
}

/** A job going, with whoever offers it standing where they are. */
interface Offer {
  job: Job;
  at: Place;
}

const STILL = WALKER_STRIDES.indexOf(0);
/** How close counts as there: on foot, and for a lamp, in a flyer. */
const REACH = 2.3, LAMP_REACH = 3.2, LAMP_REACH_AIR = 6;
/** A drop of more than about a storey: the speed of a fall from 3.5 m, at the runner's 19 m/s². */
const HARD_LANDING = 11.5;
/** Seconds after a job ends before someone else asks. */
const BREATHER = 10;
/** Past this the person offering gives up on you, and someone nearer asks instead. */
const OFFER_DROP = 480;
/** People and lamps are drawn out to here; past it the marker on the screen does the work. */
const DRAW = 320;

const NAMES = [
  "Vera", "Oskar", "Ines", "Tomasz", "Mireille", "Arvo", "Dagny", "Lev", "Noor", "Ilse", "Kasimir", "Petra",
  "Yusuf", "Halina", "Bruno", "Sabine", "Emil", "Zora", "Anselm", "Greta", "Matteo", "Ottilie", "Radu", "Signe",
  "Florin", "Agnieszka", "Teodor", "Maren", "Ezra", "Liesel", "Pavol", "Astrid", "Cosmin", "Hedda",
];
const TRADES = [
  "a beekeeper", "a night porter", "a pigeon fancier", "a radio ham", "an archivist", "a tram driver", "a locksmith",
  "a cartographer", "a choirmaster", "a lift engineer", "a retired surveyor", "a window cleaner", "a translator",
  "a concrete inspector", "a bookbinder", "a seamstress", "a cook on the night shift", "a clockmaker",
];
/** Coats a little brighter than the crowd's, so the person you are looking for stands out from it. */
const COATS: Vec3[] = [
  [0.72, 0.42, 0.12], [0.18, 0.42, 0.46], [0.62, 0.16, 0.14], [0.5, 0.52, 0.18], [0.36, 0.24, 0.52], [0.78, 0.7, 0.55],
];

const PLAIN = [
  "a sealed envelope", "a parcel tied with string", "a box of fuses", "a roll of drawings", "a tin of black tea",
  "a reel-to-reel tape", "a spare key on a red ribbon", "a bundle of letters", "a pressed-flower album",
  "a cassette of someone singing", "a jar of buttons", "a set of keys to a flat on the forty-first floor",
];
const FRAGILE = [
  "a jar of rooftop honey", "a valve for an old radio", "a glass fishing float", "a box of eggs", "a camera lens",
  "a bottle of plum brandy", "a snow globe of this very city", "a barometer", "a lampshade of thin green glass",
];
const HOT = [
  "a ledger with the wrong numbers in it", "a reel of film nobody should see", "a bag of unlicensed seeds",
  "the building's master key", "a list of names", "a radio crystal tuned to the hunters' channel",
];
const LOST = [
  "kite", "satchel", "binoculars", "toolbag", "notebook", "pigeon basket", "umbrella", "transistor radio",
];
const TINTS: Vec3[] = [[0.55, 0.42, 0.28], [0.3, 0.32, 0.36], [0.62, 0.55, 0.4], [0.45, 0.2, 0.15], [0.2, 0.3, 0.24]];

const ASK = [
  "my knees won't do the stairs any more", "I can't be seen over there", "you look like someone who runs",
  "nobody else is going that way", "I promised, and then I got old", "the lifts have been out since spring",
  "they'll know it's from me",
];
/** Only said by someone already up off the street. */
const ASK_HIGH = ["the post doesn't come up this high", "I haven't been down to the street in a year"];
/** Only by someone down in the subway. */
const ASK_BELOW = ["I've been down here since the last train", "I don't go up into the weather any more"];
const THANKS = [
  "thank you. I'd given up on it.", "you didn't open it, did you? good.", "tell them it came.",
  "right on time. the city works after all.", "took you long enough. thanks.", "all that way? you ran all that way?",
  "I'll put the kettle on. well — you'd better go.", "good. now I can stop waiting up here.",
];

const pick = <T>(list: readonly T[], r = Math.random): T => list[Math.floor(r() * list.length)];

/** Minutes and seconds. */
export function clockOf(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class Quests {
  /** Off on the title screen and in the demo. */
  active = false;
  /** Jobs done, and jobs lost. */
  done = 0;
  failed = 0;
  /** What people say, and what happens, for the screen to show; taken by the caller. */
  readonly said: string[] = [];
  readonly news: string[] = [];
  /** Things that happened this frame, for the sound. */
  readonly sounds: ("take" | "give" | "done" | "fail" | "lamp")[] = [];
  /** Parcels and lamps lying about. */
  readonly parcels = new InstanceList(8);
  offer: Offer | null = null;
  job: Job | null = null;
  /** What is in hand. */
  carrying: Item | null = null;
  /** Seconds left on the job in hand. */
  left = Infinity;
  private wait = 6;
  private time = 0;
  private lastVy = 0;
  private used = new Set<string>();
  private here: Vec3 = [0, 0, 0];

  constructor(
    private world: QuestWorld, private colliders: Colliders, private hunters: Hunters, private pedestrians: Pedestrians, private particles: Particles,
    private rand = Math.random,
  ) {}

  /** Drop everything (turned off, demo). */
  clear(): void {
    this.offer = null;
    this.job = null;
    this.carrying = null;
    this.hunters.heat = 0;
    this.wait = 6;
  }

  /** The J key: let the job in hand go, or wave away whoever is offering one. */
  drop(): void {
    if (this.job) {
      this.news.push("job dropped");
      this.failed++;
      this.end();
    } else if (this.offer) {
      this.said.push(`${this.offer.job.giver.name}: "suit yourself."`);
      this.offer = null;
      this.wait = 3;
    }
  }

  update(dt: number, r: Runner): void {
    this.time += dt;
    this.here = r.pos;
    if (!this.active) {
      this.hunters.heat = 0;
      return;
    }
    const job = this.job;
    if (!job) {
      this.hunters.heat = 0;
      if (this.offer && dist(this.offer.at, r.pos) > OFFER_DROP) this.offer = null;
      if (!this.offer && (this.wait -= dt) <= 0) {
        this.offer = this.makeOffer(r.pos);
        this.wait = this.offer ? 0 : 3;
      }
      return;
    }

    // what can go wrong
    const item = this.carrying;
    this.hunters.heat = item?.hot ? 2 : 0;
    const vy = r.foot ? r.vy : 0;
    const landed = r.foot && this.lastVy < -HARD_LANDING && vy > -1;
    this.lastVy = vy;
    if (item?.fragile && (landed || r.jolt > 0.5)) return this.fail(`the ${bare(item.name)} is in pieces`);
    if (item?.hot && r.caught) return this.fail(`the hunters took the ${bare(item.name)}`);
    this.left -= dt;
    if (this.left <= 0) return this.fail("too late");

    for (const s of this.next(job)) {
      const flat = Math.hypot(s.at.x - r.pos[0], s.at.z - r.pos[2]), rise = r.pos[1] - s.at.y;
      if (s.kind === "lamp") {
        const reach = r.flyer ? LAMP_REACH_AIR : LAMP_REACH;
        if (flat < reach && rise > -1.5 && rise < (r.flyer ? 6 : 2.5)) this.complete(job, s);
      } else if (r.foot && flat < REACH && Math.abs(rise) < 1.8) this.complete(job, s);
    }
  }

  /** The steps that can be done now: the next one, or any not done yet. */
  private next(job: Job): Step[] {
    if (job.any) return job.steps.filter((s) => !s.done);
    const s = job.steps.find((x) => !x.done);
    return s ? [s] : [];
  }

  private complete(job: Job, s: Step): void {
    s.done = true;
    if (s.line) this.said.push(s.line);
    if (s.kind === "lamp") {
      this.burst(s.at, [6, 3.4, 0.9]);
      const lit = job.steps.filter((x) => x.done).length;
      if (lit < job.steps.length) this.news.push(`${lit} of ${job.steps.length} lit`);
      this.sounds.push("lamp");
    } else if (s.kind === "take") {
      this.carrying = s.item;
      this.sounds.push("take");
    } else {
      this.carrying = s.item;
      this.burst(s.at, [3, 2.4, 1.2]);
      this.sounds.push("give");
    }
    if (job.steps.every((x) => x.done)) {
      this.done++;
      this.news.push("job done");
      if (job.thanks) this.said.push(job.thanks);
      this.sounds.push("done");
      this.end();
    }
  }

  private fail(why: string): void {
    this.failed++;
    this.news.push(why);
    this.sounds.push("fail");
    this.end();
  }

  private end(): void {
    this.job = null;
    this.carrying = null;
    this.hunters.heat = 0;
    this.left = Infinity;
    this.wait = BREATHER;
  }

  /** What E would do here, if it is about a job. */
  promptText(r: Runner): string {
    const o = this.offer;
    if (!this.active || !o || this.job || !r.foot) return "";
    if (Math.hypot(o.at.x - r.pos[0], o.at.z - r.pos[2]) > REACH + 0.6 || Math.abs(r.pos[1] - o.at.y) > 1.8) return "";
    return `E  talk to ${o.job.giver.name}`;
  }

  /** E: take on the job of whoever is in reach. True if that is what E did. */
  interact(r: Runner): boolean {
    if (!this.promptText(r)) return false;
    const job = this.offer!.job;
    this.offer = null;
    this.job = job;
    this.carrying = null;
    this.lastVy = 0;
    this.said.push(`${job.giver.name}, ${job.giver.what}: "${job.brief}"`);
    this.sounds.push("take");
    // the first hand-over is the giver's own, done in the same breath
    const first = job.steps[0];
    if (first.kind === "take" && first.who === job.giver) {
      first.done = true;
      this.carrying = first.item;
    }
    // the clock starts now, from the length of the whole way round
    if (job.limit < Infinity) {
      let len = 0, at: Vec3 = [...r.pos];
      for (const s of job.steps.filter((x) => !x.done)) {
        len += Math.hypot(s.at.x - at[0], s.at.z - at[2]) + Math.abs(s.at.y - at[1]) * 2.5;
        at = [s.at.x, s.at.y, s.at.z];
      }
      this.left = job.limit = Math.round(45 + len / (job.any ? 4.5 : 4));
    } else this.left = Infinity;
    return true;
  }

  /** The line along the top of the screen: what to do next, and how far it is. */
  objective(): string {
    const job = this.job, p = this.here;
    if (!job) return "";
    const steps = this.next(job);
    if (!steps.length) return "";
    // the nearest, when they can be done in any order
    const s = steps.reduce((a, b) => (dist(a.at, p) < dist(b.at, p) ? a : b));
    const what = s.kind === "lamp" ? `light the lamp ${s.at.short}`
      : s.kind === "take" ? (s.who ? `see ${s.who.name} ${s.at.short}` : `find the ${bare(s.item!.name)} ${s.at.short}`)
      : `take ${this.carrying ? `the ${bare(this.carrying.name)}` : "it"} to ${s.who!.name} ${s.at.short}`;
    const parts = [what, `${Math.round(Math.hypot(s.at.x - p[0], s.at.z - p[2]))} m`];
    const dy = s.at.y - p[1];
    if (Math.abs(dy) > 4) parts.push(dy > 0 ? `${Math.round(dy)} m up` : `${Math.round(-dy)} m down`);
    if (job.any) parts.push(`${job.steps.filter((x) => x.done).length} / ${job.steps.length} lit`);
    if (this.carrying?.fragile) parts.push("fragile");
    if (this.carrying?.hot) parts.push("hot");
    if (this.left < Infinity) parts.push(clockOf(this.left));
    return parts.join("  ·  ");
  }

  /** Where to look: whoever is offering, or the steps that can be done now. */
  goals(): Vec3[] {
    if (!this.active) return [];
    if (this.job) return this.next(this.job).map((s) => [s.at.x, s.at.y + 1, s.at.z]);
    return this.offer ? [[this.offer.at.x, this.offer.at.y + 1, this.offer.at.z]] : [];
  }

  /** The people of the job, its parcels and lamps, and a light over whoever you are looking for. */
  draw(eye: Vec3): void {
    this.parcels.clear();
    if (!this.active) return;
    const walkers = this.pedestrians.lists[STILL];
    const person = (at: Place, who: Person, wanted: boolean) => {
      const d = Math.hypot(at.x - eye[0], at.z - eye[2]);
      if (d > DRAW) return;
      // turned to face you once you are close
      const face = d < 14 ? Math.atan2(eye[0] - at.x, eye[2] - at.z) : at.face + Math.sin(this.time * 0.3) * 0.3;
      walkers.push(at.x, at.y, at.z, face, 0, 0, who.coat, 1);
      if (wanted) this.beacon(at, d, [2.4, 1.35, 0.35]);
    };
    if (this.offer) person(this.offer.at, this.offer.job.giver, true);
    const job = this.job;
    if (!job) return;
    const now = new Set(this.next(job));
    for (const s of job.steps) {
      const d = Math.hypot(s.at.x - eye[0], s.at.z - eye[2]);
      if (s.kind === "lamp") {
        if (d > DRAW * 2) continue;
        this.parcels.push(s.at.x, s.at.y, s.at.z, s.at.face, 0, 0, [0.16, 0.16, 0.17], s.done ? 1 : 0);
        // a lit lamp burns for the rest of the job; one still out glows a dull red
        if (s.done) this.beacon(s.at, d, [3.2, 2, 0.6], 1.6);
        else this.glint([s.at.x, s.at.y + 0.5, s.at.z], d, [1.4, 0.2, 0.15]);
        continue;
      }
      if (s.done) continue;
      if (s.who) person(s.at, s.who, now.has(s));
      else if (s.item && d < DRAW) {
        this.parcels.push(s.at.x, s.at.y, s.at.z, s.at.face, 0, 0, s.item.tint, 1);
        if (now.has(s)) this.beacon(s.at, d, [2.4, 1.35, 0.35]);
      }
    }
  }

  /** A thin column of light over a place, which can be seen over the roofs from a few streets off. */
  private beacon(at: Place, d: number, color: Vec3, scale = 1): void {
    const fade = Math.min(1, d / 30) * (0.8 + 0.2 * Math.sin(this.time * 3));
    if (fade < 0.05) {
      this.glint([at.x, at.y + 2.1, at.z], d, color);
      return;
    }
    const size = Math.min(2.4, 0.3 + d * 0.012) * scale;
    for (let k = 0; k < 14; k++) {
      const t = k / 13;
      this.particles.glow.add({
        pos: [at.x, at.y + 2.3 + k * 2.2, at.z], vel: [0, 0, 0], life: 0.03, size,
        color: [color[0] * fade * (1 - t * 0.85), color[1] * fade * (1 - t * 0.85), color[2] * fade * (1 - t * 0.85)],
      });
    }
  }

  private glint(p: Vec3, d: number, color: Vec3): void {
    if (d > 220) return;
    const pulse = 0.7 + 0.3 * Math.sin(this.time * 4);
    this.particles.glow.add({
      pos: p, vel: [0, 0, 0], life: 0.03, size: Math.min(1, 0.25 + d * 0.015),
      color: [color[0] * pulse, color[1] * pulse, color[2] * pulse],
    });
  }

  private burst(at: Place, color: Vec3): void {
    const c: Vec3 = [at.x, at.y + 1.2, at.z];
    for (let i = 0; i < 28; i++) {
      const a = this.rand() * Math.PI * 2, s = 1 + this.rand() * 2.5;
      this.particles.glow.add({
        pos: c, vel: [Math.cos(a) * s, 1.5 + this.rand() * 3.5, Math.sin(a) * s], life: 0.5 + this.rand() * 0.6,
        size: 0.14, color, drag: 2, gravity: -1,
      });
    }
  }

  // --- making jobs up

  private person(): Person {
    return { name: pick(NAMES, this.rand), what: pick(TRADES, this.rand), coat: pick(COATS, this.rand) };
  }

  /** Someone different from everyone already in the job. */
  private stranger(...not: Person[]): Person {
    for (;;) {
      const p = this.person();
      if (!not.some((q) => q.name === p.name)) return p;
    }
  }

  private item(kind: "plain" | "fragile" | "hot"): Item {
    const list = kind === "fragile" ? FRAGILE : kind === "hot" ? HOT : PLAIN;
    return { name: pick(list, this.rand), fragile: kind === "fragile", hot: kind === "hot", tint: pick(TINTS, this.rand) };
  }

  /** Someone near the runner with a job for them. */
  private makeOffer(p: Vec3): Offer | null {
    const under = p[1] < groundAt(p[0], p[2]) - 3;
    const high = p[1] > groundAt(p[0], p[2]) + 30;
    const kinds: Kind[] = under ? ["platform"] : high ? ["roof", "deck", "pad", "roof"] : ["pavement", "deck", "pad", "pavement", "deck"];
    for (let tries = 0; tries < 6; tries++) {
      const at = this.find(pick(kinds, this.rand), p, 30, 170);
      if (!at) continue;
      const giver = this.person();
      const job = this.makeJob(giver, at);
      if (job) return { job, at };
    }
    return null;
  }

  private makeJob(giver: Person, at: Place): Job | null {
    const r = this.rand();
    const hunted = this.hunters.active;
    if (at.kind === "platform" && r < 0.5) return this.train(giver, at);
    if (r < 0.14) return this.lamps(giver, at);
    if (r < 0.3) return this.fetch(giver, at);
    if (r < 0.42) return this.relay(giver, at);
    const flavour = this.rand();
    return this.courier(giver, at, flavour < 0.25 ? "fragile" : flavour < 0.42 && hunted ? "hot" : "plain", this.rand() < 0.3);
  }

  /** Somewhere to take something to: a way off, and somewhere else than where it came from. */
  private far(from: Place, near = 170, out = 520): Place | null {
    const order: Kind[] = ["roof", "roof", "roof", "deck", "deck", "platform", "platform", "pad", "pavement"];
    for (let tries = 0; tries < 8; tries++) {
      let kind = pick(order, this.rand);
      if (kind === from.kind && this.rand() < 0.7) kind = pick(order, this.rand);
      const p = this.find(kind, [from.x, from.y, from.z], near, out);
      if (p) return p;
    }
    return null;
  }

  /** Why they can't take it themselves, which depends on where they are standing. */
  private ask(at: Place): string {
    const extra = at.kind === "platform" ? ASK_BELOW : at.kind === "pavement" ? [] : ASK_HIGH;
    return pick([...ASK, ...extra, ...extra], this.rand);
  }

  /** Take this to someone. */
  private courier(giver: Person, at: Place, kind: "plain" | "fragile" | "hot", rush: boolean): Job | null {
    const to = this.far(at);
    if (!to) return null;
    const them = this.stranger(giver), item = this.item(kind);
    let brief = `${this.ask(at)}. take ${item.name} to ${them.name}, ${to.where}.`;
    if (kind === "fragile") brief += " gently — it won't survive a drop.";
    if (kind === "hot") brief += " and don't let the coats see you with it.";
    if (rush) brief += " they need it soon.";
    return {
      giver, brief, any: false, limit: rush ? 1 : Infinity,
      steps: [
        { kind: "take", at, who: giver, item, line: "", done: false },
        { kind: "give", at: to, who: them, item: null, line: `${them.name}: "${kind === "hot" ? "were you followed? never mind. go." : `${bare(item.name)}? from ${giver.name}? well.`}"`, done: false },
      ],
      thanks: `${them.name}: "${pick(THANKS, this.rand)}"`,
    };
  }

  /** Take this to someone, who has something for someone else in return. */
  private relay(giver: Person, at: Place): Job | null {
    const mid = this.far(at, 140, 380);
    if (!mid) return null;
    const end = this.far(mid, 140, 380);
    if (!end) return null;
    const b = this.stranger(giver), c = this.stranger(giver, b);
    const first = this.item("plain"), second = this.item(this.rand() < 0.4 ? "fragile" : "plain");
    return {
      giver, any: false, limit: Infinity,
      brief: `${b.name} owes me. give them ${first.name} — ${mid.where} — and they'll know what to do.`,
      steps: [
        { kind: "take", at, who: giver, item: first, line: "", done: false },
        {
          kind: "give", at: mid, who: b, item: second, done: false,
          line: `${b.name}: "so ${giver.name} finally paid up. then this goes to ${c.name}, ${end.where}.${second.fragile ? " don't drop it." : ""}"`,
        },
        { kind: "give", at: end, who: c, item: null, line: "", done: false },
      ],
      thanks: `${c.name}: "${bare(second.name)}! ${pick(THANKS, this.rand)}"`,
    };
  }

  /** I lost something up there: bring it back. */
  private fetch(giver: Person, at: Place): Job | null {
    const there = this.find(this.rand() < 0.7 ? "roof" : "deck", [at.x, at.y, at.z], 100, 380);
    if (!there) return null;
    const what = pick(LOST, this.rand);
    const item: Item = { name: `${giver.name}'s ${what}`, fragile: false, hot: false, tint: pick(TINTS, this.rand) };
    return {
      giver, any: false, limit: Infinity,
      brief: `I left my ${what} ${there.where}, and I can't get back up there. would you?`,
      steps: [
        { kind: "take", at: there, who: null, item, line: "", done: false },
        { kind: "give", at, who: giver, item: null, line: "", done: false },
      ],
      thanks: `${giver.name}: "my ${what}! ${pick(THANKS, this.rand)}"`,
    };
  }

  /** The survey lamps on the roofs have gone out: light them before the flyers come over. */
  private lamps(giver: Person, at: Place): Job | null {
    const n = 3 + (this.rand() < 0.35 ? 1 : 0);
    const steps: Step[] = [];
    for (let tries = 0; steps.length < n && tries < n * 4; tries++) {
      const p = this.find(this.rand() < 0.6 ? "roof" : this.rand() < 0.5 ? "pad" : "deck", [at.x, at.y, at.z], 60, 320);
      if (!p || steps.some((s) => dist(s.at, [p.x, p.y, p.z]) < 40)) continue;
      steps.push({ kind: "lamp", at: p, who: null, item: null, line: "", done: false });
    }
    if (steps.length < 3) return null;
    return {
      giver, any: true, limit: 1, steps,
      brief: `${steps.length} of the survey lamps have gone out on the roofs round here. light them again before the flyers come over blind.`,
      thanks: `${giver.name}, from somewhere below: "I see them. all of them. thank you."`,
    };
  }

  /** A letter for someone waiting a few stations down the line. */
  private train(giver: Person, at: Place): Job | null {
    const st = at.station!;
    const others = [...this.world.stations()].filter((s) =>
      s.axis === st.axis && s.line === st.line && s.k !== st.k && Math.abs(s.k - st.k) <= 3);
    if (!others.length) return this.courier(giver, at, "plain", false);
    const to = pick(others, this.rand);
    const there = this.platformSpot(to);
    if (!there) return this.courier(giver, at, "plain", false);
    const them = this.stranger(giver), item = this.item(this.rand() < 0.3 ? "fragile" : "plain");
    return {
      giver, any: false, limit: 1,
      brief: `${them.name} is waiting on the platform at ${to.name}. get ${item.name} to them before they give up — the train's quicker than your legs.`,
      steps: [
        { kind: "take", at, who: giver, item, line: "", done: false },
        { kind: "give", at: there, who: them, item: null, line: "", done: false },
      ],
      thanks: `${them.name}: "${pick(THANKS, this.rand)}"`,
    };
  }

  // --- finding places

  /** A place of a kind between `r0` and `r1` from a point, where someone can stand, or null. */
  private find(kind: Kind, p: Vec3, r0: number, r1: number): Place | null {
    const ok = (x: number, z: number) => {
      const d = Math.hypot(x - p[0], z - p[2]);
      return d >= r0 && d <= r1;
    };
    for (let tries = 0; tries < 10; tries++) {
      let at: Place | null = null;
      if (kind === "roof") {
        const roofs = [...this.world.roofs()].filter((r) => ok(r.poly[0][0], r.poly[0][1]));
        if (!roofs.length) return null;
        at = this.roofSpot(pick(roofs, this.rand));
      } else if (kind === "pad") {
        const pads = [...this.world.pads()].filter((q) => ok(q.x, q.z));
        if (!pads.length) return null;
        at = this.padSpot(pick(pads, this.rand));
      } else if (kind === "platform") {
        const sts = [...this.world.stations()].filter((s) => ok(s.x, s.z));
        if (!sts.length) return null;
        at = this.platformSpot(pick(sts, this.rand));
      } else {
        const a = this.rand() * Math.PI * 2, d = r0 + this.rand() * (r1 - r0);
        const x = p[0] + Math.sin(a) * d, z = p[2] + Math.cos(a) * d;
        const sites = blocksIn(x - 60, z - 60, x + 60, z + 60);
        if (!sites.length) continue;
        at = this.blockSpot(pick(sites, this.rand), kind);
      }
      if (!at) continue;
      const key = `${Math.round(at.x / 8)},${Math.round(at.y / 4)},${Math.round(at.z / 8)}`;
      if (this.used.has(key) || !ok(at.x, at.z)) continue;
      this.used.add(key);
      if (this.used.size > 400) this.used.clear();
      return at;
    }
    return null;
  }

  /** Feet height of somewhere a body `r` wide can stand at (x, z), within a metre of level y, or null. */
  private standAt(x: number, z: number, y: number, r: number): number | null {
    const boxes = this.colliders(x, z);
    let ground = -Infinity;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + r && boxes[i + 3] > x - r && boxes[i + 2] < z + r && boxes[i + 5] > z - r &&
          boxes[i + 4] <= y + 1) ground = Math.max(ground, boxes[i + 4]);
    }
    if (Math.abs(ground - y) > 1) return null;
    for (let i = 0; i < boxes.length; i += 6) {
      if (boxes[i] < x + r && boxes[i + 3] > x - r && boxes[i + 2] < z + r && boxes[i + 5] > z - r &&
          boxes[i + 1] < ground + 2.2 && boxes[i + 4] > ground + 0.05) return null;
    }
    return ground;
  }

  /**
   * A clear spot at about level y, with room on at least two sides of it to walk up, so
   * nobody is put in a corner no one can get into.
   */
  private stand(x: number, z: number, y: number, r = 0.5): number | null {
    const g = this.standAt(x, z, y, r);
    if (g === null) return null;
    let room = 0;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      if (this.standAt(x + Math.sin(a) * 1.1, z + Math.cos(a) * 1.1, g, 0.35) !== null) room++;
    }
    return room >= 2 ? g : null;
  }

  /**
   * On the walk round the edge of a roof: most of a roof is the plant room, and what is left
   * is a strip a metre or so wide between it and the drop.
   */
  private roofSpot(roof: Roof): Place | null {
    const line = shrink(roof.poly, 0.6);
    if (line.length < 3) return null;
    const c = centroid(line);
    for (let k = 0; k < 10; k++) {
      const i = Math.floor(this.rand() * line.length);
      const a = line[i], b = line[(i + 1) % line.length], t = 0.2 + this.rand() * 0.6;
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const y = this.stand(x, z, roof.y, 0.3);
      if (y === null) continue;
      const up = Math.round(y - groundAt(x, z));
      return { x, y, z, face: Math.atan2(x - c[0], z - c[1]), kind: "roof", where: `on a roof ${up} m up`, short: "on a roof" };
    }
    return null;
  }

  private padSpot(pad: Pad): Place | null {
    for (let k = 0; k < 8; k++) {
      const a = this.rand() * Math.PI * 2, d = 2.6 + this.rand() * 1.4;
      const x = pad.x + Math.sin(a) * d, z = pad.z + Math.cos(a) * d;
      const y = this.stand(x, z, pad.y);
      if (y === null) continue;
      const up = y - groundAt(x, z);
      const where = up > 30 ? `by a parked flyer, on a roof ${Math.round(up)} m up` : "by a parked flyer";
      return { x, y, z, face: Math.atan2(pad.x - x, pad.z - z), kind: "pad", where, short: "by a parked flyer" };
    }
    return null;
  }

  private platformSpot(st: Station): Place | null {
    const sw = stationWay(st);
    for (let k = 0; k < 12; k++) {
      const m = (this.rand() * 2 - 1) * (sw.hall - 6);
      const off = (this.rand() < 0.5 ? -1 : 1) * (1 + this.rand() * 3.2);
      if (m > sw.well[0] - 2 && m < sw.well[1] + 2 && Math.abs(off) < sw.half + 0.8) continue;
      const [x, py, z] = sw.platform(m, off);
      const y = this.stand(x, z, py);
      if (y === null) continue;
      const [ax, , az] = sw.platform(m + 1, off);
      return {
        x, y, z, face: Math.atan2(ax - x, az - z), kind: "platform", where: `on the platform at ${st.name}`, short: `at ${st.name}`, station: st,
      };
    }
    return null;
  }

  /** On a block's deck, or out on the pavement round it. */
  private blockSpot(site: Parameters<typeof deckOf>[0], kind: "deck" | "pavement"): Place | null {
    const poly = pavementOf(site);
    if (!poly) return null;
    const deck = kind === "deck";
    const line = shrink(poly, deck ? WALK + 1.6 : 2.4);
    if (line.length < 3) return null;
    const E = deck ? deckOf(site) : 0;
    const stations = deck ? [] : [...this.world.stations()];
    for (let k = 0; k < 8; k++) {
      const i = Math.floor(this.rand() * line.length);
      const a = line[i], b = line[(i + 1) % line.length], t = this.rand();
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      if (stations.some((st) => inEntrance(st, x, z, 2))) continue;
      const y = this.stand(x, z, deck ? E : pavementAt(x, z));
      if (y === null) continue;
      // facing out, over the street
      const c: Vec2 = centroid(poly);
      return {
        x, y, z, face: Math.atan2(x - c[0], z - c[1]), kind,
        where: deck ? "up on the deck" : "down on the pavement", short: deck ? "on the deck" : "on the pavement",
      };
    }
    return null;
  }
}

/** "a jar of honey" -> "jar of honey"; a name stays as it is. */
function bare(name: string): string {
  return name.replace(/^(a|an|the) /, "");
}

function dist(a: { x: number; y: number; z: number }, p: Vec3): number {
  return Math.hypot(a.x - p[0], a.y - p[1], a.z - p[2]);
}
