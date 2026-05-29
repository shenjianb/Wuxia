import * as THREE from "three/webgpu";

const TILE_SIZE = 1.35;
const ARROW_LENGTH = 1.2;
const ARROW_SHAFT_R = 0.04;
const ARROW_CONE_R = 0.1;
const ARROW_CONE_L = 0.22;
const GIZMO_OPACITY_NORMAL = 0.7;
const GIZMO_OPACITY_HOVER = 1;

let objectIdCounter = 1;

export function createVoxelCube(color = 0x56624f) {
  const geometry = new THREE.BoxGeometry(TILE_SIZE, TILE_SIZE, TILE_SIZE);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = "VoxelCube";
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.isVoxelCube = true;
  return group;
}

export function createVoxelCampfire() {
  const group = new THREE.Group();
  const logMat = new THREE.MeshStandardMaterial({ color: 0x49301f, roughness: 0.92 });
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0xff6b25,
    emissive: 0xff3d00,
    emissiveIntensity: 2.5,
    roughness: 0.5,
  });
  const logGeo = new THREE.BoxGeometry(0.22, 0.22, 1.3);
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(logGeo, logMat);
    log.position.y = 0.1;
    log.rotation.y = (Math.PI / 4) * i;
    log.castShadow = true;
    group.add(log);
  }
  const flameGeo = new THREE.BoxGeometry(0.38, 0.52, 0.38);
  for (let i = 0; i < 3; i++) {
    const flame = new THREE.Mesh(flameGeo, emberMat);
    flame.name = "VoxelFlame";
    flame.position.set((i - 1) * 0.12, 0.38 + i * 0.12, (i % 2) * 0.12);
    flame.rotation.y = i * 0.65;
    group.add(flame);
  }
  group.userData.isVoxelCampfire = true;
  return group;
}

function createArrowMesh(colorHex, direction) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: GIZMO_OPACITY_NORMAL,
    depthTest: false,
  });

  const shaftLen = ARROW_LENGTH - ARROW_CONE_L;
  const shaftGeo = new THREE.CylinderGeometry(ARROW_SHAFT_R, ARROW_SHAFT_R, shaftLen, 8);
  const shaft = new THREE.Mesh(shaftGeo, mat);
  shaft.position.y = shaftLen / 2;
  group.add(shaft);

  const coneGeo = new THREE.ConeGeometry(ARROW_CONE_R, ARROW_CONE_L, 8);
  const cone = new THREE.Mesh(coneGeo, mat);
  cone.position.y = shaftLen + ARROW_CONE_L / 2;
  group.add(cone);

  group.renderOrder = 10;
  group.traverse((obj) => { obj.renderOrder = 10; });
  group.userData.gizmoAxis = direction;
  group.userData._origColorHex = colorHex;

  return group;
}

export class GizmoManager {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = "TransformGizmo";
    this.group.renderOrder = 10;
    this.group.visible = false;

    this.arrowX = createArrowMesh(0xff3333, "x");
    this.arrowY = createArrowMesh(0x33ff33, "y");
    this.arrowZ = createArrowMesh(0x3366ff, "z");

    this.arrowX.rotation.z = -Math.PI / 2;
    this.arrowZ.rotation.x = Math.PI / 2;

    this.group.add(this.arrowX, this.arrowY, this.arrowZ);

    this.arrows = [this.arrowX, this.arrowY, this.arrowZ];
    this.getIntersectables = () => {
      const result = [];
      for (const arrow of this.arrows) {
        arrow.traverse((obj) => { if (obj.isMesh) result.push(obj); });
      }
      return result;
    };

    this.activeAxis = null;
    this.dragPlane = new THREE.Plane();
    this.dragStart = new THREE.Vector3();
    this.dragCurrent = new THREE.Vector3();
    this.worldStart = new THREE.Vector3();
    this._axisVectors = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    };
  }

  showAt(position) {
    this.group.position.copy(position);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
    this.activeAxis = null;
    this.resetHighlights();
  }

  resetHighlights() {
    for (const arrow of this.arrows) {
      arrow.traverse((obj) => {
        if (obj.isMesh && obj.material) {
          obj.material.opacity = GIZMO_OPACITY_NORMAL;
          obj.material.color.set(obj.userData._origColorHex ?? obj.material.color.getHex());
        }
      });
    }
  }

  highlightAxis(axis) {
    this.resetHighlights();
    const arrow = this.arrows.find((a) => a.userData.gizmoAxis === axis);
    if (arrow) {
      arrow.traverse((obj) => {
        if (obj.isMesh && obj.material) {
          obj.material.opacity = GIZMO_OPACITY_HOVER;
          obj.material.color.set(0xffff00);
        }
      });
    }
  }

  startDrag(axis, raycaster, mouseNDC, camera) {
    this.activeAxis = axis;
    const axisVec = this._axisVectors[axis];
    const cameraDir = new THREE.Vector3();
    camera.getWorldDirection(cameraDir);

    const planeNormal = new THREE.Vector3().crossVectors(cameraDir, axisVec).normalize();
    if (planeNormal.length() < 0.001) {
      planeNormal.set(0, 1, 0);
    }
    this.dragPlane.setFromNormalAndCoplanarPoint(
      planeNormal,
      this.group.position,
    );

    const intersect = new THREE.Vector3();
    raycaster.ray.intersectPlane(this.dragPlane, intersect);
    this.dragStart.copy(intersect);
    this.worldStart.copy(this.group.position);
  }

  updateDrag(raycaster, camera) {
    if (!this.activeAxis) return new THREE.Vector3();

    const intersect = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(this.dragPlane, intersect);
    if (!hit) return new THREE.Vector3();

    const delta = new THREE.Vector3().subVectors(intersect, this.dragStart);
    const axisVec = this._axisVectors[this.activeAxis];
    const projected = delta.dot(axisVec);
    return axisVec.clone().multiplyScalar(projected);
  }

  endDrag() {
    this.activeAxis = null;
    this.resetHighlights();
  }

  get isDragging() {
    return !!this.activeAxis;
  }
}

export class ObjectManager {
  constructor(scene, loader) {
    this.scene = scene;
    this.loader = loader;
    this.objects = [];
    this.gizmo = new GizmoManager();
    this.selectedId = null;
    this.wireframeParent = new THREE.Group();
    this.wireframeParent.name = "ObjectWireframes";
    this.wireframeParent.visible = false;
    this.scene.add(this.wireframeParent);
  }

  async createObject(type, position) {
    const id = `obj_${objectIdCounter++}`;
    let group;

    switch (type) {
      case "voxelCube":
        group = createVoxelCube();
        break;
      case "voxelCampfire":
        group = createVoxelCampfire();
        break;
      case "male":
      case "female": {
        const url = `./assets/models/SK_Base${type === "male" ? "Male" : "Female"}.glb`;
        try {
          const gltf = await this.loader.loadAsync(url);
          group = new THREE.Group();
          group.add(gltf.scene);
          normalizeImportedModel(gltf.scene);
          gltf.scene.traverse((obj) => {
            if (obj.isMesh || obj.isSkinnedMesh) {
              obj.castShadow = true;
              obj.receiveShadow = true;
            }
          });
        } catch (e) {
          console.error(`Failed to load ${type} model:`, e);
          group = createVoxelCube();
        }
        break;
      }
      default:
        group = createVoxelCube();
    }

    group.position.copy(position);
    group.name = `Placeable_${type}_${id}`;
    group.userData.objectId = id;
    group.userData.objectType = type;
    this.scene.add(group);

    const wireframe = this.createWireframeForGroup(group);
    wireframe.visible = this.wireframeParent.visible;

    const objData = {
      id,
      type,
      group,
      wireframe,
      position: position.clone(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
    };

    this.objects.push(objData);
    return id;
  }

  createWireframeForGroup(group) {
    const wfGroup = new THREE.Group();
    wfGroup.name = `Wireframe_${group.name}`;
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x79d2c0,
      transparent: true,
      opacity: 0.5,
      depthTest: true,
    });

    group.traverse((obj) => {
      if (obj.isMesh && obj.geometry) {
        const edges = new THREE.EdgesGeometry(obj.geometry);
        const line = new THREE.LineSegments(edges, edgeMat);
        obj.getWorldPosition(line.position);
        obj.getWorldQuaternion(line.quaternion);
        obj.getWorldScale(line.scale);
        wfGroup.add(line);
      }
    });

    this.wireframeParent.add(wfGroup);
    return wfGroup;
  }

  updateWireframe(objData) {
    if (!objData.wireframe) return;
    this.wireframeParent.remove(objData.wireframe);
    objData.wireframe.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
    });
    const newWf = this.createWireframeForGroup(objData.group);
    objData.wireframe = newWf;
    newWf.visible = this.wireframeParent.visible;
  }

  toggleWireframes(visible) {
    this.wireframeParent.visible = visible;
    for (const obj of this.objects) {
      if (obj.wireframe) obj.wireframe.visible = visible;
    }
  }

  removeObject(id) {
    const idx = this.objects.findIndex((o) => o.id === id);
    if (idx === -1) return false;
    const obj = this.objects[idx];
    this.scene.remove(obj.group);
    if (obj.wireframe) this.wireframeParent.remove(obj.wireframe);
    if (this.selectedId === id) this.deselect();
    this.objects.splice(idx, 1);
    return true;
  }

  select(id) {
    this.deselect();
    const obj = this.objects.find((o) => o.id === id);
    if (!obj) return;
    this.selectedId = id;
    this.gizmo.showAt(obj.group.position.clone());
    this.scene.add(this.gizmo.group);
  }

  deselect() {
    this.selectedId = null;
    this.gizmo.hide();
    this.scene.remove(this.gizmo.group);
  }

  getSelected() {
    if (!this.selectedId) return null;
    return this.objects.find((o) => o.id === this.selectedId) || null;
  }

  getObject(id) {
    return this.objects.find((o) => o.id === id) || null;
  }

  getObjectList() {
    return this.objects.slice();
  }

  getAllGroups() {
    return this.objects.map((o) => o.group);
  }

  hitTest(raycaster) {
    const groups = this.getAllGroups();
    const meshes = [];
    for (const group of groups) {
      group.traverse((obj) => { if (obj.isMesh) meshes.push(obj); });
    }
    const hits = raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;

    for (const obj of this.objects) {
      let found = false;
      obj.group.traverse((child) => {
        if (child === hits[0].object) found = true;
      });
      if (found) return obj.id;
    }
    return null;
  }

  setPosition(id, x, y, z) {
    const obj = this.getObject(id);
    if (!obj) return;
    obj.group.position.set(x, y, z);
    obj.position.set(x, y, z);
    if (this.selectedId === id) this.gizmo.showAt(obj.group.position.clone());
    this.updateWireframe(obj);
  }

  setRotation(id, x, y, z) {
    const obj = this.getObject(id);
    if (!obj) return;
    obj.group.rotation.set(x, y, z);
    obj.rotation.set(x, y, z);
    this.updateWireframe(obj);
  }

  setScale(id, x, y, z) {
    const obj = this.getObject(id);
    if (!obj) return;
    obj.group.scale.set(x, y, z);
    obj.scale.set(x, y, z);
    this.updateWireframe(obj);
  }

  resetScale(id) {
    this.setScale(id, 1, 1, 1);
  }

  resetRotation(id) {
    this.setRotation(id, 0, 0, 0);
  }

  serialize() {
    return this.objects.map((o) => ({
      id: o.id,
      type: o.type,
      position: [o.position.x, o.position.y, o.position.z],
      rotation: [o.rotation.x, o.rotation.y, o.rotation.z],
      scale: [o.scale.x, o.scale.y, o.scale.z],
    }));
  }

  async deserialize(objectsData) {
    for (const obj of this.objects) {
      this.scene.remove(obj.group);
      if (obj.wireframe) this.wireframeParent.remove(obj.wireframe);
    }
    this.objects = [];
    this.deselect();

    for (const d of objectsData) {
      const id = await this.createObject(d.type, new THREE.Vector3(
        d.position[0], d.position[1], d.position[2],
      ));
      const obj = this.getObject(id);
      if (obj && d.rotation) {
        this.setRotation(id, d.rotation[0], d.rotation[1], d.rotation[2]);
      }
      if (obj && d.scale) {
        this.setScale(id, d.scale[0], d.scale[1], d.scale[2]);
      }
    }
  }

  updateWireframePositions() {
    for (const obj of this.objects) {
      this.updateWireframe(obj);
    }
  }
}

function normalizeImportedModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const targetHeight = 2.2;
  const scale = targetHeight / Math.max(size.y, 0.001);
  model.scale.multiplyScalar(scale);
  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  const minY = scaledBox.min.y;
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= minY;
}
