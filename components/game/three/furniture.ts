import * as THREE from "three";
import { OfficeAssets } from "./assets";

export class Furniture {
  constructor(private a: OfficeAssets) {}
  plant(parent: THREE.Object3D, x: number, z: number, scale = 1) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.scale.setScalar(scale);
    parent.add(g);
    this.a.round(g, 0, 0.19, 0, 0.21, 0.38, "#55564b");
    this.a.round(g, 0, 0.4, 0, 0.23, 0.06, "#b9a582");
    this.a.round(g, 0, 0.77, 0, 0.025, 0.78, "#5c4930");
    for (let i = 0; i < 14; i++) {
      const angle = i * 2.399;
      const leaf = new THREE.Mesh(
        this.a.leaf,
        this.a.material(["#3d6034", "#617d3c", "#294c31"][i % 3]),
      );
      leaf.position.set(Math.cos(angle) * 0.21, 0.65 + (i % 5) * 0.12, Math.sin(angle) * 0.21);
      leaf.scale.set(0.13, 0.32, 0.08);
      leaf.rotation.set(Math.sin(angle) * 0.8, angle, 0.6);
      leaf.castShadow = true;
      g.add(leaf);
    }
  }
  lamp(parent: THREE.Object3D, x: number, z: number, y = 0.9) {
    this.a.round(parent, x, y + 0.025, z, 0.12, 0.05, "#393b33");
    this.a.round(parent, x, y + 0.24, z, 0.018, 0.43, "#b98d4d");
    this.a.round(parent, x, y + 0.47, z, 0.16, 0.14, this.a.glow("#ffce83", 1.6));
  }
  chair(parent: THREE.Object3D, x: number, z: number, angle = 0, color = "#303940") {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    this.a.round(g, 0, 0.23, 0, 0.045, 0.4, "#323737");
    for (let i = 0; i < 5; i++) {
      const leg = this.a.box(g, 0, 0.07, 0, 0.62, 0.035, 0.045, "#2b3030");
      leg.rotation.y = (i * Math.PI) / 5;
    }
    this.a.box(g, 0, 0.48, 0, 0.55, 0.13, 0.52, color);
    this.a.box(g, 0, 0.85, -0.24, 0.56, 0.63, 0.1, color);
    this.a.box(g, 0, 1.18, -0.24, 0.36, 0.14, 0.13, color);
    for (const side of [-1, 1]) {
      this.a.box(g, side * 0.32, 0.65, 0, 0.045, 0.33, 0.045, "#343a3b");
      this.a.box(g, side * 0.32, 0.79, 0, 0.1, 0.06, 0.37, "#242c2e");
    }
    return g;
  }
  desk(parent: THREE.Object3D, x: number, z: number, angle = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    this.a.box(g, 0, 0.83, 0, 1.75, 0.12, 0.85, this.a.texture("wood"));
    for (const sx of [-0.72, 0.72])
      for (const sz of [-0.32, 0.32]) this.a.box(g, sx, 0.4, sz, 0.065, 0.8, 0.065, "#303637");
    this.a.box(g, 0.59, 0.4, 0.08, 0.38, 0.68, 0.55, "#414b4a");
    for (let i = 0; i < 3; i++)
      this.a.box(g, 0.59, 0.23 + i * 0.2, 0.365, 0.14, 0.025, 0.025, "#bda56e");
    this.a.round(g, 0, 0.93, -0.14, 0.15, 0.04, "#242a2d");
    this.a.box(g, 0, 1.09, -0.17, 0.055, 0.3, 0.045, "#30393d");
    this.a.box(g, 0, 1.35, -0.18, 0.86, 0.55, 0.055, "#151e24");
    this.a.box(g, 0, 1.35, -0.146, 0.78, 0.46, 0.012, this.a.texture("screen"));
    this.a.box(g, -0.05, 0.91, 0.15, 0.52, 0.035, 0.19, "#252f34");
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 10; col++)
        this.a.box(
          g,
          -0.27 + col * 0.047,
          0.933,
          0.09 + row * 0.05,
          0.033,
          0.008,
          0.026,
          "#87918d",
        );
    this.a.box(g, 0.36, 0.92, 0.18, 0.07, 0.035, 0.12, "#91968a");
    this.a.round(g, -0.63, 0.98, 0.19, 0.07, 0.18, "#e2d9bf");
    this.a.round(g, -0.63, 1.075, 0.19, 0.052, 0.005, "#342720");
    this.lamp(g, 0.68, -0.22, 0.9);
    this.a.box(g, -0.63, 0.92, -0.17, 0.23, 0.04, 0.27, "#c2b79a");
    g.scale.x = 1.35;
    return g;
  }
  shelf(parent: THREE.Object3D, x: number, z: number, width = 1.7) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    parent.add(g);
    this.a.box(g, 0, 1.1, -0.18, width, 2.2, 0.08, "#57442e");
    for (const sx of [-width / 2, width / 2])
      this.a.box(g, sx, 1.1, 0, 0.075, 2.2, 0.47, "#b18b4e");
    const colors = ["#9f603e", "#3d6279", "#b99b55", "#58705b", "#a39a7c", "#725963"];
    for (let row = 0; row < 4; row++) {
      this.a.box(g, 0, 0.12 + row * 0.53, 0, width, 0.065, 0.48, this.a.texture("wood"));
      for (let i = 0; i < Math.floor(width / 0.115) - 1; i++) {
        const h = 0.26 + ((i * 13 + row * 7) % 11) * 0.017;
        const bx = -width / 2 + 0.13 + i * 0.115;
        this.a.box(
          g,
          bx,
          0.155 + row * 0.53 + h / 2,
          0.03,
          0.085,
          h,
          0.27,
          colors[(i + row * 3) % colors.length],
        );
        this.a.box(g, bx, 0.23 + row * 0.53, 0.171, 0.068, 0.013, 0.008, "#cfbb81");
      }
    }
    this.a.box(g, 0, 2.23, 0, width + 0.1, 0.08, 0.54, this.a.texture("wood"));
    this.plant(g, -width * 0.3, 0, 0.65);
    g.children[g.children.length - 1].position.y = 2.27;
  }

  /**
   * Medium-height grocery gondola rack (1.3 units). Use for all in-store aisles.
   * Reduced from 2.12 to 1.3 to match kirana store gondola proportions.
   */
  groceryRack(parent: THREE.Object3D, x: number, z: number, width = 1.6, depth = 0.48) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    parent.add(g);
    // Back panel (1.3 units tall — medium height gondola)
    this.a.box(g, 0, 0.65, -depth / 2 + 0.04, width, 1.3, 0.065, "#3d2e1a");
    // Side uprights
    for (const sx of [-width / 2, width / 2])
      this.a.box(g, sx, 0.65, 0, 0.065, 1.32, depth, "#5c3d1f");
    // 3 shelf rows
    const shelfColors = [
      ["#e8a030", "#e02020", "#f0e030", "#40a030", "#c04060", "#3070e0"],
      ["#3070c0", "#e0a010", "#803090", "#308040", "#e85020", "#f0c040"],
      ["#f08020", "#d02020", "#40b050", "#3060a0", "#d0a030", "#50c080"],
    ];
    for (let row = 0; row < 3; row++) {
      const sy = 0.1 + row * 0.38;
      this.a.box(g, 0, sy, 0, width + 0.04, 0.04, depth, this.a.texture("wood"));
      const colors = shelfColors[row];
      const itemW = 0.13;
      const numItems = Math.floor((width - 0.16) / itemW);
      for (let i = 0; i < numItems; i++) {
        const bx = -width / 2 + 0.1 + i * itemW;
        const h = 0.22 + ((i * 7 + row * 11) % 7) * 0.022;
        const bz = -depth / 2 + 0.08 + ((i + row * 3) % 3) * 0.12;
        this.a.box(
          g,
          bx,
          sy + h / 2 + 0.02,
          bz,
          itemW * 0.8,
          h,
          0.16,
          colors[(i + row * 2) % colors.length],
        );
        // Price label on shelf edge
        this.a.box(g, bx, sy + 0.05, depth / 2 - 0.008, itemW * 0.72, 0.045, 0.012, "#f5f0e8");
      }
    }
    // Top cap
    this.a.box(g, 0, 1.33, 0, width + 0.07, 0.065, depth + 0.04, "#4a3020");
    // Small aisle sign on top-front edge
    this.a.box(g, 0, 1.42, -depth / 2 + 0.015, width * 0.7, 0.14, 0.03, "#1a3a6c");
    this.a.box(g, 0, 1.42, -depth / 2 + 0.03, width * 0.6, 0.08, 0.02, this.a.glow("#f5c030", 0.3));
  }

  /**
   * Two-sided gondola shelf for center aisles (products accessible from both sides).
   * Height 1.25 units.
   */
  gondolaShelf(parent: THREE.Object3D, x: number, z: number, width = 1.6) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    parent.add(g);
    // Center spine panel
    this.a.box(g, 0, 0.62, 0, width, 1.22, 0.055, "#3d2e1a");
    // Side caps
    for (const sx of [-width / 2, width / 2])
      this.a.box(g, sx, 0.62, 0, 0.065, 1.25, 0.46, "#4a3018");
    // Top cap
    this.a.box(g, 0, 1.27, 0, width + 0.07, 0.06, 0.5, "#5a3a20");

    const allColors = [
      ["#e8a030", "#d02020", "#40b050", "#3060a0", "#c04060", "#f0c030"],
      ["#30b0a0", "#e05020", "#8030b0", "#e8d020", "#4080c0", "#c06020"],
    ];
    // Front and back sides
    for (let side = 0; side < 2; side++) {
      const sz = side === 0 ? -0.16 : 0.16;
      for (let row = 0; row < 3; row++) {
        const sy = 0.08 + row * 0.36;
        this.a.box(g, 0, sy, sz, width, 0.04, 0.2, this.a.texture("wood"));
        const colors = allColors[side];
        const itemW = 0.14;
        const numItems = Math.floor((width - 0.14) / itemW);
        for (let i = 0; i < numItems; i++) {
          const bx = -width / 2 + 0.09 + i * itemW;
          const h = 0.2 + ((i * 5 + row * 9 + side * 3) % 7) * 0.022;
          const col = colors[(i + row * 3 + side * 2) % colors.length];
          this.a.box(
            g,
            bx,
            sy + h / 2 + 0.02,
            sz + (side === 0 ? -0.05 : 0.05),
            itemW * 0.78,
            h,
            0.14,
            col,
          );
        }
      }
    }
  }

  /**
   * Ceiling-hanging illuminated zone sign — mounts near ceiling, clearly visible above all shelves.
   */
  ceilingSign(parent: THREE.Object3D, x: number, z: number, text: string, width = 2.0) {
    // Hanging rods (2 thin poles from ceiling to sign)
    for (const sx of [-width / 2 + 0.3, width / 2 - 0.3]) {
      this.a.box(parent, x + sx, 2.15, z, 0.025, 0.55, 0.025, "#999");
    }
    // Sign body — warm dark navy background
    this.a.box(parent, x, 1.88, z, width, 0.52, 0.1, "#0d1b36");
    // Sign face with glow text material
    const face = this.a.signLabel(text, "#0d1b36", "#f5c030");
    this.a.box(parent, x, 1.88, z + 0.056, width - 0.06, 0.42, 0.02, face);
    // Bottom edge accent bar
    this.a.box(parent, x, 1.62, z + 0.04, width - 0.08, 0.04, 0.06, this.a.glow("#f5c030", 0.5));
    // Top mounting bar
    this.a.box(parent, x, 2.14, z, width + 0.06, 0.045, 0.12, "#2c4a6c");
  }

  /** Checkout POS billing counter — proper kirana store cash counter with POS, scanner, and items. */
  billingCounter(parent: THREE.Object3D, x: number, z: number, angle = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    // Main counter body — warm wood
    this.a.box(g, 0, 0.43, 0, 2.2, 0.82, 0.65, "#6b4420");
    this.a.box(g, 0, 0.88, 0, 2.25, 0.09, 0.68, "#e8d4b0");
    this.a.box(g, 0, 0.84, 0.34, 2.25, 0.055, 0.02, "#d4c09a");
    this.a.box(g, 0, 0.04, 0, 2.26, 0.08, 0.67, "#4a2e10");
    // Decorative front panels
    for (let i = 0; i < 3; i++) {
      const px = -0.7 + i * 0.7;
      this.a.box(g, px, 0.42, 0.34, 0.55, 0.72, 0.02, "#5a3818");
      this.a.box(g, px, 0.42, 0.35, 0.45, 0.6, 0.012, "#7a5228");
    }
    // POS monitor
    this.a.box(g, -0.72, 0.93, -0.06, 0.04, 0.38, 0.3, "#2a2a2a");
    this.a.box(g, -0.72, 1.18, -0.09, 0.66, 0.44, 0.055, "#1c1c1c");
    this.a.box(g, -0.72, 1.18, -0.062, 0.54, 0.35, 0.014, this.a.texture("screen"));
    // Barcode scanner
    this.a.box(g, 0.2, 0.9, -0.06, 0.4, 0.04, 0.28, "#555550");
    this.a.box(g, 0.2, 0.905, -0.06, 0.08, 0.02, 0.06, "#777770");
    // Barcode scanner laser line
    this.a.box(g, 0.2, 0.91, -0.07, 0.06, 0.004, 0.05, this.a.glow("#e80000", 0.8));
    // Cash drawer
    this.a.box(g, 0.75, 0.88, -0.04, 0.32, 0.025, 0.3, "#c0c0b0");
    this.a.box(g, 0.75, 0.865, -0.04, 0.26, 0.03, 0.26, "#a0a090");
    this.a.round(g, 0.75, 0.85, -0.04, 0.07, 0.1, "#808078");
    // Small packaged items on counter (chips, candy)
    for (let i = 0; i < 4; i++)
      this.a.box(
        g,
        -0.3 + i * 0.2,
        0.92,
        0.24,
        0.14,
        0.22,
        0.04,
        ["#f5e6c8", "#c8e8f0", "#e8c8d0", "#d0f0d0"][i],
      );
    // Shopping basket on counter end
    this.a.box(g, 0.78, 0.97, 0.2, 0.28, 0.2, 0.22, "#cc3010");
    this.a.box(g, 0.78, 1.08, 0.2, 0.3, 0.06, 0.24, "#aa2808");
  }

  storageSack(parent: THREE.Object3D, x: number, z: number, color = "#e8d4a0") {
    this.a.round(parent, x, 0.28, z, 0.33, 0.55, color);
    this.a.round(parent, x, 0.6, z, 0.26, 0.2, color);
    this.a.round(parent, x, 0.72, z, 0.18, 0.08, "#808070");
    this.a.box(parent, x, 0.38, z + 0.3, 0.22, 0.24, 0.04, "#8b0000");
    this.a.box(parent, x, 0.38, z + 0.32, 0.16, 0.16, 0.02, "#f0f0f0");
  }
  crateStack(parent: THREE.Object3D, x: number, z: number, count = 2) {
    const crateColors = ["#c4892e", "#b87a28", "#d49838"];
    for (let i = 0; i < count; i++) {
      const y = i * 0.32;
      this.a.box(parent, x, y + 0.16, z, 0.65, 0.3, 0.52, crateColors[i % crateColors.length]);
      for (let s = 0; s < 3; s++)
        this.a.box(parent, x, y + 0.06 + s * 0.12, z, 0.67, 0.02, 0.53, "#8a5a18");
      this.a.box(parent, x, y + 0.16, z + 0.27, 0.38, 0.18, 0.02, "#f0e8c0");
    }
  }
  oilContainer(parent: THREE.Object3D, x: number, z: number) {
    this.a.round(parent, x, 0.28, z, 0.21, 0.54, "#d0d0c0");
    this.a.round(parent, x, 0.57, z, 0.18, 0.06, "#b8b8a8");
    this.a.box(parent, x - 0.1, 0.7, z, 0.04, 0.22, 0.04, "#888880");
    this.a.box(parent, x + 0.1, 0.7, z, 0.04, 0.22, 0.04, "#888880");
    this.a.box(parent, x, 0.32, z + 0.19, 0.26, 0.28, 0.03, "#f0c030");
  }

  /**
   * Large fresh produce island — wooden crate display with piled colorful fruit & vegetables.
   */
  produceIsland(parent: THREE.Object3D, x: number, z: number, width = 2.8, depth = 1.4) {
    // Wooden base platform
    this.a.box(parent, x, 0.14, z, width, 0.28, depth, "#7a5a18");
    this.a.box(parent, x, 0.3, z, width - 0.08, 0.065, depth - 0.06, "#6a4e14");
    // Crate dividers
    for (const sx of [-width / 4, width / 4])
      this.a.box(parent, x + sx, 0.42, z, 0.06, 0.28, depth - 0.1, "#5a3e10");
    for (const sz of [-depth / 4, depth / 4])
      this.a.box(parent, x, 0.42, z + sz, width - 0.12, 0.28, 0.06, "#5a3e10");
    // Leg posts
    for (const sx of [-width / 2 + 0.1, width / 2 - 0.1])
      for (const sz of [-depth / 2 + 0.1, depth / 2 - 0.1])
        this.a.box(parent, x + sx, 0.14, z + sz, 0.07, 0.28, 0.07, "#4a3010");
    // Section produce: tomatoes, onions, potatoes, bananas, apples, oranges
    const sections = [
      { ox: -width / 2 + 0.38, oz: -depth / 2 + 0.36, color: "#e03020", count: 12 }, // tomatoes
      { ox: -width / 2 + 0.38, oz: depth / 2 - 0.36, color: "#c0a040", count: 10 }, // onions
      { ox: width / 2 - 0.38, oz: -depth / 2 + 0.36, color: "#d09030", count: 10 }, // potatoes
      { ox: width / 2 - 0.38, oz: depth / 2 - 0.36, color: "#e8c020", count: 8 }, // bananas (box)
      { ox: 0, oz: -depth / 2 + 0.36, color: "#30c050", count: 10 }, // green veg
      { ox: 0, oz: depth / 2 - 0.36, color: "#f07000", count: 10 }, // oranges
    ];
    for (const sec of sections) {
      for (let i = 0; i < sec.count; i++) {
        const seed = i * 1664525 + 1013904223;
        const ox = ((seed & 0xff) / 255 - 0.5) * 0.26;
        const oz = (((seed >> 8) & 0xff) / 255 - 0.5) * 0.26;
        const oy = Math.floor(i / 5) * 0.1;
        const r = 0.075 + (((seed >> 16) & 0x1f) / 0x1f) * 0.025;
        this.a.round(parent, x + sec.ox + ox, 0.46 + oy, z + sec.oz + oz, r, r * 1.05, sec.color);
      }
    }
    // Section labels
    for (const [lx, lz, label] of [
      [-width / 2 + 0.38, -depth / 2 - 0.02, "Tomatoes"],
      [width / 2 - 0.38, -depth / 2 - 0.02, "Potatoes"],
      [0, depth / 2 + 0.02, "Oranges"],
    ] as [number, number, string][]) {
      const m = this.a.signLabel(label, "#2d5a10", "#f5f0e0");
      this.a.box(parent, x + lx, 0.22, z + lz, 0.55, 0.1, 0.02, m);
    }
  }

  fresProduceDisplay(parent: THREE.Object3D, x: number, z: number, width = 1.4) {
    this.a.box(parent, x, 0.5, z, width, 0.09, 0.88, "#7a5a18");
    this.a.box(parent, x, 0.45, z, width + 0.04, 0.035, 0.9, "#6a4e14");
    for (const sx of [-width / 2 + 0.1, width / 2 - 0.1])
      for (const sz of [-0.37, 0.37])
        this.a.box(parent, x + sx, 0.24, z + sz, 0.07, 0.48, 0.07, "#5c3d10");
    const produce = ["#ff5a2a", "#52b02a", "#f0c830", "#7030a0", "#e03030", "#40a8d0"];
    const sectionW = (width - 0.2) / produce.length;
    for (let s = 0; s < produce.length; s++) {
      const sx = x - width / 2 + 0.14 + s * sectionW + sectionW / 2;
      for (let i = 0; i < 5; i++) {
        const ix = sx + ((i % 3) - 1) * 0.09;
        const iz = z + (Math.floor(i / 3) - 0.4) * 0.19;
        this.a.round(parent, ix, 0.59 + (i % 2) * 0.04, iz, 0.07, 0.09, produce[s]);
      }
      this.a.box(parent, sx, 0.46, z + 0.44, 0.18, 0.09, 0.02, "#fffff0");
    }
  }

  /**
   * Manager station — professional desk with large analytics monitor showing charts.
   * No lamp (avoid office look). Used by Alice in Zone C.
   */
  managerStation(parent: THREE.Object3D, x: number, z: number, angle = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    // Counter surface — dark warm wood
    this.a.box(g, 0, 0.82, 0, 1.7, 0.09, 0.78, "#5a3818");
    this.a.box(g, 0, 0.82, 0, 1.66, 0.08, 0.74, this.a.texture("wood"));
    // Legs
    for (const sx of [-0.76, 0.76])
      for (const sz of [-0.32, 0.32]) this.a.box(g, sx, 0.39, sz, 0.065, 0.78, 0.065, "#2c2820");
    // Large curved monitor (showing analytics)
    this.a.box(g, 0, 0.96, -0.22, 0.045, 0.34, 0.22, "#1e1e1e");
    this.a.box(g, 0, 1.16, -0.24, 0.88, 0.52, 0.055, "#121212");
    this.a.box(g, 0, 1.16, -0.208, 0.76, 0.42, 0.014, this.a.texture("screen"));
    // Keyboard
    this.a.box(g, -0.05, 0.88, 0.12, 0.52, 0.025, 0.2, "#252f34");
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 9; col++)
        this.a.box(g, -0.23 + col * 0.05, 0.893, 0.06 + row * 0.05, 0.034, 0.006, 0.028, "#87918d");
    // Mouse
    this.a.box(g, 0.36, 0.89, 0.17, 0.07, 0.025, 0.1, "#91968a");
    // Papers / reports on desk
    this.a.box(g, 0.55, 0.86, 0.05, 0.38, 0.03, 0.28, "#e8e0d0");
    this.a.box(g, 0.52, 0.875, 0.04, 0.3, 0.02, 0.22, "#e0d8c8");
  }

  /** Old-style managerCounter — preserved for seat loop, no lamp. */
  managerCounter(parent: THREE.Object3D, x: number, z: number, angle = 0) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.rotation.y = angle;
    parent.add(g);
    this.a.box(g, 0, 0.8, 0, 1.55, 0.08, 0.72, this.a.texture("wood"));
    for (const sx of [-0.69, 0.69])
      for (const sz of [-0.3, 0.3]) this.a.box(g, sx, 0.38, sz, 0.065, 0.76, 0.065, "#303637");
    this.a.box(g, 0, 0.94, -0.16, 0.045, 0.3, 0.26, "#2e2e2e");
    this.a.box(g, 0, 1.12, -0.18, 0.72, 0.44, 0.05, "#1c1c1c");
    this.a.box(g, 0, 1.12, -0.154, 0.6, 0.35, 0.012, this.a.texture("screen"));
    this.a.box(g, 0.44, 0.86, 0.1, 0.4, 0.02, 0.3, "#f8f0e0");
    this.a.box(g, 0.44, 0.88, 0.08, 0.38, 0.02, 0.28, "#e0d8cc");
    // No lamp — removes the office desk appearance
  }

  cooler(parent: THREE.Object3D, x: number, z: number, width = 1.4) {
    // Main cabinet
    this.a.box(parent, x, 0.82, z - 0.02, width, 1.6, 0.54, "#c8d8e8");
    // Glass door panels with slight transparency
    const glassMat = this.a.material("#a8d0e8", 0.18, 0.15);
    glassMat.transparent = true;
    glassMat.opacity = 0.62;
    glassMat.depthWrite = false;
    const panelW = Math.min(0.62, width * 0.45);
    for (const sx of [-width / 4, width / 4])
      this.a.box(parent, x + sx, 0.85, z + 0.26, panelW, 1.52, 0.06, glassMat);
    // Door frame handles
    for (const sx of [-width / 4, width / 4])
      this.a.box(parent, x + sx + 0.28, 0.88, z + 0.3, 0.025, 0.5, 0.025, "#8898a8");
    // Dairy products inside — rows of milk, curd, butter
    const prodColors = [
      ["#fff8f0", "#f8f0e0"],
      ["#e8f8e8", "#d0f0d0"],
      ["#fff0e8", "#ffe8d8"],
      ["#e0f0ff", "#c8e8ff"],
    ];
    for (let row = 0; row < 4; row++) {
      const py = 0.18 + row * 0.36;
      const numP = Math.floor(width / 0.22);
      for (let col = 0; col < numP; col++) {
        const bx = x - width / 2 + 0.14 + col * 0.22;
        this.a.box(parent, bx, py, z - 0.08, 0.16, 0.3, 0.32, prodColors[row % 4][col % 2]);
      }
    }
    // Cold blue inner glow (refrigerator light)
    this.a.box(parent, x, 1.65, z - 0.1, width - 0.05, 0.04, 0.32, this.a.glow("#88ccff", 0.6));
    this.a.box(parent, x, 1.65, z + 0.02, width + 0.04, 0.07, 0.56, "#b0c8d8");
    this.a.box(parent, x, 0.05, z, width + 0.02, 0.1, 0.56, "#a8b8c8");
  }

  waitingBench(parent: THREE.Object3D, x: number, z: number, width = 1.5) {
    this.a.box(parent, x, 0.44, z, width, 0.1, 0.52, "#6b4c2a");
    this.a.box(parent, x, 0.4, z - 0.24, width + 0.04, 0.06, 0.04, "#5a3e22");
    for (const sx of [-width / 2 + 0.12, width / 2 - 0.12])
      for (const sz of [-0.2, 0.2])
        this.a.box(parent, x + sx, 0.2, z + sz, 0.08, 0.38, 0.08, "#4a3018");
    this.a.box(parent, x, 0.8, z + 0.24, width, 0.6, 0.08, "#5c4020");
    this.a.box(parent, x, 1.12, z + 0.28, width - 0.1, 0.08, 0.08, "#4a3218");
  }

  /** Store section sign — wall-mounted or on post. */
  storeSign(
    parent: THREE.Object3D,
    x: number,
    z: number,
    width = 2,
    text?: string,
    subtext?: string,
  ) {
    this.a.box(parent, x, 1.65, z, width, 1.25, 0.12, "#12223d");
    const face = this.a.signLabel(text ?? "", "#1a2850", "#f5c030", subtext);
    this.a.box(parent, x, 1.65, z + 0.07, width - 0.06, 1.12, 0.02, face);
    this.a.box(parent, x, 1.01, z + 0.15, width, 0.05, 0.22, "#2c5080");
  }

  board(parent: THREE.Object3D, x: number, z: number, width = 2) {
    this.a.box(parent, x, 1.65, z, width, 1.25, 0.12, "#403f38");
    this.a.box(parent, x, 1.65, z + 0.07, width - 0.12, 1.12, 0.02, this.a.texture("board"));
    this.a.box(parent, x, 1.01, z + 0.15, width, 0.05, 0.22, "#898f87");
  }
  water(parent: THREE.Object3D, x: number, z: number) {
    this.a.box(parent, x, 0.59, z, 0.49, 1.15, 0.44, "#5b6566");
    this.a.box(parent, x, 0.87, z + 0.23, 0.35, 0.32, 0.015, "#263237");
    this.a.round(parent, x, 1.45, z, 0.22, 0.48, this.a.material("#8cbcc7", 0.2, 0.3));
    this.a.box(parent, x, 1.07, z + 0.25, 0.09, 0.04, 0.04, "#b9af91");
    this.a.box(parent, x, 0.3, z + 0.23, 0.35, 0.18, 0.015, "#303c41");
  }
  table(parent: THREE.Object3D, x: number, z: number, width = 1.4) {
    this.a.box(parent, x, 0.78, z, width, 0.12, 0.85, this.a.texture("wood"));
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        this.a.box(
          parent,
          x + sx * (width / 2 - 0.12),
          0.37,
          z + sz * 0.3,
          0.065,
          0.74,
          0.065,
          "#353d36",
        );
    this.a.box(parent, x, 0.87, z, 0.26, 0.04, 0.34, "#e0d6b8");
    this.lamp(parent, x + 0.4, z - 0.1, 0.85);
  }
  sofa(parent: THREE.Object3D, x: number, z: number) {
    this.a.box(parent, x, 0.29, z, 1.6, 0.42, 0.8, "#3e4341");
    this.a.box(parent, x, 0.75, z - 0.33, 1.6, 0.65, 0.17, "#69685d");
    for (const sx of [-0.73, 0.73])
      this.a.box(parent, x + sx, 0.59, z, 0.18, 0.52, 0.83, "#5e6057");
    for (const sx of [-0.35, 0.35]) {
      this.a.box(parent, x + sx, 0.52, z, 0.62, 0.2, 0.65, "#79786b");
      this.a.box(parent, x + sx, 0.82, z - 0.22, 0.61, 0.4, 0.14, "#757468");
    }
  }

  /** Store entrance facade with red/white striped awning. Orient facing +Z (outward). */
  storeFront(parent: THREE.Object3D, x: number, z: number, width = 3.0) {
    // Facade wall
    this.a.box(parent, x, 0.95, z, width, 1.9, 0.28, "#5c3a1f");
    this.a.box(parent, x, 0.95, z + 0.12, width - 0.18, 1.82, 0.055, "#4a2c10");
    // Door opening frame
    this.a.box(parent, x, 0.78, z + 0.15, 0.9, 1.56, 0.08, "#3a2210");
    // Door glass
    const glass = this.a.material("#b8dde8", 0.08, 0.3);
    glass.transparent = true;
    glass.opacity = 0.52;
    glass.depthWrite = false;
    this.a.box(parent, x, 0.83, z + 0.19, 0.76, 1.3, 0.05, glass);
    // Awning mounting rod
    this.a.box(parent, x, 2.16, z + 0.18, width + 0.12, 0.065, 0.065, "#8b1a1a");
    // Awning stripe panels (red/white)
    const stripes = 8;
    for (let i = 0; i < stripes; i++) {
      const sw = width / stripes;
      const col = i % 2 ? "#f5f5f5" : "#cc2020";
      this.a.box(
        parent,
        x - width / 2 + sw / 2 + i * sw,
        1.96,
        z + 0.6,
        sw - 0.012,
        0.42,
        0.88,
        col,
      );
    }
    // Front edge rod
    this.a.box(parent, x, 1.75, z + 1.04, width + 0.12, 0.055, 0.055, "#8b1a1a");
    // Valance
    for (let i = 0; i < stripes; i++) {
      const sw = width / stripes;
      const col = i % 2 ? "#f5f5f5" : "#cc2020";
      this.a.box(
        parent,
        x - width / 2 + sw / 2 + i * sw,
        1.61,
        z + 1.04,
        sw - 0.012,
        0.26,
        0.04,
        col,
      );
    }
    // Store name sign
    const signMat = this.a.signLabel("KiranaCrew", "#0d1b36", "#f5c030", "General Store");
    this.a.box(parent, x, 1.52, z - 0.02, width - 0.28, 0.7, 0.14, "#0d1b36");
    this.a.box(parent, x, 1.52, z + 0.05, width - 0.36, 0.58, 0.022, signMat);
    // Window display shelves
    for (const sx of [-width / 2 + 0.44, width / 2 - 0.44])
      this.a.box(parent, x + sx, 0.66, z + 0.12, 0.5, 0.055, 0.22, "#7a5020");
    // Floor entrance mat
    const mat = this.a.signLabel("KiranaCrew", "#8b0000", "#f5c030");
    this.a.box(parent, x, 0.022, z + 0.62, 1.38, 0.042, 0.6, mat);
  }

  /** Red wire-frame shopping cart. */
  shoppingCart(parent: THREE.Object3D, x: number, z: number) {
    this.a.box(parent, x, 0.5, z, 0.54, 0.54, 0.72, "#cc3010");
    this.a.box(parent, x, 0.75, z, 0.6, 0.06, 0.78, "#aa2808");
    this.a.box(parent, x, 0.5, z, 0.46, 0.48, 0.64, "#dd4422");
    this.a.box(parent, x, 0.92, z - 0.44, 0.56, 0.07, 0.08, "#333333");
    for (const sx of [-0.2, 0.2])
      for (const sz of [-0.3, 0.3])
        this.a.round(parent, x + sx, 0.1, z + sz, 0.065, 0.09, "#1a1a1a");
  }

  /** Industrial metal storage rack for stockroom (4 levels). */
  metalStorageShelf(parent: THREE.Object3D, x: number, z: number, width = 2.2, levels = 4) {
    for (const sx of [-1, 1])
      for (const sz of [-1, 1])
        this.a.box(
          parent,
          x + sx * (width / 2 - 0.025),
          1.05,
          z + sz * 0.3,
          0.05,
          2.1,
          0.05,
          "#858585",
        );
    this.a.box(parent, x, 1.05, z - 0.28, width - 0.05, 2.1, 0.025, "#9a9a9a");
    const shelfCols = [
      ["#c49030", "#a87028", "#d4a840", "#b88028", "#e0b848"],
      ["#e05020", "#cc3010", "#d84020", "#c02010", "#e85030"],
      ["#4070c0", "#3060a0", "#5080d0", "#2850b0", "#4878c8"],
      ["#50a040", "#408030", "#60b050", "#308028", "#58a840"],
    ];
    for (let i = 0; i < levels; i++) {
      const sy = 0.12 + i * (1.9 / levels);
      this.a.box(parent, x, sy, z, width - 0.05, 0.04, 0.58, "#909090");
      const n = Math.floor((width - 0.3) / 0.36);
      for (let j = 0; j < n; j++) {
        const bx = x - (width / 2 - 0.2) + j * 0.36;
        const col = shelfCols[i % shelfCols.length][j % shelfCols[0].length];
        this.a.box(parent, bx, sy + 0.22, z - 0.01, 0.3, 0.38, 0.44, col);
      }
    }
  }

  /** Yellow pallet jack / hand truck for stockroom. */
  handTruck(parent: THREE.Object3D, x: number, z: number) {
    this.a.box(parent, x, 0.32, z + 0.08, 0.68, 0.62, 0.82, "#e8b820");
    this.a.box(parent, x, 0.38, z - 0.5, 0.66, 1.25, 0.09, "#c8a015");
    this.a.box(parent, x - 0.16, 0.28, z - 0.7, 0.09, 0.09, 0.7, "#d09815");
    this.a.box(parent, x + 0.16, 0.28, z - 0.7, 0.09, 0.09, 0.7, "#d09815");
    this.a.box(parent, x, 0.05, z + 0.45, 0.6, 0.1, 0.36, "#c8a015");
    for (const sx of [-0.22, 0.22]) {
      this.a.round(parent, x + sx, 0.13, z + 0.38, 0.1, 0.14, "#1a1a1a");
      this.a.round(parent, x + sx, 0.13, z - 0.22, 0.1, 0.14, "#1a1a1a");
    }
  }
}
