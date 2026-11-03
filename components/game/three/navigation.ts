import PF from "pathfinding";

export interface Point {
  x: number;
  z: number;
}
export interface Boundary {
  id: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export const AGENT_RADIUS = 0.43;
export const NAV_CELL = 0.25;
export const FLOOR_BOUNDS = { minX: -13.8, maxX: 13.8, minZ: -8.8, maxZ: 8.8 };

/** One registry shared by fixture builders, navigation and movement validation. */
export class CollisionRegistry {
  readonly boundaries: Boundary[] = [];
  add(id: string, x: number, z: number, width: number, depth: number, rotation = 0) {
    const w = Math.abs(Math.cos(rotation)) * width + Math.abs(Math.sin(rotation)) * depth;
    const d = Math.abs(Math.sin(rotation)) * width + Math.abs(Math.cos(rotation)) * depth;
    this.boundaries.push({
      id,
      minX: x - w / 2,
      maxX: x + w / 2,
      minZ: z - d / 2,
      maxZ: z + d / 2,
    });
  }
  isFree(p: Point, radius = AGENT_RADIUS) {
    const b = FLOOR_BOUNDS;
    if (
      p.x < b.minX + radius ||
      p.x > b.maxX - radius ||
      p.z < b.minZ + radius ||
      p.z > b.maxZ - radius
    )
      return false;
    return !this.boundaries.some((o) => {
      const dx = p.x - Math.max(o.minX, Math.min(p.x, o.maxX));
      const dz = p.z - Math.max(o.minZ, Math.min(p.z, o.maxZ));
      return dx * dx + dz * dz < radius * radius;
    });
  }
  segmentFree(a: Point, b: Point) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (NAV_CELL / 2)));
    for (let i = 0; i <= n; i++)
      if (!this.isFree({ x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n }))
        return false;
    return true;
  }
}

export class StoreNavigation {
  private readonly width = Math.ceil((FLOOR_BOUNDS.maxX - FLOOR_BOUNDS.minX) / NAV_CELL);
  private readonly height = Math.ceil((FLOOR_BOUNDS.maxZ - FLOOR_BOUNDS.minZ) / NAV_CELL);
  private grid: PF.Grid;
  private finder = new PF.AStarFinder({ allowDiagonal: true, dontCrossCorners: true });
  constructor(readonly collisions: CollisionRegistry) {
    this.grid = new PF.Grid(this.width, this.height);
    for (let z = 0; z < this.height; z++)
      for (let x = 0; x < this.width; x++) {
        this.grid.setWalkableAt(x, z, collisions.isFree(this.point(x, z)));
      }
  }
  private point(x: number, z: number): Point {
    return {
      x: FLOOR_BOUNDS.minX + (x + 0.5) * NAV_CELL,
      z: FLOOR_BOUNDS.minZ + (z + 0.5) * NAV_CELL,
    };
  }
  nearest(p: Point, others: Point[] = []): Point | null {
    if (
      this.collisions.isFree(p) &&
      others.every((a) => Math.hypot(a.x - p.x, a.z - p.z) >= AGENT_RADIUS * 2)
    )
      return { ...p };
    let best: Point | null = null;
    let distance = Infinity;
    for (let z = 0; z < this.height; z++)
      for (let x = 0; x < this.width; x++) {
        if (!this.grid.isWalkableAt(x, z)) continue;
        const q = this.point(x, z);
        const d = Math.hypot(q.x - p.x, q.z - p.z);
        if (
          d < distance &&
          others.every((a) => Math.hypot(a.x - q.x, a.z - q.z) >= AGENT_RADIUS * 2 + 0.05)
        ) {
          best = q;
          distance = d;
        }
      }
    return best;
  }
  route(from: Point, destination: Point, others: Point[] = []): Point[] {
    const target = this.nearest(destination, others);
    if (!target) return [];
    const grid = this.grid.clone();
    const cell = (p: Point) =>
      [
        Math.max(0, Math.min(this.width - 1, Math.floor((p.x - FLOOR_BOUNDS.minX) / NAV_CELL))),
        Math.max(0, Math.min(this.height - 1, Math.floor((p.z - FLOOR_BOUNDS.minZ) / NAV_CELL))),
      ] as const;
    for (let z = 0; z < this.height; z++)
      for (let x = 0; x < this.width; x++) {
        const p = this.point(x, z);
        if (others.some((a) => Math.hypot(a.x - p.x, a.z - p.z) < AGENT_RADIUS * 2 + NAV_CELL / 2))
          grid.setWalkableAt(x, z, false);
      }
    const validCell = (p: Point) => {
      const initial = cell(p);
      if (
        grid.isWalkableAt(initial[0], initial[1]) &&
        this.collisions.segmentFree(p, this.point(initial[0], initial[1]))
      )
        return initial;
      let best: readonly [number, number] | null = null,
        distance = Infinity;
      for (let z = 0; z < this.height; z++)
        for (let x = 0; x < this.width; x++) {
          const q = this.point(x, z),
            d = Math.hypot(q.x - p.x, q.z - p.z);
          if (d < distance && grid.isWalkableAt(x, z) && this.collisions.segmentFree(p, q)) {
            best = [x, z];
            distance = d;
          }
        }
      return best;
    };
    const start = validCell(from),
      end = validCell(target);
    if (!start || !end) return [];
    const [sx, sz] = start;
    const [tx, tz] = end;
    const raw = this.finder.findPath(sx, sz, tx, tz, grid);
    const path = raw.map(([x, z]) => this.point(x ?? 0, z ?? 0));
    if (!path.length) return [];
    const last = path[path.length - 1];
    if (last && this.collisions.segmentFree(last, target)) path.push(target);
    // Keep every grid corner: smoothing must not cut through inflated fixture bounds.
    let previous = from;
    for (const p of path) {
      if (!this.collisions.segmentFree(previous, p)) return [];
      previous = p;
    }
    return path;
  }
}
