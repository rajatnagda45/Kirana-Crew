import * as THREE from "three";
import { OfficeAssets } from "./assets";
import { CollisionRegistry } from "./navigation";
import { PRODUCT_CATALOG, productVisual } from "./products";
import { SIGN_STYLE, STORE_SIGNS } from "./scene-config";
import { createPackageGeometries } from "./package-geometry";

/** Builds the KiranaCrew general store: shopping floor, produce & dairy, billing, operations and stockroom. */

type Rand = () => number;
function rng(seed: number): Rand {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const HEADING_FONT = `"Baloo 2", "Trebuchet MS", sans-serif`;

/** Collects many small meshes and emits one InstancedMesh (keeps draw calls low for dense shelves). */
class Batch {
  private items: Array<{ m: THREE.Matrix4; c: THREE.Color }> = [];
  private tmp = new THREE.Object3D();
  private variants = new Map<THREE.BufferGeometry, Batch>();
  constructor(
    private geometry: THREE.BufferGeometry,
    private material: THREE.Material,
    private shadows = true,
  ) {}
  add(
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    color: string,
    ry = 0,
    rz = 0,
  ) {
    this.tmp.position.set(x, y, z);
    this.tmp.rotation.set(0, ry, rz);
    this.tmp.scale.set(sx, sy, sz);
    this.tmp.updateMatrix();
    this.items.push({ m: this.tmp.matrix.clone(), c: new THREE.Color(color) });
  }
  flush(parent: THREE.Object3D) {
    this.variants.forEach((batch) => batch.flush(parent));
    if (!this.items.length) return;
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, this.items.length);
    this.items.forEach((it, i) => {
      mesh.setMatrixAt(i, it.m);
      mesh.setColorAt(i, it.c);
    });
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = true;
    parent.add(mesh);
    this.items = [];
  }
  package(
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    color: string,
  ) {
    let batch = this.variants.get(geometry);
    if (!batch) {
      batch = new Batch(geometry, this.material, this.shadows);
      this.variants.set(geometry, batch);
    }
    batch.add(x, y, z, w, h, d, color);
  }
}

const PALETTES = {
  grocery: [
    "#e94f37",
    "#f6c344",
    "#f18f01",
    "#c73e1d",
    "#3bb273",
    "#f4e3b5",
    "#2e86ab",
    "#d9a441",
    "#b5442c",
  ],
  snacks: [
    "#ffd23f",
    "#ee4266",
    "#3bceac",
    "#0ead69",
    "#f77f00",
    "#1b98e0",
    "#e63946",
    "#ffb703",
    "#fb8500",
  ],
  household: [
    "#1b98e0",
    "#48cae4",
    "#ef476f",
    "#06d6a0",
    "#ffd166",
    "#f8f9fa",
    "#118ab2",
    "#e76f51",
    "#90be6d",
  ],
  beverage: ["#e63946", "#2a9d8f", "#f4a261", "#264653", "#e9c46a", "#f1faee", "#06d6a0"],
  dairy: ["#f8f9fa", "#4cc9f0", "#ffd166", "#f1faee", "#90e0ef", "#e9ecef", "#ef476f"],
  stock: ["#c79a5b", "#b98a4e", "#d6aa6a", "#a77b45", "#e3bf86"],
};
type PaletteKey = keyof typeof PALETTES;

/** Recognizable Indian product names printed on package fronts (visual labels only, not inventory data). */
const PRODUCT_NAMES: Partial<Record<PaletteKey, string[]>> = {
  grocery: ["Atta", "Rice", "Toor Dal", "Sugar", "Salt", "Rava", "Poha", "Maida"],
  snacks: ["Parle-G", "Maggi", "Lays", "Kurkure", "Oreo", "Choco Pie", "Namkeen"],
  household: ["Surf", "Vim", "Dettol", "Colgate", "Lux", "Harpic", "Soap"],
  beverage: ["Frooti", "Pepsi", "Sprite", "Bisleri", "Real", "Coke"],
  dairy: ["Milk", "Curd", "Butter", "Paneer", "Ghee", "Cheese"],
};

export function signTexture(
  lines: string[],
  opts: { w?: number; h?: number; bg?: string; fg?: string; border?: string; sub?: string } = {},
) {
  const w = opts.w ?? 512;
  const h = opts.h ?? 160;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext("2d");
  if (!c) throw new Error("Sign canvas unavailable");
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, opts.bg ?? "#3a2414");
  g.addColorStop(1, "#1d120a");
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  c.strokeStyle = opts.border ?? "#f2b441";
  c.lineWidth = Math.max(8, h * 0.07);
  c.strokeRect(c.lineWidth / 2, c.lineWidth / 2, w - c.lineWidth, h - c.lineWidth);
  c.fillStyle = opts.fg ?? "#fff3d6";
  c.textAlign = "center";
  c.textBaseline = "middle";
  if (lines.length === 1) {
    let size = Math.floor(h * 0.52);
    c.font = `800 ${size}px ${HEADING_FONT}`;
    while (c.measureText(lines[0] ?? "").width > w * (1 - SIGN_STYLE.padding * 2) && size > 12)
      c.font = `800 ${--size}px ${HEADING_FONT}`;
    c.fillText(lines[0] ?? "", w / 2, h / 2 + h * 0.02);
  } else {
    c.font = `800 ${Math.floor(h * 0.3)}px ${HEADING_FONT}`;
    c.fillText(lines[0] ?? "", w / 2, h * 0.36, w * 0.88);
    c.fillStyle = opts.sub ?? "#ffd27a";
    c.font = `700 ${Math.floor(h * 0.22)}px ${HEADING_FONT}`;
    c.fillText(lines[1] ?? "", w / 2, h * 0.7, w * 0.88);
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function canvasTexture(
  w: number,
  h: number,
  draw: (c: CanvasRenderingContext2D) => void,
  repeat?: [number, number],
) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Texture canvas unavailable");
  draw(context);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

export interface StoreBuild {
  group: THREE.Group;
  lampPositions: THREE.Vector3[];
  zones: Array<{ id: string; mesh: THREE.Mesh }>;
  spinners: THREE.Object3D[];
  collisions: CollisionRegistry;
}

export function buildStore(a: OfficeAssets): StoreBuild {
  const root = new THREE.Group();
  const collisions = new CollisionRegistry();
  const solid = (id: string, x: number, z: number, w: number, d: number, ry = 0) =>
    collisions.add(id, x, z, w, d, ry);
  const rand = rng(4242);
  const packageGeometries = createPackageGeometries();
  const lampPositions: THREE.Vector3[] = [];
  const disposables: THREE.Texture[] = [];
  const productMat = new THREE.MeshStandardMaterial({ roughness: 0.55 });
  const glossMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.05 });
  const produceMat = new THREE.MeshStandardMaterial({ roughness: 0.42 });
  const roundGeo = new THREE.SphereGeometry(1, 10, 8);
  const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 10);

  // Recognizable Indian product labels (instanced planes on package fronts).
  const labelGeo = new THREE.PlaneGeometry(1, 1);
  const labelMats: THREE.Material[] = [];
  const labelTexs = new Map<string, THREE.Texture>();
  const labelTex = (name: string) => {
    let t = labelTexs.get(name);
    if (t) return t;
    const shelfTag = name.startsWith("shelf:");
    const title = shelfTag ? name.slice(6) : name;
    const visual = productVisual(title);
    if (shelfTag) {
      t = canvasTexture(512, 128, (c) => {
        c.fillStyle = "#faf4df";
        c.fillRect(0, 0, 512, 128);
        c.fillStyle = visual?.color ?? "#3b604c";
        c.fillRect(0, 0, 16, 128);
        c.fillStyle = "#252d28";
        c.font = `800 52px ${HEADING_FONT}`;
        c.fillText(title, 30, 79, 360);
        c.fillStyle = "#65685c";
        c.font = `700 32px ${HEADING_FONT}`;
        c.fillText("—", 442, 80);
      });
      labelTexs.set(name, t);
      disposables.push(t);
      return t;
    }
    t = canvasTexture(512, 640, (c) => {
      c.scale(2, 2);
      const color = visual?.color ?? "#ad783e";
      c.fillStyle = color;
      c.fillRect(0, 0, 256, 320);
      const sheen = c.createLinearGradient(0, 0, 256, 0);
      sheen.addColorStop(0, "rgba(0,0,0,.16)");
      sheen.addColorStop(0.35, "rgba(255,255,255,.12)");
      sheen.addColorStop(1, "rgba(0,0,0,.2)");
      c.fillStyle = sheen;
      c.fillRect(0, 0, 256, 320);
      c.fillStyle = "#fff7da";
      c.beginPath();
      c.ellipse(128, 80, 116, 54, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#23362a";
      c.textAlign = "center";
      c.font = `800 36px ${HEADING_FONT}`;
      c.fillText(name, 128, 94, 214);
      c.fillStyle = "#f5d36f";
      c.font = `700 18px ${HEADING_FONT}`;
      c.fillText("PREMIUM QUALITY", 128, 143);
      c.fillStyle = "#f7ebba";
      if (visual?.motif === "milk") {
        c.fillStyle = "#dceff8";
        c.fillRect(38, 165, 180, 70);
        c.fillStyle = "#2874a0";
        c.font = `800 28px ${HEADING_FONT}`;
        c.fillText("DAIRY", 128, 210);
      } else if (visual?.motif === "clean") {
        c.strokeStyle = "#e6f7fb";
        c.lineWidth = 5;
        for (let j = 0; j < 4; j++) {
          c.beginPath();
          c.arc(72 + j * 34, 195 + (j % 2) * 17, 15, 0, Math.PI * 2);
          c.stroke();
        }
      } else {
        for (let i = 0; i < 18; i++) {
          const x = 65 + (i % 6) * 24,
            y = 178 + Math.floor(i / 6) * 20;
          c.beginPath();
          c.ellipse(x, y, visual?.motif === "grain" ? 9 : 12, 6, -0.5, 0, Math.PI * 2);
          c.fill();
        }
      }
      c.fillStyle = "#fff7e2";
      c.fillRect(16, 256, 224, 38);
      c.fillStyle = "#394439";
      c.font = `700 17px ${HEADING_FONT}`;
      c.fillText("FRESH • SELECT", 128, 281);
      for (let i = 0; i < 34; i++) {
        c.fillStyle = i % 3 ? "#1e2520" : "#fff7e2";
        c.fillRect(166 + i * 2, 298, 1.5, 18);
      }
    });
    labelTexs.set(name, t);
    disposables.push(t);
    return t;
  };
  type LabelBatches = Map<THREE.Texture, Batch>;
  const newLabelBatches = (): LabelBatches => new Map();
  const addLabel = (
    labels: LabelBatches,
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
  ) => {
    const tex = labelTex(name);
    let b = labels.get(tex);
    if (!b) {
      const m = new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.6,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      });
      labelMats.push(m);
      b = new Batch(labelGeo, m, false);
      labels.set(tex, b);
    }
    b.add(x, y, z, w, h, 1, "#ffffff");
  };
  const flushLabels = (labels: LabelBatches, parent: THREE.Object3D) =>
    labels.forEach((b) => b.flush(parent));
  const spinners: THREE.Object3D[] = [];
  const zoneMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const zones: Array<{ id: string; mesh: THREE.Mesh }> = [];
  const zone = (id: string, x: number, z: number, w: number, d: number, h = 2.4) => {
    const m = new THREE.Mesh(a.flatCube, zoneMat);
    m.position.set(x, h / 2, z);
    m.scale.set(w, h, d);
    m.userData["zoneId"] = id;
    root.add(m);
    zones.push({ id, mesh: m });
  };

  const wood = a.texture("wood");
  const woodDark = a.material("#6b4424", 0.72);
  const woodLight = a.material("#c08a52", 0.68);
  const metal = a.material("#8e969c", 0.45, 0.55);

  // One shared, instanced occlusion decal beneath each floor-standing fixture.
  const contactTex = canvasTexture(64, 64, (c) => {
    const shade = c.createRadialGradient(32, 32, 8, 32, 32, 32);
    shade.addColorStop(0, "rgba(32,23,16,.24)");
    shade.addColorStop(1, "rgba(32,23,16,0)");
    c.fillStyle = shade;
    c.fillRect(0, 0, 64, 64);
  });
  disposables.push(contactTex);
  const contactGeo = new THREE.PlaneGeometry(1, 1);
  contactGeo.rotateX(-Math.PI / 2);
  const contactMat = new THREE.MeshBasicMaterial({
    map: contactTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });

  // ---------- floor ----------
  const tile = canvasTexture(
    256,
    256,
    (c) => {
      c.fillStyle = "#e9dcc6";
      c.fillRect(0, 0, 256, 256);
      const r = rng(9);
      for (let i = 0; i < 1800; i++) {
        c.fillStyle = `rgba(${r() > 0.5 ? "255,250,240" : "150,120,90"},${r() * 0.07})`;
        c.fillRect(r() * 256, r() * 256, 2 + r() * 6, 2);
      }
      c.strokeStyle = "#cdbb9e";
      c.lineWidth = 4;
      c.strokeRect(0, 0, 256, 256);
    },
    [28, 18],
  );
  disposables.push(tile);
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(28, 0.3, 18),
    new THREE.MeshStandardMaterial({ map: tile, roughness: 0.55 }),
  );
  floor.position.set(0, -0.15, 0);
  floor.receiveShadow = true;
  root.add(floor);
  // base plinth
  a.box(root, 0, -0.42, 0, 28.6, 0.3, 18.6, "#2b211a");

  // ---------- walls ----------
  const wallTex = canvasTexture(256, 256, (c) => {
    c.fillStyle = "#895b35";
    c.fillRect(0, 0, 256, 256);
    const grain = rng(87);
    for (let i = 0; i < 160; i++) {
      c.fillStyle = `rgba(40,20,8,${grain() * 0.14})`;
      c.fillRect(grain() * 256, 0, 1 + grain() * 3, 256);
    }
    c.strokeStyle = "#583b24";
    c.lineWidth = 3;
    for (let y = 0; y < 256; y += 64) {
      c.strokeRect(0, y, 256, 64);
    }
    c.fillStyle = "#b8794a";
    c.fillRect(0, 196, 256, 60);
    c.fillStyle = "#8f5a33";
    c.fillRect(0, 190, 256, 8);
  });
  disposables.push(wallTex);
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85 });
  const capMat = a.material("#efe5d3", 0.6);
  const wall = (x1: number, z1: number, x2: number, z2: number, h: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const m = new THREE.Mesh(a.flatCube, wallMat);
    m.position.set((x1 + x2) / 2, h / 2, (z1 + z2) / 2);
    m.scale.set(len, h, 0.28);
    m.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
    m.castShadow = true;
    m.receiveShadow = true;
    root.add(m);
    solid("wall", m.position.x, m.position.z, len, 0.28, m.rotation.y);
    const cap = new THREE.Mesh(a.flatCube, capMat);
    cap.position.set(m.position.x, h + 0.04, m.position.z);
    cap.scale.set(len + 0.02, 0.08, 0.34);
    cap.rotation.y = m.rotation.y;
    root.add(cap);
  };
  const H = 2.9;
  const LOW = 0.55;
  wall(-14, -9, 14, -9, H); // back
  wall(-14, -9, -14, 9, H * 0.85); // left
  wall(14, -9, 14, 9, H * 0.85); // right
  wall(-14, 9, 14, 9, LOW); // front cutaway
  // vertical divider x=1.6, gap z -3.4..-1.4
  wall(1.6, -9, 1.6, -3.4, H);
  wall(1.6, -1.4, 1.6, 9, 1.4);
  // horizontal divider main/ops z=0.6, gap x -2.6..-0.4
  wall(-14, 0.6, -2.6, 0.6, 1.1);
  wall(-0.4, 0.6, 1.6, 0.6, 1.1);
  // produce/stock z=0.6, gap x 4.2..6.2
  wall(1.6, 0.6, 4.2, 0.6, 1.1);
  wall(6.2, 0.6, 14, 0.6, 1.1);

  // ---------- helpers ----------
  const sign = (
    text: string[],
    x: number,
    y: number,
    z: number,
    w0: number,
    h0: number,
    ry = 0,
    glowColor = "#f2b441",
  ) => {
    const w = w0;
    const h = Math.max(SIGN_STYLE.minimumHeight, h0);
    const tex = signTexture(text, {
      w: SIGN_STYLE.resolution,
      h: Math.round((SIGN_STYLE.resolution * h) / w),
    });
    disposables.push(tex);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = ry;
    const backing = a.box(g, 0, 0, -0.04, w + 0.08, h + 0.08, 0.06, a.material(glowColor, 0.65));
    backing.castShadow = false;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, toneMapped: false }),
    );
    plate.position.z = 0.001;
    g.add(plate);
    g.userData["signSize"] = { width: w, height: h };
    root.add(g);
    return g;
  };

  const fillShelfRow = (
    box: Batch,
    cyl: Batch,
    labels: LabelBatches,
    x0: number,
    x1: number,
    y: number,
    zBack: number,
    depth: number,
    palette: PaletteKey,
    maxH: number,
  ) => {
    const catalog = PRODUCT_CATALOG[palette];
    let x = x0 + 0.02,
      index = 0;
    while (x < x1 - 0.13) {
      const p = catalog[index % catalog.length];
      if (!p) break;
      const w = p.width,
        h = Math.min(maxH - 0.015, p.height),
        d = Math.min(depth * 0.78, p.depth);
      if (x + w > x1) break;
      const cx = x + w / 2,
        cz = zBack + depth * 0.65;
      box.package(packageGeometries[p.shape], cx, y + h / 2, cz, w, h, d, p.color);
      if (p.shape === "bottle") {
        cyl.add(cx, y + h * 0.96, cz, w * 0.26, h * 0.08, w * 0.26, "#eae2ca");
        for (const band of [0.17, 0.24, 0.31])
          cyl.add(cx, y + h * band, cz, w * 0.503, 0.008, d * 0.503, p.color);
      } else if (p.shape === "tin" || p.shape === "tub") {
        cyl.add(cx, y + h - 0.005, cz, w * 0.5, 0.012, d * 0.5, "#e3e4dc");
      } else if (p.shape === "bar") {
        for (const side of [-1, 1])
          box.add(cx + side * w * 0.46, y + h / 2, cz, w * 0.07, h * 0.88, d * 0.4, "#eddbac");
      } else {
        if (p.shape === "pouch") {
          box.add(cx, y + h - 0.008, cz, w * 0.94, 0.014, d * 0.28, "#eddbac");
          box.add(cx, y + 0.008, cz, w * 0.94, 0.014, d * 0.28, p.color);
        }
        if (p.shape === "carton")
          box.add(cx, y + h - 0.006, cz, w * 0.84, 0.008, d * 0.85, "#e9dcbc");
        if (p.shape === "gable")
          box.add(cx, y + h - 0.008, cz, w * 0.95, 0.014, d * 0.06, "#edf2ed");
      }
      const front = d / 2;
      addLabel(
        labels,
        p.name,
        cx,
        y + h * 0.52,
        cz + front + 0.004,
        w * 0.82,
        h * (p.shape === "bottle" ? 0.47 : 0.75),
      );
      addLabel(labels, `shelf:${p.name}`, cx, y - 0.035, zBack + depth + 0.044, w * 0.88, 0.05);
      // Two-deep facings keep shelves stocked without hiding the readable front row.
      if (depth > 0.35)
        box.package(
          packageGeometries[p.shape],
          cx,
          y + h / 2,
          zBack + depth * 0.2,
          w,
          h,
          d,
          p.color,
        );
      x += w + 0.025;
      index++;
    }
  };

  /** GroceryShelf: wooden open rack, back panel, densely stocked. Faces +z locally. */
  const groceryShelf = (
    x: number,
    z: number,
    ry: number,
    w: number,
    h: number,
    levels: number,
    palette: PaletteKey,
    light = true,
  ) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const d = 0.6;
    solid("shelf", x, z, w + 0.12, d, ry);
    const box = new Batch(a.cube, productMat, false);
    const cyl = new Batch(cylGeo, glossMat, false);
    const labels = newLabelBatches();
    a.box(g, 0, h / 2, -d / 2 + 0.03, w, h, 0.05, woodDark);
    for (const sx of [-1, 1]) {
      a.box(g, (sx * w) / 2, h / 2, 0, 0.07, h, d, wood);
      a.box(g, (sx * w) / 2, h / 2, d / 2 + 0.012, 0.025, h - 0.1, 0.022, metal);
    }
    a.box(g, 0, h + 0.03, 0, w + 0.1, 0.07, d + 0.06, woodLight);
    a.box(g, 0, 0.08, 0, w, 0.16, d, woodDark);
    const step = (h - 0.2) / levels;
    for (let i = 0; i < levels; i++) {
      const y = 0.16 + i * step;
      a.box(g, 0, y, 0, w - 0.04, 0.04, d, palette === "household" || !light ? metal : wood);
      // price strip
      a.box(g, 0, y + 0.01, d / 2 + 0.01, w - 0.06, 0.05, 0.015, i % 2 ? "#f6d365" : "#fff1cf");
      fillShelfRow(
        box,
        cyl,
        labels,
        -w / 2 + 0.05,
        w / 2 - 0.05,
        y + 0.02,
        -d / 2 + 0.06,
        d - 0.1,
        palette,
        step - 0.06,
      );
      if (light) a.box(g, 0, y + step - 0.045, 0.1, w - 0.15, 0.012, 0.02, a.glow("#fff0c8", 0.8));
    }
    if (light) a.box(g, 0, h - 0.03, d / 2 - 0.05, w - 0.1, 0.03, 0.03, a.glow("#ffd89a", 1.6));
    box.flush(g);
    cyl.flush(g);
    flushLabels(labels, g);
    root.add(g);
    return g;
  };

  /** Double-sided gondola aisle unit in the middle of the floor. */
  const gondola = (x: number, z: number, w: number, palette: PaletteKey) => {
    groceryShelf(x, z - 0.32, Math.PI, w, 1.25, 3, palette, false);
    groceryShelf(x, z + 0.32, 0, w, 1.25, 3, palette, false);
    for (const sx of [-1, 1])
      a.box(root, x + sx * (w / 2 + 0.06), 0.65, z, 0.06, 1.3, 1.28, "#f2b441");
  };

  const plant = (x: number, z: number, s = 1) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    if (x > -14 && x < 14) solid("planter", x, z, 0.5 * s, 0.5 * s);
    a.cylinderMesh(g, 0, 0.22, 0, 0.24, 0.44, "#e9e2d4");
    a.cylinderMesh(g, 0, 0.45, 0, 0.21, 0.04, "#4a3324");
    const leaves = new Batch(a.leaf, a.material("#4c8a3a", 0.75));
    for (let i = 0; i < 9; i++) {
      const ang = (i / 9) * Math.PI * 2;
      leaves.add(
        Math.cos(ang) * 0.22,
        0.75 + (i % 3) * 0.14,
        Math.sin(ang) * 0.22,
        0.12,
        0.32,
        0.06,
        i % 2 ? "#4c8a3a" : "#6aa84f",
        ang,
        0.5,
      );
    }
    leaves.add(0, 1.05, 0, 0.1, 0.36, 0.06, "#5d9b44");
    leaves.flush(g);
    root.add(g);
  };

  const pendant = (x: number, z: number, y = 2.75) => {
    lampPositions.push(new THREE.Vector3(x, y - 0.2, z));
  };

  const acUnit = (x: number, z: number) => {
    a.box(root, x, 2.55, z, 1.3, 0.34, 0.28, a.material("#f1f1ee", 0.27));
    a.box(root, x, 2.44, z + 0.14, 1.1, 0.07, 0.02, "#535d61");
    for (let i = 0; i < 4; i++)
      a.box(root, x, 2.42 + i * 0.017, z + 0.158, 1.07, 0.007, 0.025, "#c8c8c4");
    a.box(root, x + 0.43, 2.54, z + 0.149, 0.045, 0.017, 0.008, a.glow("#8accb4", 0.6));
  };

  const fan = (x: number, z: number) => {
    const g = new THREE.Group();
    g.position.set(x, 2.74, z);
    a.cylinderMesh(g, 0, 0.12, 0, 0.03, 0.24, "#d8d2c4");
    a.cylinderMesh(g, 0, 0.27, 0, 0.13, 0.035, "#b5a38b");
    const blades = new THREE.Group();
    blades.position.y = -0.02;
    a.cylinderMesh(blades, 0, 0, 0, 0.09, 0.06, "#e8e2d4");
    a.cylinderMesh(blades, 0, -0.045, 0, 0.065, 0.035, "#c7b394");
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      const b = a.box(
        blades,
        Math.cos(ang) * 0.42,
        0,
        Math.sin(ang) * 0.42,
        0.7,
        0.02,
        0.14,
        "#e8e2d4",
      );
      b.rotation.y = -ang;
      b.castShadow = false;
    }
    g.add(blades);
    spinners.push(blades);
    root.add(g);
  };

  const cctv = (x: number, z: number, ry: number) => {
    const g = new THREE.Group();
    g.position.set(x, 2.5, z);
    g.rotation.y = ry;
    a.box(g, 0, 0.12, 0, 0.06, 0.24, 0.06, "#d8d2c4");
    const cam = a.box(g, 0, -0.04, 0.12, 0.12, 0.12, 0.3, "#f1f1ee");
    cam.rotation.x = 0.35;
    a.box(g, 0, -0.09, 0.27, 0.05, 0.05, 0.02, a.glow("#e63946", 1.5));
    root.add(g);
  };

  const dustbin = (x: number, z: number, color = "#3b6ea5") => {
    solid("dustbin", x, z, 0.44, 0.44);
    a.cylinderMesh(root, x, 0.28, z, 0.2, 0.56, color);
    a.cylinderMesh(root, x, 0.58, z, 0.22, 0.05, "#2b2b2b");
  };

  // ---------- SECTION A: MAIN SHOPPING FLOOR (x -14..1.6, z -9..0.6) ----------
  // Storefront branding at back-left
  // striped awning
  for (let i = 0; i < 10; i++) {
    const m = a.box(
      root,
      -12.2 + i * 0.355,
      2.74,
      -8.5,
      0.355,
      0.06,
      0.8,
      i % 2 ? "#fbf3e4" : "#d62828",
    );
    m.rotation.x = 0.35;
  }
  for (let i = 0; i < 10; i++)
    a.box(root, -12.2 + i * 0.355, 2.56, -8.08, 0.355, 0.12, 0.04, i % 2 ? "#fbf3e4" : "#d62828");
  // shelves under brand sign
  groceryShelf(-10.6, -8.45, 0, 3.4, 1.35, 3, "grocery");
  // back wall category runs
  groceryShelf(-6.9, -8.5, 0, 2.6, 2.1, 5, "grocery");
  groceryShelf(-3.5, -8.5, 0, 3.2, 2.1, 5, "snacks");
  groceryShelf(-0.2, -8.5, 0, 2.6, 2.1, 5, "household");
  // left wall shelves
  groceryShelf(-13.55, -5.6, Math.PI / 2, 2.6, 1.6, 4, "grocery");
  groceryShelf(-13.55, -2.4, Math.PI / 2, 2.6, 1.6, 4, "household");
  // middle gondolas
  gondola(-9.4, -5.0, 3.6, "snacks");
  gondola(-4.6, -5.4, 3.0, "grocery");
  // spice / staples end cap
  groceryShelf(-6.6, -1.5, 0, 1.5, 1.1, 3, "household", false);
  // central produce island (bananas, tomatoes, apples)
  const produce = new Batch(roundGeo, produceMat);
  const crate = (
    x: number,
    z: number,
    w: number,
    d: number,
    kind: "tomato" | "banana" | "apple" | "orange" | "onion" | "potato" | "greens",
    tilt = 0.18,
    base = 0.55,
  ) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    solid("produce crate", x, z, w + 0.08, d + 0.08);
    root.add(g);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        a.box(g, (sx * w) / 2.1, base / 2, (sz * d) / 2.1, 0.06, base, 0.06, woodDark);
    const top = new THREE.Group();
    top.position.y = base;
    top.rotation.x = tilt;
    g.add(top);
    a.box(top, 0, 0, 0, w, 0.06, d, wood);
    for (const sz of [-1, 1]) a.box(top, 0, 0.09, (sz * d) / 2, w, 0.14, 0.04, woodLight);
    for (const sx of [-1, 1]) a.box(top, (sx * w) / 2, 0.09, 0, 0.04, 0.14, d, woodLight);
    top.updateMatrixWorld(true);
    g.updateMatrixWorld(true);
    const colors: Record<string, string[]> = {
      tomato: ["#d62828", "#e63946", "#c1121f"],
      apple: ["#6ab04c", "#7bc043", "#5a9a3a"],
      orange: ["#f77f00", "#fb8500", "#f4a261"],
      onion: ["#9d4a5a", "#b5646f", "#8a3b4a"],
      potato: ["#b08950", "#9c7a45", "#c29a5e"],
      banana: ["#f6d743", "#ffd60a", "#f2c94c"],
      greens: ["#2d6a4f", "#40916c", "#52b788"],
    };
    const v = new THREE.Vector3();
    const r = kind === "banana" ? 0.06 : kind === "greens" ? 0.11 : 0.085;
    for (let layer = 0; layer < 2; layer++)
      for (let ix = -w / 2 + r + 0.04; ix < w / 2 - r; ix += r * 2)
        for (let iz = -d / 2 + r + 0.04; iz < d / 2 - r; iz += r * 2) {
          v.set(ix + layer * r * 0.6, 0.05 + r + layer * r * 1.3, iz + layer * r * 0.6);
          if (layer && rand() < 0.35) continue;
          top.localToWorld(v);
          g.worldToLocal(v);
          const c = colors[kind]![Math.floor(rand() * 3)]!;
          const wp = v.clone().add(g.position);
          if (kind === "banana")
            produce.add(wp.x, wp.y, wp.z, 0.05, 0.05, 0.16, c, rand() * 0.6, 0.3);
          else produce.add(wp.x, wp.y, wp.z, r, r * (kind === "potato" ? 0.75 : 0.95), r, c);
        }
  };
  crate(-6.0, -2.4, 1.1, 0.8, "tomato", 0.15, 0.5);
  crate(-4.85, -2.4, 1.1, 0.8, "banana", 0.15, 0.5);
  crate(-3.7, -2.4, 1.1, 0.8, "apple", 0.15, 0.5);
  // Today's Store board near entrance
  const statsTex = canvasTexture(512, 360, (c) => {
    c.fillStyle = "#1c1a17";
    c.fillRect(0, 0, 512, 360);
    c.strokeStyle = "#7a5a35";
    c.lineWidth = 16;
    c.strokeRect(8, 8, 496, 344);
    c.fillStyle = "#fff3d6";
    c.font = `800 52px ${HEADING_FONT}`;
    c.fillText("Today's Store", 36, 82);
    const rows: Array<[string, string, string]> = [
      ["Sales", "₹8,520", "#74c392"],
      ["Orders", "67", "#f2b441"],
      ["Low Stock", "3", "#e85d4a"],
    ];
    rows.forEach(([k, v, col], i) => {
      const y = 160 + i * 70;
      c.fillStyle = col;
      c.fillRect(40, y - 28, 30, 30);
      c.fillStyle = "#f1e6d0";
      c.font = `700 40px ${HEADING_FONT}`;
      c.fillText(k, 90, y);
      c.textAlign = "right";
      c.fillText(v, 470, y);
      c.textAlign = "left";
    });
    c.fillStyle = "#8a8272";
    c.font = `600 22px ${HEADING_FONT}`;
    c.textAlign = "right";
    c.fillText("demo data", 480, 336);
    c.textAlign = "left";
  });
  disposables.push(statsTex);
  const board = new THREE.Group();
  board.position.set(-12.2, 0, -0.3);
  board.rotation.y = 0;
  solid("store board", -12.2, -0.3, 1.3, 0.18);
  a.box(board, -0.5, 0.6, -0.05, 0.06, 1.2, 0.06, woodDark);
  a.box(board, 0.5, 0.6, -0.05, 0.06, 1.2, 0.06, woodDark);
  const bp = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 0.92),
    new THREE.MeshStandardMaterial({
      map: statsTex,
      emissive: "#ffffff",
      emissiveMap: statsTex,
      emissiveIntensity: 0.35,
    }),
  );
  bp.position.set(0, 1.2, 0);
  board.add(bp);
  root.add(board);
  // baskets near entrance
  solid("shopping baskets", -13.2, 0, 0.55, 0.4);
  const basketParts = new Batch(a.flatCube, productMat, false);
  for (let i = 0; i < 3; i++) {
    const y = 0.1 + i * 0.11;
    basketParts.add(-13.2, y, 0, 0.55, 0.025, 0.4, "#c1121f");
    for (const z of [-0.2, 0.2]) {
      basketParts.add(-13.2, y + 0.14, z, 0.55, 0.025, 0.02, "#c1121f");
      for (let j = 0; j < 8; j++)
        basketParts.add(-13.44 + j * 0.068, y + 0.07, z, 0.018, 0.14, 0.018, "#c1121f");
    }
    for (const x of [-13.475, -12.925]) {
      basketParts.add(x, y + 0.14, 0, 0.02, 0.025, 0.4, "#c1121f");
      for (let j = 0; j < 6; j++)
        basketParts.add(x, y + 0.07, -0.17 + j * 0.068, 0.018, 0.14, 0.018, "#c1121f");
    }
  }
  basketParts.add(-13.2, 0.56, 0, 0.5, 0.025, 0.025, "#2b2b2b");
  for (const x of [-13.45, -12.95]) basketParts.add(x, 0.48, 0, 0.025, 0.16, 0.025, "#2b2b2b");
  basketParts.flush(root);
  // promotional display pyramid near entrance
  const promo = new THREE.Group();
  promo.position.set(-12.3, 0, 2.3);
  solid("promotional display", -12.3, 2.3, 1.1, 1.1);
  const pbox = new Batch(a.flatCube, productMat);
  const plabels = newLabelBatches();
  for (let layer = 0; layer < 3; layer++)
    for (let i = 0; i < 3 - layer; i++)
      for (let j = 0; j < 3 - layer; j++) {
        const px = (i - (2 - layer) / 2) * 0.34;
        const pz = (j - (2 - layer) / 2) * 0.34;
        pbox.add(px, 0.16 + layer * 0.32, pz, 0.3, 0.3, 0.3, PALETTES.snacks[(i + j + layer) % 9]!);
        const name = ["Cookies", "Crunch", "Chips"][(i + j + layer) % 3];
        if ((i + j) % 2 === 0 && name)
          addLabel(plabels, name, px, 0.16 + layer * 0.32, pz + 0.158, 0.2, 0.18);
      }
  pbox.flush(promo);
  flushLabels(plabels, promo);
  const saleTex = signTexture(["SALE"], { w: 256, h: 128, bg: "#c1121f", border: "#ffd60a" });
  disposables.push(saleTex);
  const sale = new THREE.Mesh(
    new THREE.PlaneGeometry(0.7, 0.35),
    new THREE.MeshStandardMaterial({
      map: saleTex,
      emissive: "#ffffff",
      emissiveMap: saleTex,
      emissiveIntensity: 0.5,
    }),
  );
  sale.position.set(0, 1.4, 0.12);
  sale.rotation.x = -0.15;
  promo.add(sale);
  a.box(promo, 0, 1.05, 0, 0.04, 0.7, 0.04, metal);
  root.add(promo);
  plant(-13.3, -8.3, 1.1);
  plant(1.0, -8.4, 1);
  plant(-2.5, -1.0, 0.9);
  for (const [x, z] of [
    [-11, -6.2],
    [-6.5, -6.2],
    [-2.2, -6.2],
    [-9.5, -2],
    [-4.5, -3.8],
  ])
    pendant(x!, z!);
  acUnit(-4.0, -8.72);

  // ---------- SECTION A2: FRESH PRODUCE + DAIRY (x 1.6..14, z -9..0.6) ----------
  // produce wall racks: tiered crates
  const produceRack = (
    x: number,
    kinds: Array<"tomato" | "apple" | "orange" | "onion" | "potato" | "greens">,
  ) => {
    kinds.forEach((k, i) => {
      const row = Math.floor(i / 3);
      const col = i % 3;
      crate(x + (col - 1) * 0.95, -8.35 + row * 0.75, 0.9, 0.7, k, 0.35, 1.0 - row * 0.45);
    });
  };
  produceRack(4.0, ["greens", "tomato", "orange", "apple", "onion", "potato"]);
  a.box(root, 4.0, 1.55, -8.75, 3.0, 0.08, 0.3, woodLight);
  // side bins along divider
  crate(2.5, -5.6, 0.9, 0.9, "potato", 0.1, 0.45);
  crate(2.5, -4.5, 0.9, 0.9, "onion", 0.1, 0.45);
  // Dairy fridges
  const fridge = (x: number, z: number, ry: number) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    solid("refrigerator", x, z, 1.2, 0.75, ry);
    a.box(g, 0, 1.05, -0.34, 1.2, 2.1, 0.08, a.material("#e8eef2", 0.32, 0.5));
    a.box(g, 0, 1.1, -0.285, 0.89, 1.7, 0.018, a.material("#f1f4f0", 0.3));
    for (let i = 0; i < 9; i++) a.box(g, 0, 1.72 + i * 0.025, -0.27, 0.46, 0.009, 0.018, "#a8b6bb");
    for (const side of [-1, 1]) {
      a.box(g, side * 0.56, 1.05, 0, 0.08, 2.1, 0.75, metal);
      a.box(g, side * 0.5, 1.1, 0.3, 0.025, 1.75, 0.025, a.glow("#d9efff", 1.3));
    }
    a.box(g, 0, 0.12, 0, 1.2, 0.24, 0.75, metal);
    a.box(g, 0, 2.04, 0, 1.2, 0.12, 0.75, metal);
    for (let i = 0; i < 8; i++) a.box(g, 0, 0.04 + i * 0.02, 0.39, 0.96, 0.008, 0.01, "#39434a");
    a.box(g, 0, 2.02, 0.39, 1.0, 0.12, 0.02, a.glow("#4cc9f0", 1.2));
    const box = new Batch(a.flatCube, productMat);
    const cyl = new Batch(cylGeo, glossMat);
    const labels = newLabelBatches();
    for (let i = 0; i < 4; i++) {
      const y = 0.28 + i * 0.42;
      a.box(g, 0, y, 0.05, 1.0, 0.025, 0.6, "#c9d6de");
      for (let j = 0; j < 12; j++)
        a.box(g, -0.45 + j * 0.081, y + 0.02, 0.04, 0.008, 0.009, 0.54, metal);
      fillShelfRow(box, cyl, labels, -0.48, 0.48, y + 0.02, -0.22, 0.5, "dairy", 0.34);
    }
    box.flush(g);
    cyl.flush(g);
    flushLabels(labels, g);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(1.06, 1.86),
      new THREE.MeshPhysicalMaterial({
        color: "#cfefff",
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        roughness: 0.08,
        metalness: 0.1,
      }),
    );
    glass.position.set(0, 1.08, 0.38);
    g.add(glass);
    for (const side of [-1, 1]) a.box(g, side * 0.525, 1.08, 0.372, 0.018, 1.86, 0.015, "#35434a");
    for (const y of [0.15, 2.01]) a.box(g, 0, y, 0.372, 1.06, 0.018, 0.015, "#35434a");
    for (const y of [0.86, 1.34]) a.box(g, 0.45, y, 0.42, 0.04, 0.03, 0.08, metal);
    a.box(g, 0.45, 1.1, 0.46, 0.035, 0.5, 0.035, metal);
    a.box(g, -0.32, 2.045, 0.39, 0.16, 0.055, 0.016, a.material("#243d36", 0.4));
    root.add(g);
  };
  fridge(9.2, -8.4, 0);
  fridge(10.45, -8.4, 0);
  fridge(11.7, -8.4, 0);
  // frozen foods chest freezer with sliding glass top
  const freezer = new THREE.Group();
  freezer.position.set(13.0, 0, -7.7);
  solid("freezer", 13, -7.7, 1.6, 0.85);
  a.box(freezer, 0, 0.45, 0, 1.6, 0.9, 0.85, a.material("#eef2f4", 0.35, 0.2));
  a.box(freezer, 0, 0.92, 0, 1.5, 0.05, 0.75, "#c9d6de");
  const fglass = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.65),
    new THREE.MeshPhysicalMaterial({
      color: "#cfefff",
      transparent: true,
      opacity: 0.25,
      roughness: 0.08,
    }),
  );
  fglass.rotation.x = -Math.PI / 2;
  fglass.position.set(0, 0.96, 0);
  freezer.add(fglass);
  const fbox = new Batch(a.flatCube, productMat);
  for (let i = 0; i < 8; i++)
    fbox.add(
      -0.6 + (i % 4) * 0.4,
      0.82,
      -0.18 + Math.floor(i / 4) * 0.36,
      0.32,
      0.14,
      0.3,
      PALETTES.dairy[i % 7]!,
    );
  fbox.flush(freezer);
  a.box(freezer, 0, 0.5, 0.44, 1.5, 0.1, 0.02, a.glow("#4cc9f0", 1.0));
  root.add(freezer);
  // beverage shelf on right wall
  groceryShelf(13.55, -5.6, -Math.PI / 2, 2.6, 1.8, 4, "beverage");
  // Finance counter (Erin): POS desk with monitor and produce weighing scale
  const financeCounter = new THREE.Group();
  financeCounter.position.set(8.4, 0, -3.6);
  solid("finance counter", 8.4, -3.6, 3.55, 0.95);
  a.box(financeCounter, 0, 0.5, 0, 3.4, 1.0, 0.8, woodLight);
  a.box(financeCounter, 0, 1.02, 0, 3.55, 0.06, 0.95, "#e8d8bd");
  a.box(financeCounter, 0, 0.45, 0.41, 3.3, 0.06, 0.02, a.glow("#ffb347", 2.0));
  a.box(financeCounter, 0.7, 1.35, -0.15, 0.75, 0.48, 0.05, "#1d2328");
  a.box(financeCounter, 0.7, 1.35, -0.12, 0.68, 0.4, 0.01, a.texture("screen"));
  a.box(financeCounter, 0.7, 1.08, -0.15, 0.12, 0.1, 0.12, "#1d2328");
  // product display on counter
  const cbox = new Batch(a.flatCube, productMat);
  const ccyl = new Batch(cylGeo, glossMat);
  const clabels = newLabelBatches();
  fillShelfRow(cbox, ccyl, clabels, -1.5, 0.1, 1.06, -0.3, 0.55, "snacks", 0.26);
  cbox.flush(financeCounter);
  ccyl.flush(financeCounter);
  flushLabels(clabels, financeCounter);
  a.cylinderMesh(financeCounter, -1.3, 1.25, 0.25, 0.02, 0.4, "#2a2522");
  a.sphereMesh(financeCounter, -1.3, 1.5, 0.25, 0.14, a.glow("#ffe3a8", 2));
  root.add(financeCounter);
  // rug
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.4), a.texture("rug"));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(12.0, 0.01, -2.2);
  rug.receiveShadow = true;
  root.add(rug);
  plant(6.4, -8.4, 1);
  plant(13.2, -0.4, 1);
  plant(2.3, -0.3, 0.9);
  for (const [x, z] of [
    [4, -6.2],
    [10.4, -6.2],
    [6.4, -2.5],
    [10.6, -1.4],
  ])
    pendant(x!, z!);
  acUnit(7.0, -8.72);

  // ---------- SECTION B1: BILLING COUNTER + STORE OPERATIONS (x -14..1.6, z 0.6..9) ----------
  const billing = new THREE.Group();
  billing.position.set(-10.2, 0, 5.0);
  solid("billing counter", -10.2, 5, 3.6, 1);
  solid("checkout return", -12.05, 4.1, 1, 2);
  // Cash drawer, weighing scale, receipt roll and scanning surface.
  a.box(billing, 0.4, 0.9, 0.48, 0.72, 0.18, 0.025, metal);
  a.box(billing, 0.4, 0.92, 0.5, 0.2, 0.025, 0.02, "#252d30");
  a.box(billing, -0.4, 1.08, 0.1, 0.58, 0.06, 0.44, metal);
  a.box(billing, -0.4, 1.17, 0.18, 0.27, 0.09, 0.05, a.glow("#78c2a8", 0.5));
  a.box(billing, 1.35, 1.14, -0.1, 0.3, 0.22, 0.3, "#30383b");
  a.box(billing, 1.35, 1.27, -0.03, 0.23, 0.03, 0.15, "#eee8dd");
  a.box(billing, 0.85, 1.09, 0.18, 0.2, 0.025, 0.24, "#161d22");
  for (let i = 0; i < 3; i++) {
    const x = -1.5 + i * 0.23;
    a.box(billing, x, 1.28, -0.31, 0.19, 0.4, 0.13, a.texture("cardboard"));
    a.box(billing, x, 1.485, -0.31, 0.17, 0.008, 0.11, "#60472e");
    for (const z of [-0.36, -0.26]) {
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.006, 4, 12, Math.PI), metal);
      handle.position.set(x, 1.49, z);
      billing.add(handle);
    }
  }
  a.box(billing, 0, 0.5, 0, 3.4, 1.0, 0.85, wood);
  a.box(billing, 0, 1.02, 0, 3.6, 0.06, 1.0, "#e8d8bd");
  a.box(billing, 0, 0.4, 0.44, 3.3, 0.05, 0.02, a.glow("#ffb347", 2.4));
  a.box(billing, -1.85, 0.5, -0.9, 0.85, 1.0, 1.9, wood);
  a.box(billing, -1.85, 1.02, -0.9, 1.0, 0.06, 2.0, "#e8d8bd");
  // POS
  a.box(billing, 0.4, 1.38, -0.2, 0.7, 0.46, 0.05, "#1d2328");
  a.box(billing, 0.4, 1.38, -0.17, 0.62, 0.38, 0.01, a.texture("screen"));
  a.box(billing, 0.4, 1.1, -0.2, 0.1, 0.1, 0.1, "#1d2328");
  a.box(billing, -0.4, 1.12, 0.05, 0.5, 0.16, 0.38, "#2a2f35");
  a.box(billing, -0.4, 1.21, -0.05, 0.42, 0.04, 0.16, "#f2b441");
  a.box(billing, 1.2, 1.1, 0.1, 0.14, 0.1, 0.22, "#22272c");
  const scanner = a.box(billing, 0.86, 1.21, 0.18, 0.09, 0.18, 0.08, "#30383b");
  scanner.rotation.z = -0.3;
  a.box(billing, 0.88, 1.3, 0.22, 0.09, 0.035, 0.012, a.glow("#b8443b", 0.4));
  a.box(billing, 1.35, 1.32, 0.04, 0.19, 0.12, 0.008, "#f6f1e5");
  const bbox = new Batch(a.flatCube, productMat);
  const bcyl = new Batch(cylGeo, glossMat);
  const blabels = newLabelBatches();
  fillShelfRow(bbox, bcyl, blabels, -1.6, -0.8, 1.06, -0.2, 0.4, "snacks", 0.25);
  bbox.flush(billing);
  bcyl.flush(billing);
  flushLabels(blabels, billing);
  // UPI QR payment stand on the counter
  const qrTex = canvasTexture(128, 128, (c) => {
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, 128, 128);
    c.fillStyle = "#151310";
    const r2 = rng(77);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++) if (r2() < 0.45) c.fillRect(8 + i * 9.4, 8 + j * 9.4, 8, 8);
  });
  disposables.push(qrTex);
  const qr = new THREE.Mesh(
    new THREE.PlaneGeometry(0.2, 0.2),
    new THREE.MeshStandardMaterial({ map: qrTex, roughness: 0.5 }),
  );
  qr.position.set(1.05, 1.22, 0.3);
  qr.rotation.x = -0.25;
  billing.add(qr);
  a.box(billing, 1.05, 1.08, 0.28, 0.05, 0.1, 0.05, "#2a2f35");
  root.add(billing);
  groceryShelf(-11.0, 1.05, 0, 2.2, 1.5, 4, "snacks");
  // cashier stool
  a.cylinderMesh(root, -9.8, 0.35, 3.9, 0.04, 0.7, metal);
  a.cylinderMesh(root, -9.8, 0.72, 3.9, 0.22, 0.06, "#7a3b2e");
  // entrance: glass door on left wall + mat + cart
  a.box(root, -13.92, 1.15, 6.6, 0.1, 2.3, 1.7, a.material("#2a2522", 0.5));
  a.box(
    root,
    -13.88,
    1.15,
    6.6,
    0.06,
    2.1,
    1.5,
    new THREE.MeshPhysicalMaterial({
      color: "#ffd9a0",
      emissive: "#ffb347",
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.55,
    }),
  );
  const matTex = canvasTexture(256, 160, (c) => {
    c.fillStyle = "#a4161a";
    c.fillRect(0, 0, 256, 160);
    c.strokeStyle = "#f2b441";
    c.lineWidth = 8;
    c.strokeRect(10, 10, 236, 140);
    c.fillStyle = "#fff3d6";
    c.font = `800 44px ${HEADING_FONT}`;
    c.textAlign = "center";
    c.fillText("KiranaCrew", 128, 96);
  });
  disposables.push(matTex);
  const mat = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.9),
    new THREE.MeshStandardMaterial({ map: matTex }),
  );
  mat.rotation.x = -Math.PI / 2;
  mat.rotation.z = -Math.PI / 2;
  mat.position.set(-13.1, 0.012, 6.6);
  root.add(mat);
  // shopping cart
  const cart = new THREE.Group();
  cart.position.set(-11.6, 0, 7.9);
  cart.rotation.y = 0;
  solid("cart", -11.6, 7.9, 0.9, 0.65);
  a.box(cart, 0, 0.62, 0, 0.75, 0.42, 0.5, a.material("#c1121f", 0.4, 0.3));
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) a.cylinderMesh(cart, sx * 0.3, 0.08, sz * 0.2, 0.07, 0.05, "#222");
  a.box(cart, 0.42, 0.85, 0, 0.04, 0.04, 0.55, "#2b2b2b");
  for (const sx of [-1, 1]) a.box(cart, sx * 0.3, 0.3, 0, 0.03, 0.45, 0.03, metal);
  root.add(cart);
  // Store Operations board
  const opsTex = canvasTexture(512, 400, (c) => {
    c.fillStyle = "#1b1712";
    c.fillRect(0, 0, 512, 400);
    c.strokeStyle = "#f2b441";
    c.lineWidth = 14;
    c.strokeRect(7, 7, 498, 386);
    c.fillStyle = "#fff3d6";
    c.font = `800 50px ${HEADING_FONT}`;
    c.textAlign = "center";
    c.fillText("Store Operations", 256, 74);
    c.textAlign = "left";
    ["Inventory", "Sales", "Procurement", "Finance"].forEach((t, i) => {
      const y = 150 + i * 66;
      c.fillStyle = "#f2b441";
      c.beginPath();
      c.arc(60, y - 12, 12, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#f1e6d0";
      c.font = `700 40px ${HEADING_FONT}`;
      c.fillText(t, 90, y);
      c.fillStyle = i === 2 ? "#f2b441" : "#74c392";
      c.fillText(i === 2 ? "…" : "✓", 440, y);
    });
  });
  disposables.push(opsTex);
  const ops = new THREE.Group();
  ops.position.set(-5.4, 0, 1.15);
  a.box(ops, 0, 0.95, -0.04, 2.0, 1.6, 0.06, woodDark);
  const opsPlate = new THREE.Mesh(
    new THREE.PlaneGeometry(1.86, 1.46),
    new THREE.MeshStandardMaterial({
      map: opsTex,
      emissive: "#ffffff",
      emissiveMap: opsTex,
      emissiveIntensity: 0.45,
    }),
  );
  opsPlate.position.set(0, 0.95, 0.0);
  ops.add(opsPlate);
  for (const sx of [-0.85, 0.85]) a.box(ops, sx, 0.35, -0.04, 0.06, 0.7, 0.06, woodDark);
  root.add(ops);
  // Manager desk (Alice) — store management area
  const desk = (x: number, z: number, w: number, chartScreen: boolean) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    solid("desk", x, z, w, 0.85);
    a.box(g, 0, 0.74, 0, w, 0.08, 0.85, woodLight);
    for (const sx of [-1, 1]) a.box(g, (sx * (w - 0.1)) / 2, 0.37, 0, 0.08, 0.74, 0.8, wood);
    a.box(g, 0, 0.45, -0.38, w - 0.2, 0.55, 0.04, wood);
    a.box(g, 0, 1.08, -0.2, 0.72, 0.46, 0.05, "#1d2328");
    a.box(g, 0, 1.08, -0.17, 0.64, 0.38, 0.01, a.texture(chartScreen ? "board" : "screen"));
    a.box(g, 0, 0.82, -0.2, 0.1, 0.1, 0.1, "#1d2328");
    a.box(g, 0, 0.8, 0.12, 0.42, 0.02, 0.14, "#2a2f35");
    a.cylinderMesh(g, w / 2 - 0.25, 0.95, -0.15, 0.02, 0.4, "#2a2522");
    a.sphereMesh(g, w / 2 - 0.25, 1.18, -0.15, 0.12, a.glow("#ffe3a8", 2.2));
    root.add(g);
    // stool
    a.cylinderMesh(root, x, 0.32, z - 0.85, 0.05, 0.64, "#2a2522");
    a.cylinderMesh(root, x, 0.66, z - 0.85, 0.24, 0.07, "#6b4424");
  };
  desk(-4.6, 7.25, 1.9, true);
  desk(-0.8, 7.15, 1.5, false);
  const rug2 = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.8), a.texture("rug"));
  rug2.rotation.x = -Math.PI / 2;
  rug2.position.set(-4.6, 0.01, 6.7);
  root.add(rug2);
  // small stock shelf in ops room
  groceryShelf(0.6, 1.05, 0, 1.6, 1.6, 4, "grocery");
  plant(-7.4, 8.4, 1);
  plant(1.0, 8.4, 0.9);
  plant(-13.2, 8.4, 1);
  plant(-2.8, 1.2, 0.85);
  for (const [x, z] of [
    [-10, 3.4],
    [-4.6, 4.8],
    [-0.8, 4.8],
  ])
    pendant(x!, z!, 2.2);

  // ---------- SECTION B2: STOCK & SUPPLIES (x 1.6..14, z 0.6..9) ----------
  /** InventoryRack: grey steel rack with cartons, sacks and loose products. */
  const rack = (x: number, z: number, ry: number, w: number, palette: PaletteKey) => {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const d = 0.7;
    solid("storage rack", x, z, w + 0.1, d + 0.1, ry);
    const h = 2.0;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        a.box(g, (sx * w) / 2, h / 2, (sz * d) / 2, 0.05, h, 0.05, "#5b6b78");
    const box = new Batch(a.flatCube, productMat);
    const cyl = new Batch(cylGeo, glossMat);
    const labels = newLabelBatches();
    for (let i = 0; i < 4; i++) {
      const y = 0.1 + i * 0.5;
      a.box(g, 0, y, 0, w, 0.04, d, metal);
      a.box(g, 0, y + 0.02, d / 2, w, 0.05, 0.02, "#e07a1f");
      if (i % 2 === 0 || palette === "stock") {
        let px = -w / 2 + 0.06;
        while (px < w / 2 - 0.3) {
          const bw = 0.3 + rand() * 0.2;
          const bh = 0.25 + rand() * 0.15;
          const col = PALETTES.stock[Math.floor(rand() * PALETTES.stock.length)]!;
          a.box(g, px + bw / 2, y + 0.02 + bh / 2, 0, bw, bh, d * 0.8, a.texture("cardboard"));
          box.add(
            px + bw / 2,
            y + 0.02 + bh * 0.6,
            d * 0.4 + 0.006,
            bw * 0.4,
            bh * 0.25,
            0.01,
            "#efe2c3",
          );
          px += bw + 0.03;
        }
      } else
        fillShelfRow(
          box,
          cyl,
          labels,
          -w / 2 + 0.05,
          w / 2 - 0.05,
          y + 0.02,
          -d / 2 + 0.06,
          d - 0.1,
          palette,
          0.42,
        );
    }
    box.flush(g);
    cyl.flush(g);
    flushLabels(labels, g);
    root.add(g);
  };
  rack(3.6, 1.15, 0, 2.6, "grocery");
  rack(13.55, 3.6, -Math.PI / 2, 2.6, "stock");
  rack(9.6, 3.0, 0, 2.4, "stock");
  // grain sacks (atta / rice)
  const sack = (x: number, z: number, label: string, ry = 0) => {
    solid("grain sack", x, z, 0.72, 0.56, ry);
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    const s = a.sphereMesh(g, 0, 0.38, 0, 0.36, a.texture("sack"));
    s.scale.set(0.36, 0.38, 0.28);
    a.box(g, 0, 0.74, 0, 0.22, 0.12, 0.16, "#e2d6bb");
    a.box(g, 0, 0.38, 0.27, 0.32, 0.14, 0.01, label);
    root.add(g);
  };
  sack(3.0, 4.6, "#d62828");
  sack(3.75, 4.75, "#2e86ab", 0.4);
  sack(3.3, 5.5, "#3bb273", -0.3);
  sack(10.8, 5.0, "#f18f01");
  sack(11.5, 5.2, "#d62828", 0.5);
  // pallet + carton stacks
  const pallet = (x: number, z: number) => {
    solid("pallet", x, z, 1.5, 1.5);
    for (let i = 0; i < 3; i++) a.box(root, x, 0.06, z - 0.4 + i * 0.4, 1.3, 0.12, 0.18, woodLight);
  };
  const cartons = new Batch(a.flatCube, a.texture("cardboard"));
  const stack = (x: number, z: number, n: number) => {
    solid("delivery cartons", x, z, 0.72, 0.62);
    for (let i = 0; i < n; i++) {
      const off = (rand() - 0.5) * 0.08;
      cartons.add(
        x + off,
        0.32 + i * 0.4,
        z + off,
        0.6,
        0.38,
        0.5,
        PALETTES.stock[i % 5]!,
        (rand() - 0.5) * 0.2,
      );
      cartons.add(
        x + off,
        0.32 + i * 0.4 + 0.19,
        z + off,
        0.08,
        0.01,
        0.51,
        "#e8d3a6",
        (rand() - 0.5) * 0.2,
      );
    }
  };
  pallet(6.4, 6.8);
  stack(6.0, 6.6, 3);
  stack(6.75, 6.9, 2);
  stack(6.3, 7.4, 1);
  pallet(9.6, 7.4);
  stack(9.3, 7.3, 2);
  stack(10.0, 7.5, 3);
  stack(12.2, 7.9, 2);
  stack(2.6, 7.8, 2);
  cartons.flush(root);
  // reorder workstation
  const ws = new THREE.Group();
  ws.position.set(12.6, 0, 1.5);
  solid("workstation", 12.6, 1.5, 1.7, 0.78);
  a.box(ws, 0, 0.5, 0, 1.6, 1.0, 0.7, woodDark);
  a.box(ws, 0, 1.02, 0, 1.7, 0.05, 0.78, "#d9c7a4");
  a.box(ws, 0, 1.3, -0.15, 0.55, 0.38, 0.04, "#1d2328");
  a.box(ws, 0, 1.3, -0.12, 0.5, 0.32, 0.01, a.texture("screen"));
  root.add(ws);
  // yellow hand trolley
  const trolley = new THREE.Group();
  trolley.position.set(12.5, 0, 7.4);
  trolley.rotation.y = 0;
  solid("trolley", 12.5, 7.4, 0.72, 0.55);
  a.box(trolley, 0, 0.05, 0.2, 0.5, 0.04, 0.35, "#f2b441");
  for (const sx of [-1, 1]) a.box(trolley, sx * 0.22, 0.7, 0, 0.05, 1.4, 0.05, "#f2b441");
  a.box(trolley, 0, 1.38, 0, 0.5, 0.05, 0.05, "#f2b441");
  for (const sx of [-1, 1]) {
    const wh = a.cylinderMesh(trolley, sx * 0.3, 0.12, -0.05, 0.12, 0.07, "#222");
    wh.rotation.z = Math.PI / 2;
  }
  root.add(trolley);
  // stockroom back door
  a.box(root, 8.0, 1.05, 0.78, 0.9, 1.9, 0.06, "#c98a3d");
  a.sphereMesh(root, 8.3, 1.0, 0.83, 0.04, metal);
  plant(13.3, 8.4, 1);
  plant(2.2, 8.4, 0.9);
  for (const [x, z] of [
    [4.5, 3.4],
    [9.6, 4.6],
    [10, 7],
  ])
    pendant(x!, z!, 2.2);

  // ---------- Fixtures: ceiling fans, CCTV cameras, dustbins ----------
  fan(-8.5, -4.2);
  fan(5.5, -4.5);
  fan(-4.5, 4.6);
  fan(8.0, 4.6);
  cctv(-13.5, -8.5, -2.35);
  cctv(13.5, -8.5, 2.35);
  cctv(-13.5, 8.5, -0.78);
  dustbin(-8.4, 5.8);
  dustbin(2.4, -1.4, "#e07a1f");

  // Logical safety details on back walls; ceiling stays cut away for aisle visibility.
  const clockTex = canvasTexture(256, 256, (c) => {
    c.fillStyle = "#f5f0dd";
    c.fillRect(0, 0, 256, 256);
    c.translate(128, 128);
    c.strokeStyle = "#342d23";
    c.lineWidth = 10;
    for (let i = 0; i < 12; i++) {
      c.save();
      c.rotate((i * Math.PI) / 6);
      c.beginPath();
      c.moveTo(0, -94);
      c.lineTo(0, -108);
      c.stroke();
      c.restore();
    }
    c.lineWidth = 8;
    c.beginPath();
    c.moveTo(-38, -38);
    c.lineTo(0, 0);
    c.lineTo(55, -50);
    c.stroke();
  });
  disposables.push(clockTex);
  const clock = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 32),
    new THREE.MeshStandardMaterial({ map: clockTex, roughness: 0.7 }),
  );
  clock.position.set(7.1, 2.3, -8.82);
  root.add(clock);
  for (const x of [-13.55, 13.55]) {
    a.cylinderMesh(root, x, 0.65, -0.05, 0.1, 0.55, "#be3430");
    a.box(root, x, 0.96, -0.05, 0.09, 0.09, 0.06, "#282d2a");
    a.box(root, x, 1.4, -0.13, 0.2, 0.25, 0.025, "#ecdfc5");
  }
  for (const x of [-11, -6.5, -2.2, 4, 10.4]) {
    a.box(root, x, 2.9, -6.2, 1.8, 0.06, 0.16, woodDark);
    a.box(root, x, 2.86, -6.2, 1.6, 0.02, 0.09, a.glow("#ffe4b7", 1.4));
  }
  // A wall-mounted retail poster, not fabricated sales or offer prices.
  const posterTexture = signTexture(["Fresh every day", "KiranaCrew"], {
    w: 512,
    h: 640,
    bg: "#234e3d",
    border: "#e5d6a6",
  });
  disposables.push(posterTexture);
  const poster = new THREE.Mesh(
    new THREE.PlaneGeometry(0.75, 0.95),
    new THREE.MeshBasicMaterial({ map: posterTexture, toneMapped: false }),
  );
  poster.position.set(7.9, 1.85, -8.8);
  root.add(poster);

  // ---------- Clickable store zones (invisible hitboxes) ----------
  for (const s of STORE_SIGNS) {
    const board = sign(
      [...s.text],
      s.x,
      s.y,
      s.z,
      s.width,
      s.height,
      "rotation" in s ? s.rotation : 0,
    );
    board.userData["signId"] = s.id;
  }
  zone("groceries", -6.5, -7.7, 14, 2.4);
  zone("produce", 4.0, -7.7, 4.6, 2.4);
  zone("dairy", 10.8, -8.0, 5.6, 1.8);
  zone("billing", -10.2, 5.0, 4.8, 3.2);
  zone("stockroom", 8.0, 4.8, 11.6, 7.6);
  zone("management", -2.7, 7.2, 6.2, 3.4);

  // ---------- Exterior greenery (soft, outside left/right) ----------
  for (const [x, z, s] of [
    [-15.3, -6, 1.3],
    [-15.4, 1, 1.2],
    [-15.2, 7.5, 1.1],
    [15.3, -5, 1.2],
    [15.3, 3, 1.3],
  ] as const)
    plant(x, z, s);

  produce.flush(root);
  const contacts = new Batch(contactGeo, contactMat, false);
  for (const b of collisions.boundaries) {
    if (b.id === "wall") continue;
    contacts.add(
      (b.minX + b.maxX) / 2,
      0.009,
      (b.minZ + b.maxZ) / 2,
      b.maxX - b.minX + 0.25,
      1,
      b.maxZ - b.minZ + 0.25,
      "#ffffff",
    );
  }
  contacts.flush(root);
  root.userData["dispose"] = () => {
    disposables.forEach((t) => t.dispose());
    productMat.dispose();
    glossMat.dispose();
    produceMat.dispose();
    roundGeo.dispose();
    cylGeo.dispose();
    labelGeo.dispose();
    labelMats.forEach((m) => m.dispose());
    zoneMat.dispose();
    contactGeo.dispose();
    contactMat.dispose();
    Object.values(packageGeometries).forEach((geometry) => geometry.dispose());
    root.traverse((object) => {
      if (object instanceof THREE.Mesh && object.geometry instanceof THREE.TorusGeometry)
        object.geometry.dispose();
    });
  };
  return { group: root, lampPositions, zones, spinners, collisions };
}
