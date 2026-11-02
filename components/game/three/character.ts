import * as THREE from "three";
import { OfficeAssets } from "./assets";
import type { CrewActor } from "./crew";

/** Articulated voxel kirana store crew member with apron, posed per activity. */
export class OfficeCharacter {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  private head = new THREE.Group();
  private arms = [new THREE.Group(), new THREE.Group()];
  private legs = [new THREE.Group(), new THREE.Group()];
  private phase = 0;
  private seated = 0;
  private angle = 0;
  private initialized = false;
  private lastX = 0;
  private lastZ = 0;
  private ring: THREE.Mesh;
  private ringMaterial: THREE.MeshStandardMaterial;
  private prop = new THREE.Group();

  constructor(
    private a: OfficeAssets,
    readonly id: string,
    palette: { hair: string; shirt: string; skin: string; pants?: string },
    prop: "tablet" | "box" | "clipboard" | "none",
  ) {
    this.root.scale.setScalar(1.15);
    this.root.add(this.body);
    const b = (
      p: THREE.Object3D,
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      c: string,
    ) => a.box(p, x, y, z, w, h, d, c);
    const pants = palette.pants ?? "#38414c";
    b(this.body, 0, 0.78, 0, 0.43, 0.49, 0.29, palette.shirt);
    b(this.body, 0, 0.54, 0, 0.45, 0.07, 0.3, "#292f36");
    b(this.body, 0, 0.56, 0.16, 0.07, 0.04, 0.02, "#c1ad70");
    // store apron
    b(this.body, 0, 0.72, 0.15, 0.36, 0.42, 0.02, "#2f6b4a");
    b(this.body, 0, 0.82, 0.165, 0.12, 0.06, 0.01, "#f2c14e");
    this.head.position.y = 1.23;
    this.body.add(this.head);
    b(this.head, 0, 0, 0, 0.49, 0.46, 0.43, palette.skin);
    b(this.head, 0, 0.24, -0.015, 0.54, 0.17, 0.49, palette.hair);
    b(this.head, 0, 0.02, -0.22, 0.54, 0.39, 0.11, palette.hair);
    for (let i = 0; i < 5; i++)
      b(this.head, -0.21 + i * 0.105, 0.15 - (i % 3) * 0.045, 0.21, 0.11, 0.16, 0.1, palette.hair);
    for (const side of [-1, 1]) {
      b(this.head, side * 0.26, -0.025, 0, 0.07, 0.12, 0.13, palette.skin);
      b(this.head, side * 0.12, 0.005, 0.223, 0.052, 0.066, 0.025, "#25343b");
      b(this.head, side * 0.1, 0.02, 0.239, 0.014, 0.018, 0.008, "#f6e5c9");
    }
    b(this.head, 0, -0.08, 0.245, 0.08, 0.075, 0.07, palette.skin);
    b(this.head, 0, -0.15, 0.222, 0.09, 0.018, 0.018, "#8c5b4a");
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const arm = this.arms[i];
      if (!arm) continue;
      arm.name = `arm-${i}`;
      arm.position.set(side * 0.29, 0.95, 0);
      this.body.add(arm);
      b(arm, 0, -0.14, 0, 0.16, 0.31, 0.22, palette.shirt);
      b(arm, 0, -0.34, 0, 0.14, 0.14, 0.16, palette.skin);
      const leg = this.legs[i];
      if (!leg) continue;
      leg.name = `leg-${i}`;
      leg.position.set(side * 0.12, 0.52, 0);
      this.body.add(leg);
      b(leg, 0, -0.19, 0, 0.19, 0.38, 0.24, pants);
      b(leg, 0, -0.43, 0.05, 0.21, 0.13, 0.35, "#242b30");
    }
    this.prop.position.set(0, 0.78, 0.32);
    this.body.add(this.prop);
    if (prop === "tablet") {
      b(this.prop, 0, 0, 0, 0.3, 0.22, 0.03, "#1d2328");
      a.box(this.prop, 0, 0, 0.018, 0.26, 0.18, 0.01, a.glow("#7cc6e8", 0.8));
    } else if (prop === "box") {
      b(this.prop, 0, 0, 0.05, 0.42, 0.3, 0.3, "#c79a5b");
      b(this.prop, 0, 0.151, 0.05, 0.08, 0.005, 0.31, "#e8d3a6");
    } else if (prop === "clipboard") {
      b(this.prop, 0, 0, 0, 0.26, 0.32, 0.02, "#8a5a32");
      b(this.prop, 0, -0.01, 0.012, 0.22, 0.26, 0.01, "#f3efe4");
    }
    const geometry = new THREE.RingGeometry(0.34, 0.4, 32);
    geometry.rotateX(-Math.PI / 2);
    this.ringMaterial = new THREE.MeshStandardMaterial({
      color: "#f2b441",
      emissive: "#f2b441",
      emissiveIntensity: 0.9,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(geometry, this.ringMaterial);
    this.ring.position.y = 0.04;
    this.root.add(this.ring);
    this.root.traverse((o) => {
      o.userData["actorId"] = id;
    });
    this.phase = [...id].reduce((n, c) => n + c.charCodeAt(0), 0) % 37;
  }

  /**
   * Update character pose from CrewSim actor state plus optional backend status.
   * backendStatus: drives ring color when provided (working=amber, failed=red, done=green)
   * voiceActive: true when this agent is speaking via voice
   */
  update(
    actor: CrewActor,
    dt: number,
    selected: boolean,
    backendStatus?: string,
    voiceActive?: boolean,
  ) {
    this.root.position.set(actor.x, 0, actor.z);
    if (!this.initialized) {
      this.angle = actor.facing;
      this.lastX = actor.x;
      this.lastZ = actor.z;
      this.initialized = true;
    }
    const diff = Math.atan2(
      Math.sin(actor.facing - this.angle),
      Math.cos(actor.facing - this.angle),
    );
    this.angle += diff * (1 - Math.exp(-dt * 10));
    this.body.rotation.y = this.angle;
    const distance = Math.hypot(actor.x - this.lastX, actor.z - this.lastZ);
    this.lastX = actor.x;
    this.lastZ = actor.z;
    this.phase += actor.moving ? distance * 7 : dt * 1.5;
    const wantSeated = actor.pose === "seated" && !actor.moving ? 1 : 0;
    this.seated += (wantSeated - this.seated) * (1 - Math.exp(-dt * 7));
    this.body.position.y =
      0.015 + 0.04 * this.seated + (actor.moving ? Math.abs(Math.sin(this.phase)) * 0.012 : 0);
    const walking = actor.moving;
    const working = !walking && (actor.pose === "working" || actor.pose === "seated");
    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;
      const stride = walking ? Math.sin(this.phase) * 0.52 * sign : 0;
      const leg = this.legs[i],
        arm = this.arms[i];
      if (!leg || !arm) continue;
      leg.rotation.x = stride - this.seated * 1.25;
      const armTarget = walking
        ? actor.carrying
          ? -1.1
          : -stride * 0.65
        : working
          ? -0.85 + Math.sin(this.phase * 3 + sign) * 0.07
          : actor.pose === "talking"
            ? -0.4 + Math.sin(this.phase + sign) * 0.22
            : actor.pose === "reading"
              ? -0.9
              : actor.pose === "reaching"
                ? -2.2 + Math.sin(this.phase) * 0.15
                : actor.carrying
                  ? -1.1
                  : 0;
      arm.rotation.x += (armTarget - arm.rotation.x) * (1 - Math.exp(-dt * 12));
      arm.rotation.z = actor.pose === "talking" ? sign * 0.15 : 0;
    }
    this.prop.visible = actor.carrying || actor.pose === "reading";
    this.head.rotation.x =
      working || actor.pose === "reading" ? 0.14 : Math.sin(this.phase) * 0.015;
    this.head.rotation.y = !walking ? Math.sin(this.phase * 0.35) * 0.06 : 0;
    // Ring color: backend status takes priority when provided
    const color = selected
      ? "#ffd166"
      : voiceActive
        ? "#86bdcf"
        : backendStatus === "failed"
          ? "#e47667"
          : backendStatus === "completed" || actor.status === "done"
            ? "#74c392"
            : backendStatus === "running" ||
                backendStatus === "working" ||
                actor.status === "working"
              ? "#f2b441"
              : "#827b67";
    this.ring.visible =
      selected ||
      !!voiceActive ||
      actor.status !== "idle" ||
      (backendStatus !== undefined && backendStatus !== "idle");
    this.ringMaterial.color.set(color);
    this.ringMaterial.emissive.set(color);
  }

  dispose() {
    this.ring.geometry.dispose();
    this.ringMaterial.dispose();
    this.root.removeFromParent();
  }
}
