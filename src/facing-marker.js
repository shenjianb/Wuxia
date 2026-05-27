export function createFacingMarker(THREE, { renderOrder = 5 } = {}) {
  const group = new THREE.Group();
  group.name = "FacingMarker";

  const material = new THREE.MeshBasicMaterial({
    color: 0xd6ff63,
    transparent: true,
    opacity: 0.88,
    depthTest: false,
    side: THREE.DoubleSide,
  });

  const shape = new THREE.Shape();
  shape.moveTo(0, 1);
  shape.lineTo(0.18, 0.64);
  shape.lineTo(-0.18, 0.64);
  shape.lineTo(0, 1);

  const arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  arrow.name = "FacingArrow";
  arrow.rotation.x = Math.PI / 2;
  group.add(arrow);

  group.renderOrder = renderOrder;
  group.visible = false;
  group.traverse((obj) => {
    obj.renderOrder = renderOrder;
  });

  return group;
}
