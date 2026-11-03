import { AGENT_RADIUS, CollisionRegistry, StoreNavigation, type Point } from "./navigation";
/** Pure crew simulation: the same KiranaCrew characters, now running a kirana store. No three.js/React here. */

export type Pose = "standing" | "working" | "seated" | "reading" | "talking" | "reaching";
export type CrewStatus = "idle" | "working" | "done";

export interface CrewActor {
  id: string;
  name: string;
  role: string;
  activity: string;
  x: number;
  z: number;
  facing: number;
  moving: boolean;
  pose: Pose;
  carrying: boolean;
  status: CrewStatus;
}

interface Stop {
  x: number;
  z: number;
  facing: number; // radians; 0 = facing camera (+z)
  pose: Pose;
  activity: string;
  wait: number;
  carry?: boolean;
}

export interface CrewDef {
  id: string;
  name: string;
  role: string;
  palette: { hair: string; shirt: string; skin: string; pants?: string };
  prop: "tablet" | "box" | "clipboard" | "none";
  stops: Stop[];
}

const UP = Math.PI; // facing the back wall
const DOWN = 0;
const LEFT = -Math.PI / 2;
const RIGHT = Math.PI / 2;

export const CREW: CrewDef[] = [
  {
    id: "alice",
    name: "Alice",
    role: "Manager",
    palette: { hair: "#a64e42", shirt: "#3e6571", skin: "#bc896e" },
    prop: "clipboard",
    stops: [
      { x: -4.6, z: 6.4, facing: DOWN, pose: "seated", activity: "Orchestrating", wait: 9 },
      { x: -6.6, z: 3.6, facing: UP, pose: "reading", activity: "Reviewing board", wait: 4 },
      { x: -4.6, z: 6.4, facing: DOWN, pose: "seated", activity: "Orchestrating", wait: 7 },
    ],
  },
  {
    id: "bob",
    name: "Bob",
    role: "Inventory",
    palette: { hair: "#744b35", shirt: "#48566b", skin: "#d3a182" },
    prop: "tablet",
    stops: [
      { x: -8.4, z: -6.9, facing: UP, pose: "reading", activity: "Checking Stock", wait: 5 },
      { x: -5.2, z: -6.9, facing: UP, pose: "reaching", activity: "Restocking atta", wait: 4 },
      { x: -11.2, z: -3.4, facing: LEFT, pose: "reading", activity: "Counting shelf", wait: 4 },
    ],
  },
  {
    id: "carol",
    name: "Carol",
    role: "Sales",
    palette: { hair: "#314c64", shirt: "#7c6782", skin: "#e6b89b" },
    prop: "tablet",
    stops: [
      { x: -8.0, z: -2.2, facing: RIGHT, pose: "reading", activity: "Analyzing", wait: 6 },
      { x: -5.4, z: -1.2, facing: UP, pose: "talking", activity: "Tracking demand", wait: 4 },
    ],
  },
  {
    id: "dave",
    name: "Dave",
    role: "Procurement",
    palette: { hair: "#593b2c", shirt: "#e7e2d6", skin: "#d7a784", pants: "#3b4a63" },
    prop: "box",
    stops: [
      { x: -2.6, z: -3.2, facing: RIGHT, pose: "standing", activity: "Comparing", wait: 4 },
      {
        x: 6.5,
        z: 4.4,
        facing: UP,
        pose: "reaching",
        activity: "Picking stock",
        wait: 3,
        carry: true,
      },
      { x: -1.6, z: -5.4, facing: UP, pose: "reaching", activity: "Shelving boxes", wait: 3 },
    ],
  },
  {
    id: "erin",
    name: "Erin",
    role: "Finance",
    palette: { hair: "#4d4439", shirt: "#aa7041", skin: "#cba280" },
    prop: "tablet",
    stops: [
      { x: 8.4, z: -2.6, facing: UP, pose: "working", activity: "Analyzing", wait: 8 },
      { x: 10.8, z: -2.0, facing: LEFT, pose: "talking", activity: "Reconciling", wait: 4 },
    ],
  },
  {
    id: "frank",
    name: "Frank",
    role: "Billing",
    palette: { hair: "#3a2a20", shirt: "#7a3b2e", skin: "#c9946f" },
    prop: "none",
    stops: [
      { x: -10.2, z: 4.0, facing: DOWN, pose: "working", activity: "At Counter", wait: 10 },
      { x: -11.4, z: 3.8, facing: LEFT, pose: "reaching", activity: "Packing order", wait: 3 },
    ],
  },
  {
    id: "grace",
    name: "Grace",
    role: "Reports",
    palette: { hair: "#2b2b33", shirt: "#3f4f8a", skin: "#d9a98a" },
    prop: "tablet",
    stops: [
      { x: 1.2, z: -3.4, facing: RIGHT, pose: "reading", activity: "Analyzing", wait: 6 },
      { x: 4.4, z: -6.6, facing: UP, pose: "reading", activity: "Produce report", wait: 5 },
    ],
  },
  {
    id: "you",
    name: "You",
    role: "Shop Owner",
    palette: { hair: "#22201e", shirt: "#3b84c4", skin: "#c58f6d" },
    prop: "none",
    stops: [{ x: -0.8, z: 6.3, facing: DOWN, pose: "seated", activity: "Shop Owner", wait: 999 }],
  },
];

export const WALK_SPEED = 1.65;
interface Runner {
  def: CrewDef;
  index: number;
  waitLeft: number;
  actor: CrewActor;
  path: Point[];
  blocked: number;
}

/** Tasks use each role's configured stations; live activity text can choose a matching station. */
export const TASK_DESTINATIONS: Record<string, Array<{ pattern: RegExp; station: number }>> = {
  alice: [{ pattern: /board|review|visit/i, station: 1 }],
  bob: [
    { pattern: /restock|atta/i, station: 1 },
    { pattern: /count/i, station: 2 },
  ],
  carol: [{ pattern: /demand/i, station: 1 }],
  dave: [
    { pattern: /stock|procure|pick|supplier/i, station: 1 },
    { pattern: /shelv/i, station: 2 },
  ],
  erin: [{ pattern: /reconcil|payment/i, station: 1 }],
  frank: [{ pattern: /pack/i, station: 1 }],
  grace: [{ pattern: /produce/i, station: 1 }],
};

export class CrewSim {
  private runners: Runner[];
  private live = new Map<string, string>();
  private paused = false;
  setPaused(v: boolean) {
    this.paused = v;
    if (v) for (const r of this.runners) r.actor.moving = false;
  }
  readonly navigation: StoreNavigation;
  constructor(defs: CrewDef[] = CREW, collisions = new CollisionRegistry()) {
    this.navigation = new StoreNavigation(collisions);
    const placed: Point[] = [];
    this.runners = defs.flatMap((def, i) => {
      const s = def.stops[0];
      if (!s) return [];
      const safe = this.navigation.nearest(s, placed);
      if (!safe) return [];
      placed.push(safe);
      return [
        {
          def,
          index: 0,
          waitLeft: s.wait * (0.4 + (i % 3) * 0.3),
          path: [],
          blocked: 0,
          actor: {
            id: def.id,
            name: def.name,
            role: def.role,
            activity: s.activity,
            x: safe.x,
            z: safe.z,
            facing: s.facing,
            moving: false,
            pose: s.pose,
            carrying: !!s.carry,
            status: def.id === "you" ? ("idle" as const) : ("working" as const),
          },
        },
      ];
    });
  }
  setActivities(map: Record<string, string>) {
    this.live = new Map(Object.entries(map).filter(([, activity]) => !!activity));
    for (const r of this.runners) if (!r.actor.moving) r.actor.activity = this.activityFor(r);
  }
  private activityFor(r: Runner) {
    return this.live.get(r.actor.id) ?? r.def.stops[r.index]?.activity ?? "Waiting";
  }
  get actors(): CrewActor[] {
    return this.runners.map((r) => r.actor);
  }
  private others(r: Runner) {
    return this.runners.filter((o) => o !== r).map((o) => o.actor);
  }
  private plan(r: Runner) {
    const stop = r.def.stops[r.index];
    if (!stop) return;
    r.path = this.navigation.route(r.actor, stop, this.others(r));
    r.blocked = 0;
  }
  step(dtRaw: number) {
    if (this.paused) return;
    const dt = Math.max(0, Math.min(dtRaw, 0.05));
    for (const r of this.runners) {
      const a = r.actor;
      const t = r.path[0];
      a.moving = false;
      if (t) {
        const dx = t.x - a.x,
          dz = t.z - a.z,
          d = Math.hypot(dx, dz);
        const move = Math.min(d, WALK_SPEED * dt);
        const candidate =
          d > 0 ? { x: a.x + (dx / d) * move, z: a.z + (dz / d) * move } : { x: a.x, z: a.z };
        const clear =
          this.navigation.collisions.segmentFree(a, candidate) &&
          this.others(r).every(
            (o) => Math.hypot(o.x - candidate.x, o.z - candidate.z) >= AGENT_RADIUS * 2,
          );
        if (!clear) {
          r.blocked += dt;
          a.activity = "Waiting for aisle";
          if (r.blocked > 1.2) this.plan(r);
          continue;
        }
        r.blocked = 0;
        a.x = candidate.x;
        a.z = candidate.z;
        a.moving = d > 0.01;
        a.pose = "standing";
        a.activity = "Walking";
        if (d > 0.01) a.facing = Math.atan2(dx, dz);
        if (d <= move + 0.001) r.path.shift();
        if (!r.path.length) {
          const stop = r.def.stops[r.index];
          if (stop) {
            a.moving = false;
            a.facing = stop.facing;
            a.pose = stop.pose;
            a.carrying = !!stop.carry;
            r.waitLeft = stop.wait;
            a.activity = this.activityFor(r);
          }
        }
        continue;
      }
      r.waitLeft -= dt;
      if (r.waitLeft > 0 || r.def.stops.length < 2) continue;
      const preferred = TASK_DESTINATIONS[a.id]?.find((s) =>
        s.pattern.test(this.live.get(a.id) ?? ""),
      )?.station;
      r.index = preferred ?? (r.index + 1) % r.def.stops.length;
      this.plan(r);
      if (!r.path.length) {
        r.waitLeft = 2;
        a.activity = "Waiting for clear route";
      }
    }
  }
}
