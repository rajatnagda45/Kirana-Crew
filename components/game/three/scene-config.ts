/** Shared visual placement, independent of inventory and movement rules. */
export const SIGN_STYLE = { resolution: 1024, padding: 0.09, minimumHeight: 0.48, clearance: 0.18 };
export const STORE_SIGNS = [
  {
    id: "brand",
    text: ["KiranaCrew", "General Store"],
    x: -10.6,
    y: 3.38,
    z: -8.02,
    width: 3.5,
    height: 0.94,
  },
  { id: "grocery", text: ["Groceries"], x: -6.9, y: 2.65, z: -8.08, width: 2.6, height: 0.5 },
  {
    id: "snacks",
    text: ["Snacks & Biscuits"],
    x: -3.5,
    y: 2.65,
    z: -8.08,
    width: 3.2,
    height: 0.5,
  },
  { id: "household", text: ["Household"], x: -0.2, y: 2.65, z: -8.08, width: 2.6, height: 0.5 },
  {
    id: "personal",
    text: ["Personal Care"],
    x: -13.17,
    y: 2.16,
    z: -2.4,
    width: 2.2,
    height: 0.5,
    rotation: Math.PI / 2,
  },
  { id: "produce", text: ["Fresh Produce"], x: 4, y: 2.45, z: -8.05, width: 3, height: 0.5 },
  { id: "dairy", text: ["Dairy & Milk"], x: 10.45, y: 2.65, z: -7.96, width: 3.6, height: 0.5 },
  { id: "frozen", text: ["Frozen"], x: 13, y: 1.9, z: -8.02, width: 1.45, height: 0.48 },
  {
    id: "beverages",
    text: ["Beverages"],
    x: 13.17,
    y: 2.35,
    z: -5.6,
    width: 2.6,
    height: 0.5,
    rotation: -Math.PI / 2,
  },
  { id: "billing", text: ["Billing Counter"], x: -10, y: 2.02, z: 1.4, width: 3, height: 0.5 },
  {
    id: "checkout-brand",
    text: ["KiranaCrew"],
    x: -12.4,
    y: 1.3,
    z: 3,
    width: 1.3,
    height: 0.48,
    rotation: Math.PI / 2,
  },
  { id: "stock", text: ["Stock & Supplies"], x: 4, y: 2.56, z: 1.58, width: 3.2, height: 0.5 },
] as const;

export const CAMERA_FRAME = { halfWidth: 15.5, halfHeight: 9.1, controlSpace: 82, targetZ: 0.4 };

// Fit the building, not the optional exterior planting; retain the original viewing direction.
export const PERSPECTIVE_VIEW = {
  fov: 42,
  elevation: 0.57,
  forward: 0.82,
  margin: 1.01,
  bounds: { x: 14.4, yMin: -0.6, yMax: 3.95, z: 9.35 },
};
/** Fit all cutaway corners, accounting for perspective depth rather than a flat rectangle. */
export function perspectiveDistance(aspect: number) {
  const { elevation: ey, forward: ez, bounds, margin, fov } = PERSPECTIVE_VIEW;
  const norm = Math.hypot(ey, ez),
    sy = ey / norm,
    sz = ez / norm;
  const tan = Math.tan((fov * Math.PI) / 360);
  let distance = 0;
  for (const y of [bounds.yMin - 0.8, bounds.yMax - 0.8]) {
    for (const z of [-bounds.z - CAMERA_FRAME.targetZ, bounds.z - CAMERA_FRAME.targetZ]) {
      const depth = y * sy + z * sz;
      const vertical = y * sz - z * sy;
      distance = Math.max(
        distance,
        depth + (Math.abs(vertical) * margin) / tan,
        depth + (bounds.x * margin) / (tan * Math.max(0.15, aspect)),
      );
    }
  }
  return distance;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface LabelAnchor {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export function overlaps(a: ScreenRect, b: ScreenRect, gap = 5) {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}
/** Deterministic camera-space packing; retains the shortest unobstructed head tether. */
export function placeLabels(
  anchors: LabelAnchor[],
  width: number,
  height: number,
  obstacles: ScreenRect[] = [],
) {
  const placed = new Map<string, ScreenRect>();
  const occupied = [...obstacles];
  for (const a of anchors) {
    const w = Math.min(a.width, Math.max(32, width - 12));
    const h = Math.min(a.height, Math.max(20, height - 12));
    const candidates: ScreenRect[] = [];
    for (const lift of [0, 46, 92, 138, -46, -92]) {
      for (const shift of [0, -w - 8, w + 8, -w / 2, w / 2]) {
        candidates.push({
          x: Math.max(6, Math.min(width - w - 6, a.x - w / 2 + shift)),
          y: Math.max(6, Math.min(height - h - 6, a.y - h - 10 - lift)),
          width: w,
          height: h,
        });
      }
    }
    // Dense small-screen scenes can use any free row rather than stack nameplates.
    for (let y = 6; y < height - h; y += h + 6) {
      for (let x = 6; x < width - w; x += w + 6) candidates.push({ x, y, width: w, height: h });
    }
    const free = candidates.filter((r) => occupied.every((o) => !overlaps(r, o)));
    const pool = free.length ? free : candidates;
    pool.sort(
      (l, r) =>
        Math.hypot(l.x + w / 2 - a.x, l.y + h - a.y) - Math.hypot(r.x + w / 2 - a.x, r.y + h - a.y),
    );
    const best = pool[0];
    if (!best) continue;
    placed.set(a.id, best);
    occupied.push(best);
  }
  return placed;
}
