export function createColliderLocalCorners(THREE) {
  return [
    [-0.5, -0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, 0.5, 0.5],
    [0.5, -0.5, -0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, -0.5],
    [0.5, 0.5, 0.5],
  ].map((point) => new THREE.Vector3(...point));
}

export function normalizeRuntimeModelConfig(config = {}, { characterHeight = 2.2 } = {}) {
  const sourceModels = config?.models && typeof config.models === "object" ? config.models : {};
  return {
    version: config?.version || 1,
    models: Object.fromEntries(Object.entries(sourceModels).map(([modelId, model]) => [
      modelId,
      {
        label: model?.label || modelId,
        asset: model?.asset || `${modelId}.glb`,
        baseCollider: normalizeRuntimeBaseCollider(model?.baseCollider, { characterHeight }),
        partColliders: Array.isArray(model?.partColliders)
          ? model.partColliders.map(normalizeRuntimePartCollider).filter(Boolean)
          : [],
      },
    ])),
  };
}

export function normalizeRuntimeBaseCollider(value = {}, { characterHeight = 2.2 } = {}) {
  return {
    enabled: value?.enabled !== false,
    shape: "box",
    center: toRuntimeVectorArray(value?.center, [0, characterHeight / 2, 0]),
    size: toRuntimeVectorArray(value?.size, [0.75, characterHeight, 0.7]).map((item) => Math.max(0.001, item)),
    rotationDegrees: toRuntimeVectorArray(value?.rotationDegrees, [0, 0, 0]),
    strength: normalizeRuntimeNonNegativeNumber(value?.strength, 10),
  };
}

export function normalizeRuntimePartCollider(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.bone) return null;
  return {
    id: String(value.id || value.bone),
    name: String(value.name || value.id || value.bone),
    bone: String(value.bone),
    shape: "box",
    enabled: value.enabled !== false,
    offset: toRuntimeVectorArray(value.offset, [0, 0, 0]),
    size: toRuntimeVectorArray(value.size, [0.24, 0.24, 0.24]).map((item) => Math.max(0.001, item)),
    rotationDegrees: toRuntimeVectorArray(value.rotationDegrees, [0, 0, 0]),
    channels: Array.isArray(value.channels) ? value.channels.map(String).filter(Boolean) : ["hurt"],
    strength: normalizeRuntimeNonNegativeNumber(value.strength, 0),
  };
}

export function toRuntimeVectorArray(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [0, 1, 2].map((index) => {
    const number = Number(value[index]);
    return Number.isFinite(number) ? number : fallback[index];
  });
}

export function normalizeRuntimeNonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function getAttackCollidersForHitWindow(model, modelId, hitWindow) {
  const bindings = (hitWindow?.modelBindings || []).filter((binding) => (
    !binding.modelId || binding.modelId === modelId
  ));
  const colliderIds = new Set(bindings.flatMap((binding) => binding.attackColliderIds || []));
  if (!colliderIds.size) return [];
  return (model?.partColliders || []).filter((collider) => (
    colliderIds.has(collider.id)
    && collider.enabled !== false
    && (collider.channels || []).includes("attack")
  ));
}

export function getRuntimePartCollidersForChannel(model, channel) {
  return (model?.partColliders || []).filter((collider) => (
    collider.enabled !== false && (collider.channels || []).includes(channel)
  ));
}

export function createPartColliderWorldBox(THREE, character, collider, corners) {
  const bone = character?.scene?.getObjectByName(collider.bone);
  if (!bone) return null;
  return createColliderWorldBox(THREE, bone, collider, "part", corners);
}

export function createColliderWorldBox(THREE, parent, collider, type, corners) {
  parent.updateMatrixWorld(true);
  const position = toRuntimeVectorArray(type === "base" ? collider.center : collider.offset, [0, 0, 0]);
  const size = toRuntimeVectorArray(collider.size, [0.24, 0.24, 0.24]).map((item) => Math.max(0.001, Math.abs(item)));
  const rotation = toRuntimeVectorArray(collider.rotationDegrees, [0, 0, 0]);
  const localMatrix = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(
      THREE.MathUtils.degToRad(rotation[0]),
      THREE.MathUtils.degToRad(rotation[1]),
      THREE.MathUtils.degToRad(rotation[2]),
    )),
    new THREE.Vector3(...size),
  );
  const worldMatrix = new THREE.Matrix4().copy(parent.matrixWorld).multiply(localMatrix);
  const box = new THREE.Box3();
  const sourceCorners = corners || createColliderLocalCorners(THREE);
  sourceCorners.forEach((corner) => {
    box.expandByPoint(corner.clone().applyMatrix4(worldMatrix));
  });
  return box;
}

export function getCombatKnockbackDirection(THREE, attacker, move, worldUp) {
  const direction = getCharacterForward(THREE, attacker);
  if (move?.impact?.knockback?.customDirection) {
    direction.applyAxisAngle(
      worldUp || new THREE.Vector3(0, 1, 0),
      THREE.MathUtils.degToRad(Number(move.impact.knockback.directionDegrees) || 0),
    );
  }
  direction.y = 0;
  if (direction.lengthSq() <= 0.000001) direction.set(0, 0, 1);
  return direction.normalize();
}

export function getCharacterForward(THREE, character) {
  const direction = new THREE.Vector3(0, 0, 1);
  if (character?.root) direction.applyQuaternion(character.root.quaternion);
  direction.y = 0;
  if (direction.lengthSq() <= 0.000001) direction.set(0, 0, 1);
  return direction.normalize();
}
