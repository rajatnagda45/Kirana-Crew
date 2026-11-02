import { describe, expect, it } from "vitest";
import { OfficeAssets } from "@/components/game/three/assets";
import { OfficeCharacter } from "@/components/game/three/character";
import { worldPosition, shortestAngle } from "@/components/game/three/types";
import type { CrewActor } from "@/components/game/three/crew";

const DEFAULT_PALETTE = { hair: "#744b35", shirt: "#48566b", skin: "#d3a182" };

const actor: CrewActor = {
  id: "alice",
  name: "Alice",
  role: "Manager",
  activity: "Orchestrating",
  x: 0,
  z: 0,
  facing: 0,
  moving: false,
  pose: "standing",
  carrying: false,
  status: "idle",
};

describe("3D office presentation boundary", () => {
  it("maps the Tiled navigation coordinate system to world space without changing simulation data", () => {
    expect(worldPosition(680, 500)).toEqual({ x: 0, z: 0 });
    expect(worldPosition(728, 548)).toEqual({ x: 1, z: 1 });
    // CrewActor uses direct Three.js coords; verify character root position matches
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id, DEFAULT_PALETTE, "none");
    const a: CrewActor = { ...actor, x: 3.5, z: -2.1 };
    model.update(a, 1 / 60, false);
    expect(model.root.position.x).toBeCloseTo(3.5);
    expect(model.root.position.z).toBeCloseTo(-2.1);
    model.dispose();
    assets.dispose();
  });

  it("turns along the shortest arc across the angle boundary", () => {
    expect(shortestAngle(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });

  it("only types while genuine work pose is active", () => {
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id, DEFAULT_PALETTE, "tablet");
    const arm = model.root.getObjectByName("arm-0")!;
    model.update(actor, 1 / 60, false);
    expect(arm.rotation.x).toBe(0);
    // settle into working pose for several frames (arm smooths toward target)
    for (let i = 0; i < 60; i++)
      model.update({ ...actor, pose: "working" }, 1 / 60, false, "running");
    expect(arm.rotation.x).toBeLessThan(-0.7);
    model.dispose();
    assets.dispose();
  });

  it("reconciles speaking gestures toward rest when the actual call ends", () => {
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id, DEFAULT_PALETTE, "none");
    // settle into talking pose for several frames
    for (let i = 0; i < 60; i++)
      model.update({ ...actor, pose: "talking" }, 1 / 60, false, undefined, true);
    const arm = model.root.getObjectByName("arm-0")!;
    const peakRotation = arm.rotation.x;
    expect(peakRotation).not.toBe(0);
    // returning to standing smoothly moves arm back toward 0
    for (let i = 0; i < 60; i++) model.update(actor, 1 / 60, false, undefined, false);
    expect(Math.abs(arm.rotation.x)).toBeLessThan(Math.abs(peakRotation));
    model.dispose();
    assets.dispose();
  });

  it("moving character position tracks crew actor coords", () => {
    const assets = new OfficeAssets();
    const model = new OfficeCharacter(assets, actor.id, DEFAULT_PALETTE, "none");
    model.update({ ...actor, moving: true, x: 5.0, z: 3.2 }, 1 / 60, false);
    expect(model.root.position.x).toBeCloseTo(5.0);
    expect(model.root.position.z).toBeCloseTo(3.2);
    model.dispose();
    assets.dispose();
  });
});
