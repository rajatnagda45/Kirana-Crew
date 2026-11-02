import { addWindowsAndExterior } from "./exterior";
import { DESK, WINDOWS, PLANTS, SOFA } from "../config/office-layout";
import * as THREE from "three";
import { OfficeAssets } from "./assets";
import { Furniture } from "./furniture";
import { worldPosition, facingAngle } from "./types";
import { CollisionRegistry } from "./navigation";
import type { SeatDef } from "../utils/MapHelpers";

// Original Tiled room footprint in pixels.
const rooms = [
  { x: 122, y: 145, w: 646, d: 448, wood: false }, // Zone A: Main Grocery Section
  { x: 768, y: 95, w: 500, d: 498, wood: false }, // Zone B: Fresh Produce & Dairy
  { x: 220, y: 593, w: 548, d: 289, wood: true }, // Zone C: Billing & Management
  { x: 816, y: 593, w: 356, d: 319, wood: true }, // Zone D: Stockroom
];

/** Pre-built collision map for the kirana store — populated once and shared with CrewSim. */
export function buildStoreCollisions(): CollisionRegistry {
  const c = new CollisionRegistry();
  const wp = (x: number, y: number) => worldPosition(x, y);
  const add = (id: string, px: number, py: number, w: number, d: number, rot = 0) => {
    const p = wp(px, py);
    c.add(id, p.x, p.z, w, d, rot);
  };
  // Back-wall grocery shelves (Zone A)
  for (const x of [230, 390, 560, 720]) add(`shelf-backA-${x}`, x, 192, 1.6, 0.7);
  // Gondola Row 1 (Zone A, y=305)
  for (const x of [240, 400, 560, 700]) add(`gondola1-${x}`, x, 305, 1.6, 0.7);
  // Gondola Row 2 (Zone A, y=432)
  for (const x of [250, 420, 600]) add(`gondola2-${x}`, x, 432, 1.6, 0.7);
  // Zone A/B boundary display
  add("spice-stand", 744, 210, 0.7, 0.6);
  // End-cap rack near Zone A entrance
  add("endcap", 680, 498, 1.3, 0.6);
  // Zone B back-wall shelves
  for (const [x] of [[900], [1100], [1220]]) add(`shelf-backB-${x}`, x as number, 148, 2.0, 0.7);
  // Produce island (Zone B)
  add("produce-island", 1010, 310, 2.8, 1.5);
  // Fresh produce displays
  add("produce-disp-1", 820, 285, 1.5, 0.7);
  add("produce-disp-2", 820, 430, 1.5, 0.7);
  // Dairy coolers
  add("cooler-1", 1195, 280, 2.6, 0.8);
  add("cooler-2", 1195, 460, 2.0, 0.8);
  // Beverage rack Zone B
  add("bev-rack", 870, 480, 1.5, 0.6);
  // Billing counter (Zone C)
  add("billing", 600, 750, 2.4, 1.0, Math.PI / 2);
  // Manager station (Zone C)
  add("manager-stn", 360, 740, 1.6, 1.0);
  // Store front awning
  add("storefront", 278, 866, 3.2, 1.0);
  // Metal storage racks (Zone D)
  add("stock-rack-1", 870, 640, 2.3, 1.0);
  add("stock-rack-2", 1090, 640, 2.3, 1.0);
  add("stock-rack-3", 1140, 780, 1.8, 1.0);
  return c;
}

export function buildEnvironment(a: OfficeAssets, seats: SeatDef[]) {
  const root = new THREE.Group();
  const f = new Furniture(a);
  const at = (x: number, y: number) => worldPosition(x, y);
  const put = (x: number, y: number, fn: (x: number, z: number) => void) => {
    const p = at(x, y);
    fn(p.x, p.z);
  };

  // ── Floors ────────────────────────────────────────────────
  for (const room of rooms) {
    const p = at(room.x + room.w / 2, room.y + room.d / 2);
    a.box(root, p.x, -0.23, p.z, room.w / 48, 0.42, room.d / 48, "#252e30");
    const tile = room.wood ? 24 : 48;
    for (let x = room.x; x < room.x + room.w; x += tile)
      for (let y = room.y; y < room.y + room.d; y += 48) {
        const w = Math.min(tile, room.x + room.w - x),
          d = Math.min(48, room.y + room.d - y);
        const t = at(x + w / 2, y + d / 2);
        a.box(
          root,
          t.x,
          0.003,
          t.z,
          (w - 0.15) / 48,
          0.045,
          (d - 0.15) / 48,
          a.texture(room.wood ? "floorwood" : "stone"),
        );
      }
  }

  // ── Walls ─────────────────────────────────────────────────
  const wall = (x: number, y: number, w: number, d: number, h = 1.9) => {
    const p = at(x + w / 2, y + d / 2);
    a.box(root, p.x, h / 2, p.z, w / 48, h, d / 48, "#b6ad96");
    a.box(root, p.x, h + 0.04, p.z, w / 48 + 0.035, 0.08, d / 48 + 0.035, "#363b37");
    a.box(root, p.x, 0.12, p.z, w / 48 + 0.03, 0.15, d / 48 + 0.03, "#625c49");
    if (w > d)
      a.box(
        root,
        p.x,
        h - 0.13,
        p.z + d / 96 + 0.015,
        w / 48 - 0.12,
        0.035,
        0.035,
        a.glow("#ffc87b", 2),
      );
  };
  wall(122, 145, 646, 9);
  wall(768, 95, 500, 9);
  wall(768, 95, 9, 195);
  wall(122, 145, 9, WINDOWS[0].y - 145, 0.75);
  wall(122, WINDOWS[0].y + WINDOWS[0].width, 9, 593 - WINDOWS[0].y - WINDOWS[0].width, 0.75);
  wall(1259, 95, 9, WINDOWS[1].y - 95, 1.7);
  wall(1259, WINDOWS[1].y + WINDOWS[1].width, 9, 593 - WINDOWS[1].y - WINDOWS[1].width, 1.7);
  wall(122, 584, 405, 9, 0.36);
  wall(577, 584, 191, 9, 0.36);
  wall(768, 287, 240, 9, 0.85);
  wall(768, 481, 9, 401, 1.2);
  wall(220, 593, 307, 9, 1.55);
  wall(577, 593, 191, 9, 1.55);
  wall(220, 593, 9, 289, 0.48);
  wall(220, 873, 548, 9, 0.32);
  wall(816, 593, 144, 9, 1.55);
  wall(1008, 593, 164, 9, 1.55);
  wall(816, 593, 9, 319, 0.6);
  wall(1163, 593, 9, 319, 0.7);
  wall(816, 903, 356, 9, 0.32);

  // ══════════════════════════════════════════════════════════
  // ZONE A — Main Grocery Section (upper-left)
  // ══════════════════════════════════════════════════════════

  // KiranaCrew flagship sign on back wall (visible above gondola rows)
  put(300, 158, (px, pz) => f.storeSign(root, px, pz, 2.8, "KiranaCrew", "General Store"));

  // Back-wall grocery shelves (wall-mounted, spaced apart — NOT blocking aisle)
  // These face into the store (toward viewer) and sit against the y=145 back wall
  for (const x of [230, 390, 560, 720])
    put(x, 192, (px, pz) => f.groceryRack(root, px, pz, 1.45, 0.44));

  // Gondola aisle ROW 1 — y=300, two-sided, runs E-W
  // Characters walk between row 1 and back wall (y≈200-280 = front aisle path)
  for (const x of [240, 400, 560, 700]) put(x, 305, (px, pz) => f.gondolaShelf(root, px, pz, 1.45));

  // Gondola aisle ROW 2 — y=430
  // Characters walk between row 1 and row 2 (y≈330-400 = middle aisle path)
  for (const x of [250, 420, 600]) put(x, 432, (px, pz) => f.gondolaShelf(root, px, pz, 1.45));

  // Ceiling hanging zone signs — positioned IN the aisle area, clearly above shelves
  // Groceries section — above left aisle (between back wall and Row 1)
  put(305, 248, (px, pz) => f.ceilingSign(root, px, pz, "Groceries", 1.9));
  // Snacks & Biscuits — above center aisle
  put(490, 248, (px, pz) => f.ceilingSign(root, px, pz, "Snacks & Biscuits", 2.4));
  // Household — above right aisle
  put(670, 248, (px, pz) => f.ceilingSign(root, px, pz, "Household", 1.9));

  // Small promotional end-cap rack near Zone A entrance (left side, y=500)
  put(680, 498, (px, pz) => f.groceryRack(root, px, pz, 1.1, 0.44));
  put(680, 498, (px, pz) => {
    // Impulse-buy items on top
    for (let i = 0; i < 4; i++)
      a.box(
        root,
        px - 0.15 + i * 0.1,
        1.5,
        pz - 0.05,
        0.08,
        0.15,
        0.1,
        ["#f5a020", "#40b040", "#e03020", "#6040c0"][i],
      );
  });

  // Zone A/B boundary display stand (spice & oil section)
  put(744, 210, (px, pz) => {
    a.box(root, px, 0.62, pz, 0.54, 1.18, 0.46, "#5c3a1f");
    a.box(root, px, 1.22, pz, 0.58, 0.06, 0.5, "#4a2c14");
    for (let i = 0; i < 4; i++) {
      const colors = ["#e8a030", "#40a040", "#d02020", "#3060b0"];
      a.box(
        root,
        px - 0.1 + (i % 2) * 0.2,
        1.38 + Math.floor(i / 2) * 0.24,
        pz,
        0.14,
        0.22,
        0.36,
        colors[i],
      );
    }
  });

  // ══════════════════════════════════════════════════════════
  // ZONE B — Fresh Produce & Dairy (upper-right)
  // ══════════════════════════════════════════════════════════

  // Back-wall shelves (beverages, snacks)
  for (const [x, w] of [
    [900, 2.2],
    [1100, 1.5],
    [1220, 1.3],
  ])
    put(x, 148, (px, pz) => f.groceryRack(root, px, pz, w as number, 0.44));

  // Ceiling hanging signs for Zone B
  put(900, 135, (px, pz) => f.ceilingSign(root, px, pz, "Fresh Produce", 2.2));
  put(1150, 135, (px, pz) => f.ceilingSign(root, px, pz, "Dairy & Milk", 2.0));

  // LARGE Fresh Produce Island — center of Zone B (the visual star of this zone)
  put(1010, 310, (px, pz) => f.produceIsland(root, px, pz, 2.6, 1.3));

  // Additional produce display stands flanking the island
  put(820, 285, (px, pz) => f.fresProduceDisplay(root, px, pz, 1.3));
  put(820, 430, (px, pz) => f.fresProduceDisplay(root, px, pz, 1.3));

  // Dairy & refrigerated cooler section (right wall of Zone B)
  put(1195, 280, (px, pz) => f.cooler(root, px, pz, 2.4));
  put(1195, 460, (px, pz) => f.cooler(root, px, pz, 1.8));

  // Zone B floor rug / customer path marker
  put(1010, 480, (x, z) => a.box(root, x, 0.035, z, 1.6, 0.035, 2.5, a.texture("rug")));

  // Beverage rack in Zone B center
  put(870, 480, (px, pz) => f.groceryRack(root, px, pz, 1.3, 0.44));

  // ══════════════════════════════════════════════════════════
  // ZONE C — Billing & Management (lower-left)
  // ══════════════════════════════════════════════════════════

  // Store entrance — placed at bottom-left of Zone C, awning faces outward (+Z)
  // y=865 is near the bottom wall (y=873); awning at z+1 extends outside the store
  put(278, 866, (px, pz) => f.storeFront(root, px, pz, 3.0));

  // Shopping baskets and cart near entrance (left side of Zone C)
  put(230, 840, (px, pz) => f.shoppingCart(root, px, pz));
  put(230, 815, (px, pz) => f.shoppingCart(root, px + 0.08, pz));
  // Basket stack
  for (let i = 0; i < 3; i++)
    put(250, 770, (px, pz) => a.box(root, px, 0.38 + i * 0.18, pz, 0.55, 0.16, 0.38, "#cc3010"));

  // "Billing Counter" ceiling sign over checkout area
  put(510, 618, (px, pz) => f.ceilingSign(root, px, pz, "Billing Counter", 2.2));
  // "Store Operations" ceiling sign over management area
  put(330, 618, (px, pz) => f.ceilingSign(root, px, pz, "Store Operations", 2.4));

  // Main billing / checkout counter (Frank's position)
  // Placed prominently at right-center of Zone C
  put(600, 750, (x, z) => f.billingCounter(root, x, z, Math.PI / 2));

  // Manager station — Alice coordinates from here (left-center of Zone C)
  put(360, 740, (x, z) => f.managerStation(root, x, z, 0));

  // Customer waiting bench
  put(SOFA.x, SOFA.y, (x, z) => f.waitingBench(root, x, z));

  // Zone C warm accent light over billing area
  put(510, 700, (px, pz) => {
    a.box(root, px, 2.1, pz, 1.8, 0.06, 0.28, "#2c6e49");
    a.box(root, px, 2.1, pz + 0.15, 1.6, 0.36, 0.04, "#2c6e49");
    a.box(root, px, 2.1, pz + 0.17, 1.4, 0.26, 0.022, a.glow("#f0c840", 0.28));
  });

  // ══════════════════════════════════════════════════════════
  // ZONE D — Stockroom & Warehouse (lower-right)
  // ══════════════════════════════════════════════════════════

  // "Stock & Supplies" ceiling sign
  put(990, 618, (px, pz) => f.ceilingSign(root, px, pz, "Stock & Supplies", 2.2));

  // Industrial metal storage racks along walls
  put(870, 640, (px, pz) => f.metalStorageShelf(root, px, pz, 2.1, 4));
  put(1090, 640, (px, pz) => f.metalStorageShelf(root, px, pz, 2.1, 4));
  put(1140, 780, (px, pz) => f.metalStorageShelf(root, px, pz, 1.6, 3));

  // Hand truck / pallet jack
  put(970, 720, (px, pz) => f.handTruck(root, px, pz));

  // Procurement terminal (supplier analytics)
  put(1050, 720, (x, z) => {
    f.table(root, x, z, 1.6);
    a.box(root, x, 1.28, z - 0.19, 1.15, 0.68, 0.075, "#29373f");
    a.box(root, x, 1.28, z - 0.146, 1.0, 0.54, 0.018, a.texture("screen"));
  });

  // Rice, dal, wheat sacks in warehouse corner
  put(858, 840, (x, z) => {
    f.storageSack(root, x - 0.44, z, "#e8d4a0");
    f.storageSack(root, x + 0.44, z, "#d4c490");
    f.storageSack(root, x, z - 0.56, "#c8b878");
  });

  // Flour sacks (larger)
  put(855, 775, (x, z) => {
    f.storageSack(root, x - 0.3, z, "#f0ece4");
    f.storageSack(root, x + 0.3, z + 0.22, "#e8e4dc");
  });

  // Oil containers
  put(920, 800, (px, pz) => {
    for (let i = 0; i < 3; i++) f.oilContainer(root, px - 0.28 + i * 0.28, pz);
  });

  // Delivery carton stacks
  put(1060, 850, (x, z) => f.crateStack(root, x, z, 3));
  put(1110, 800, (x, z) => {
    f.crateStack(root, x - 0.44, z, 2);
    f.crateStack(root, x + 0.44, z, 2);
  });
  put(1110, 860, (x, z) => f.crateStack(root, x, z, 2));

  // ── Agent workstations (zone-aware seat loop) ────────────
  for (const seat of seats) {
    const p = at(seat.x, seat.y + DESK.feetOffset);
    const angle = facingAngle[seat.facing];
    const deskP = {
      x: p.x + (Math.sin(angle) * DESK.offset) / 48,
      z: p.z + (Math.cos(angle) * DESK.offset) / 48,
    };
    if (seat.y >= 593) {
      // Zone C/D: small counter workstation + chair
      f.managerCounter(root, deskP.x, deskP.z, angle + Math.PI);
      f.chair(root, p.x, p.z, angle + Math.PI, "#2d5a40");
    }
    // Zone A/B: agents stand freely in aisles — no desk, no chair
  }

  // ── Plants (throughout all zones) ────────────────────────
  for (const [x, y, s] of PLANTS) put(x, y, (px, pz) => f.plant(root, px, pz, s));

  // ── Warm ceiling sconces ──────────────────────────────────
  for (const [x, y] of [
    [151, 165],
    [380, 165],
    [640, 165],
    [840, 115],
    [1050, 115],
    [1220, 115],
    [280, 618],
    [520, 618],
    [690, 618],
    [860, 618],
    [1100, 618],
  ])
    put(x, y, (px, pz) => {
      a.box(root, px, 1.82, pz, 0.18, 0.26, 0.14, "#625840");
      a.round(root, px, 1.88, pz + 0.1, 0.09, 0.12, a.glow("#ffe0a2", 2.2));
    });

  addWindowsAndExterior(root, a);
  bakeInstances(root);
  return root;
}

function bakeInstances(root: THREE.Group) {
  root.updateMatrixWorld(true);
  const batches = new Map<
    string,
    { geometry: THREE.BufferGeometry; material: THREE.Material; matrices: THREE.Matrix4[] }
  >();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && !Array.isArray(object.material)) {
      const key = object.geometry.uuid + object.material.uuid;
      let batch = batches.get(key);
      if (!batch) {
        batch = { geometry: object.geometry, material: object.material, matrices: [] };
        batches.set(key, batch);
      }
      batch.matrices.push(object.matrixWorld.clone());
    }
  });
  root.clear();
  for (const batch of batches.values()) {
    const mesh = new THREE.InstancedMesh(batch.geometry, batch.material, batch.matrices.length);
    batch.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.castShadow = !batch.material.transparent;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}
