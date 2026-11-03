import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { PackageShape } from "./products";

/** Unit-sized reusable packaging; catalog dimensions determine each instance's size. */
export function createPackageGeometries(): Record<PackageShape, THREE.BufferGeometry> {
  const pouch = new RoundedBoxGeometry(1, 1, 1, 3, 0.1);
  const positions = pouch.getAttribute("position");
  for (let i = 0; i < positions.count; i++) {
    const y = positions.getY(i);
    const seal = Math.pow(Math.abs(y) * 2, 4);
    const x = positions.getX(i);
    const pleat = Math.sin(x * 48) * 0.014 * seal;
    positions.setXYZ(i, x * (1 - seal * 0.08), y, positions.getZ(i) * (1 - seal * 0.75) + pleat);
  }
  pouch.computeVertexNormals();
  const bottle = new THREE.LatheGeometry(
    [
      [0, -0.5],
      [0.38, -0.5],
      [0.49, -0.46],
      [0.5, -0.37],
      [0.48, 0.12],
      [0.44, 0.22],
      [0.26, 0.32],
      [0.2, 0.36],
      [0.2, 0.46],
      [0.22, 0.48],
      [0.22, 0.5],
      [0, 0.5],
    ].map(([r, y]) => new THREE.Vector2(r ?? 0, y ?? 0)),
    16,
  );
  // Folded milk-carton roof, normalized to the same catalog envelope.
  const gable = new THREE.BoxGeometry(1, 1, 1, 1, 4, 1);
  const roof = gable.getAttribute("position");
  for (let i = 0; i < roof.count; i++) {
    const y = roof.getY(i);
    if (y > 0.25) roof.setZ(i, roof.getZ(i) * Math.max(0.06, (1 - y * 2) * 2));
  }
  gable.computeVertexNormals();
  return {
    pouch,
    bottle,
    carton: new THREE.BoxGeometry(1, 1, 1),
    tin: new THREE.CylinderGeometry(0.5, 0.5, 1, 16),
    tub: new THREE.CylinderGeometry(0.5, 0.39, 1, 16),
    bar: new RoundedBoxGeometry(1, 1, 1, 2, 0.09),
    gable,
  };
}
