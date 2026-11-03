import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { OfficeAssets } from "./assets";
import { buildStore } from "./store";
import { CrewCharacter } from "./character";
import { CREW, CrewSim, type CrewActor } from "./crew";
import {
  CAMERA_FRAME,
  PERSPECTIVE_VIEW,
  perspectiveDistance,
  placeLabels,
  type LabelAnchor,
  type ScreenRect,
} from "./scene-config";

export type Lighting = "daylight" | "evening";

const ISO_DIRECTION = new THREE.Vector3(
  0,
  PERSPECTIVE_VIEW.elevation,
  PERSPECTIVE_VIEW.forward,
).normalize();
/** Look & glow tuning */
const BLOOM_STRENGTH = 0.22;
const BLOOM_RADIUS = 0.5;
const BLOOM_THRESHOLD = 1.6;
const LAMP_DAY = 2.5;
const LAMP_EVENING = 5;

export class StoreRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private perspective = new THREE.PerspectiveCamera(PERSPECTIVE_VIEW.fov, 1, 0.1, 300);
  private orthographic = new THREE.OrthographicCamera(-15, 15, 11, -11, 0.1, 300);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  private renderPass: RenderPass;
  private controls: OrbitControls;
  private assets = new OfficeAssets();
  private sim: CrewSim;
  private chars = new Map<string, CrewCharacter>();
  private labels = new Map<string, { el: HTMLButtonElement; act: HTMLSpanElement }>();
  private labelLayer = document.createElement("div");
  private observer: ResizeObserver;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private lamps: THREE.PointLight[] = [];
  private envTarget: THREE.WebGLRenderTarget;
  private storeGroup: THREE.Group;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private bulbMat = new THREE.MeshStandardMaterial({
    color: "#fff1d6",
    emissive: "#ffcf86",
    emissiveIntensity: 6,
  });
  private bulbGeo = new THREE.SphereGeometry(0.09, 10, 8);
  private raf = 0;
  private last = 0;
  private selected: string | null = null;
  private topDown = false;
  private zoneMeshes: THREE.Mesh[] = [];
  private spinners: THREE.Object3D[] = [];
  private disposed = false;
  private readyMarked = false;
  private v = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();
  private down = { x: 0, y: 0 };
  private fly: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    tf: THREE.Vector3;
    tt: THREE.Vector3;
    z0: number;
    t: number;
  } | null = null;
  private placed: { x: number; y: number }[] = [];
  private signs: THREE.Object3D[] = [];
  private labelPositions = new Map<string, { x: number; y: number }>();
  private tethers = new Map<string, HTMLSpanElement>();

  constructor(
    private host: HTMLElement,
    private onSelect: (id: string | null) => void,
    private onActors: (actors: CrewActor[]) => void,
    private onZone: (id: string | null) => void,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.scene.background = new THREE.Color("#0d0907");
    this.renderer.domElement.className = "store-canvas";
    this.renderer.domElement.setAttribute(
      "aria-label",
      "Interactive 3D KiranaCrew store. Drag to pan, right-drag to rotate, scroll to zoom.",
    );
    host.append(this.renderer.domElement);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.55;
    room.dispose();
    pmrem.dispose();

    this.camera.position.copy(this.defaultPosition());
    this.camera.lookAt(0, 0.8, CAMERA_FRAME.targetZ);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.8, CAMERA_FRAME.targetZ);
    this.controls.enableDamping = true;
    this.controls.minZoom = 0.7;
    this.controls.maxZoom = 3;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI * 0.42;
    this.controls.minAzimuthAngle = -0.45;
    this.controls.maxAzimuthAngle = 0.45;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 0.6;
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    this.controls.screenSpacePanning = true;

    this.hemi = new THREE.HemisphereLight("#fff0d8", "#514338", 0.85);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight("#ffd9a3", 2.0);
    this.sun.position.set(-8, 18, 10);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -18, right: 18, top: 14, bottom: -14 });
    this.sun.shadow.normalBias = 0.015;
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun);
    const fill = new THREE.DirectionalLight("#ffc98a", 0.5);
    fill.position.set(10, 8, -6);
    this.scene.add(fill);

    const { group, lampPositions, zones, spinners, collisions } = buildStore(this.assets);
    this.sim = new CrewSim(CREW, collisions);
    if (process.env.NODE_ENV === "development") {
      const debug = {
        get state() {
          return {
            actors: simulation.actors.map((a) => ({ ...a })),
            boundaries: collisions.boundaries,
          };
        },
        sim: (seconds: number) => {
          for (let i = 0; i < Math.ceil(Math.min(seconds, 600) * 60); i++) this.sim.step(1 / 60);
        },
        lighting: (mode: Lighting) => this.setLighting(mode),
        topDown: (v: boolean) => this.setTopDown(v),
        get camera() {
          return {
            type: view.camera.type,
            position: view.camera.position.toArray(),
            zoom: view.camera.zoom,
          };
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const view = this;
      const simulation = this.sim;
      (window as Window & { __game?: typeof debug }).__game = debug;
    }
    this.storeGroup = group;
    group.traverse((o) => {
      if (o.userData["signSize"]) this.signs.push(o);
    });
    this.zoneMeshes = zones.map((z) => z.mesh);
    this.spinners = spinners;
    this.scene.add(group);
    // warm pools of light (limit count for perf)
    const shadeGeo = new THREE.ConeGeometry(0.16, 0.12, 16, 1, false);
    const shadeMat = this.assets.material("#bd9560", 0.65, 0.25);
    shadeMat.side = THREE.DoubleSide;
    for (const p of lampPositions) {
      const bulb = new THREE.Mesh(this.bulbGeo, this.bulbMat);
      bulb.position.copy(p);
      const shade = new THREE.Mesh(shadeGeo, shadeMat);
      shade.position.set(p.x, p.y + 0.08, p.z);
      group.add(bulb, shade);
      const stem = this.assets.cylinderMesh(group, p.x, p.y + 0.25, p.z, 0.018, 0.25, "#b9a481");
      stem.castShadow = false;
    }
    lampPositions
      .filter((_, i) => i % 2 === 0)
      .forEach((p) => {
        const l = new THREE.PointLight("#ffb866", LAMP_DAY, 8, 1.5);
        l.position.copy(p);
        this.scene.add(l);
        this.lamps.push(l);
      });

    for (const def of CREW) {
      const c = new CrewCharacter(this.assets, def.id, def.palette, def.prop);
      this.chars.set(def.id, c);
      this.scene.add(c.root);
      const el = document.createElement("button");
      const tether = document.createElement("span");
      tether.className = "crew-tether";
      this.labelLayer.append(tether);
      this.tethers.set(def.id, tether);
      el.type = "button";
      el.className = "crew-label";
      el.innerHTML = `<strong></strong><span class="crew-label-sub"><i class="crew-dot"></i><span class="crew-role"></span></span>`;
      const strong = el.querySelector("strong");
      const act = el.querySelector<HTMLSpanElement>(".crew-role");
      if (!strong || !act) continue;
      strong.textContent = def.name;
      el.addEventListener("click", () => this.select(def.id));
      this.labelLayer.append(el);
      this.labels.set(def.id, { el, act });
    }
    this.labelLayer.className = "crew-labels";
    host.append(this.labelLayer);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(256, 256),
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.renderer.domElement.addEventListener("pointerdown", this.pDown);
    this.renderer.domElement.addEventListener("pointerup", this.pUp);
    this.raf = requestAnimationFrame(this.frame);
  }

  private pDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY };
  };
  private pUp = (e: PointerEvent) => {
    if (e.button !== 0 || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 5) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      ),
      this.camera,
    );
    const hit = this.raycaster.intersectObjects(
      [...this.chars.values()].map((c) => c.root),
      true,
    )[0];
    const id = hit?.object.userData["actorId"];
    this.select(typeof id === "string" ? id : null);
    if (typeof id === "string") return;
    const zHit = this.raycaster.intersectObjects(this.zoneMeshes, false)[0];
    const zid = zHit?.object.userData["zoneId"];
    this.onZone(typeof zid === "string" ? zid : null);
  };

  select(id: string | null) {
    this.selected = id;
    this.onSelect(id);
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    const aspect = w / h;
    const halfH = Math.max(
      this.topDown ? 9.8 : CAMERA_FRAME.halfHeight,
      CAMERA_FRAME.halfWidth / aspect,
    );
    Object.assign(this.orthographic, {
      left: -halfH * aspect,
      right: halfH * aspect,
      top: halfH,
      bottom: -halfH,
    });
    this.orthographic.updateProjectionMatrix();
    this.perspective.aspect = aspect;
    if (!this.topDown) {
      const direction = this.camera.position.clone().sub(this.controls.target).normalize();
      this.camera.position
        .copy(this.controls.target)
        .addScaledVector(direction, perspectiveDistance(aspect));
      this.camera.zoom = 1;
    }
    this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }

  private defaultPosition() {
    const aspect = Math.max(1, this.host.clientWidth) / Math.max(1, this.host.clientHeight);
    return new THREE.Vector3(0, 0.8, CAMERA_FRAME.targetZ).addScaledVector(
      ISO_DIRECTION,
      perspectiveDistance(aspect),
    );
  }

  recenter() {
    this.fly = {
      from: this.camera.position.clone(),
      to: this.topDown ? new THREE.Vector3(0, 40, 0.01) : this.defaultPosition(),
      tf: this.controls.target.clone(),
      tt: new THREE.Vector3(0, this.topDown ? 0 : 0.8, this.topDown ? 0 : CAMERA_FRAME.targetZ),
      z0: this.camera.zoom,
      t: 0,
    };
  }

  setTopDown(v: boolean) {
    if (v === this.topDown) return;
    this.topDown = v;
    this.fly = null;
    this.camera = v ? this.orthographic : this.perspective;
    this.controls.object = this.camera;
    this.renderPass.camera = this.camera;
    this.camera.position.copy(v ? new THREE.Vector3(0, 40, 0.01) : this.defaultPosition());
    this.controls.target.set(0, v ? 0 : 0.8, v ? 0 : CAMERA_FRAME.targetZ);
    this.camera.zoom = 1;
    this.camera.lookAt(this.controls.target);
    this.controls.enableRotate = !v;
    this.resize();
    this.recenter();
  }

  setLighting(mode: Lighting) {
    const day = mode === "daylight";
    this.hemi.intensity = day ? 0.85 : 0.55;
    this.sun.intensity = day ? 2.0 : 0.45;
    this.sun.color.set(day ? "#ffd9a3" : "#9fb4ff");
    this.lamps.forEach((l) => (l.intensity = day ? LAMP_DAY : LAMP_EVENING));
    this.bulbMat.emissiveIntensity = day ? 6 : 9;
    this.bloom.strength = day ? BLOOM_STRENGTH : BLOOM_STRENGTH * 1.6;
    this.renderer.toneMappingExposure = day ? 0.9 : 0.88;
  }

  /** Push live agent activities (from the backend) into the crew sim. */
  setLiveActivities(map: Record<string, string>) {
    this.sim.setActivities(map);
  }

  setPaused(v: boolean) {
    this.sim.setPaused(v);
  }

  private frame = (t: number) => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.last ? Math.min((t - this.last) / 1000, 0.05) : 0.016;
    this.last = t;
    this.sim.step(dt);
    for (const s of this.spinners) s.rotation.y += dt * 3;
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dt / 0.6);
      const k = 1 - Math.pow(1 - f.t, 3);
      this.camera.position.lerpVectors(f.from, f.to, k);
      this.controls.target.lerpVectors(f.tf, f.tt, k);
      this.camera.zoom = f.z0 + (1 - f.z0) * k;
      this.camera.updateProjectionMatrix();
      if (f.t >= 1) this.fly = null;
    }
    const actors = this.sim.actors;
    this.controls.update();
    this.camera.updateMatrixWorld();
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const obstacles: ScreenRect[] = this.signs.map((sign) => {
      const size = sign.userData["signSize"] as { width: number; height: number };
      const points = [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ].map(([x, y]) => {
        const v = new THREE.Vector3(
          ((x ?? 0) * size.width) / 2,
          ((y ?? 0) * size.height) / 2,
          0.02,
        );
        sign.localToWorld(v);
        v.project(this.camera);
        return { x: ((v.x + 1) * w) / 2, y: ((1 - v.y) * h) / 2 };
      });
      const xs = points.map((p) => p.x),
        ys = points.map((p) => p.y);
      return {
        x: Math.min(...xs) - 3,
        y: Math.min(...ys) - 3,
        width: Math.max(...xs) - Math.min(...xs) + 6,
        height: Math.max(...ys) - Math.min(...ys) + 6,
      };
    });
    const anchors: LabelAnchor[] = [];
    for (const a of actors) {
      this.chars.get(a.id)?.update(a, dt, this.selected === a.id);
      const lab = this.labels.get(a.id);
      if (!lab) continue;
      const txt = `${a.role} · ${a.activity}`;
      if (lab.act.textContent !== txt) lab.act.textContent = txt;
      lab.el.title = `${a.name} — ${txt}`;
      lab.el.dataset["selected"] = String(this.selected === a.id);
      this.v.set(a.x, 1.98, a.z).project(this.camera);
      const onScreen = Math.abs(this.v.x) <= 1.05 && Math.abs(this.v.y) <= 1.05;
      lab.el.hidden = !onScreen;
      const tether = this.tethers.get(a.id);
      if (tether) tether.hidden = !onScreen;
      if (onScreen)
        anchors.push({
          id: a.id,
          x: ((this.v.x + 1) * w) / 2,
          y: ((1 - this.v.y) * h) / 2,
          width: lab.el.offsetWidth || 146,
          height: lab.el.offsetHeight || 40,
        });
    }
    const positions = placeLabels(
      anchors,
      w,
      Math.max(100, h - CAMERA_FRAME.controlSpace),
      obstacles,
    );
    for (const [id, rect] of positions) {
      const lab = this.labels.get(id);
      if (!lab) continue;
      const old = this.labelPositions.get(id) ?? rect;
      const k = 1 - Math.exp(-dt * 16);
      const pos = {
        x: Math.max(6, Math.min(w - rect.width - 6, old.x + (rect.x - old.x) * k)),
        y: Math.max(
          6,
          Math.min(h - CAMERA_FRAME.controlSpace - rect.height - 6, old.y + (rect.y - old.y) * k),
        ),
      };
      this.labelPositions.set(id, pos);
      lab.el.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      const anchor = anchors.find((a) => a.id === id);
      const tether = this.tethers.get(id);
      if (anchor && tether) {
        const startX = pos.x + rect.width / 2,
          startY = pos.y + rect.height;
        const dx = anchor.x - startX,
          dy = anchor.y - startY;
        tether.style.width = `${Math.hypot(dx, dy)}px`;
        tether.style.transform = `translate(${startX}px, ${startY}px) rotate(${Math.atan2(dy, dx)}rad)`;
      }
    }
    this.onActors(actors);
    this.composer.render();
    if (!this.readyMarked) {
      this.readyMarked = true;
      this.host.dataset["sceneReady"] = "true";
    }
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.controls.dispose();
    this.chars.forEach((c) => c.dispose());
    (this.storeGroup.userData["dispose"] as (() => void) | undefined)?.();
    this.assets.dispose();
    this.envTarget.dispose();
    this.composer.dispose();
    this.bulbGeo.dispose();
    this.bulbMat.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
    if (process.env.NODE_ENV === "development")
      delete (window as Window & { __game?: unknown }).__game;
  }
}
