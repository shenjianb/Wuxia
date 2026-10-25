import * as THREE from "three";

const ROOT_TRACK_NAME = "Root";
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Runtime compatibility: component-wise linear interpolation, including quaternions.
export function getTrackValueAtTime(track, time) {
  if (!track || !track.times.length) return null;
  const times = track.times;
  const values = track.values;
  const stride = track.values.length / track.times.length;
  
  if (time <= times[0]) {
    return Array.from(values.slice(0, stride));
  }
  if (time >= times[times.length - 1]) {
    return Array.from(values.slice(values.length - stride));
  }
  
  let i = 0;
  while (i < times.length - 1 && time > times[i + 1]) {
    i++;
  }
  
  const t0 = times[i];
  const t1 = times[i + 1];
  const alpha = (time - t0) / (t1 - t0);
  
  const strideOffset0 = i * stride;
  const strideOffset1 = (i + 1) * stride;
  
  const result = [];
  for (let j = 0; j < stride; j++) {
    result.push(values[strideOffset0 + j] + alpha * (values[strideOffset1 + j] - values[strideOffset0 + j]));
  }
  return result;
}

export function calculateClipRootCycle(clip) {
  if (clip._rootCycleData) return clip._rootCycleData;

  const posTrack = clip.tracks.find(t => t.name === "Root.position");
  const rotTrack = clip.tracks.find(t => t.name === "Root.quaternion" || t.name === "Root.rotation");
  
  const startPos = new THREE.Vector3();
  const endPos = new THREE.Vector3();
  const startRot = new THREE.Quaternion();
  const endRot = new THREE.Quaternion();
  
  if (posTrack) {
    const vStart = getTrackValueAtTime(posTrack, 0);
    const vEnd = getTrackValueAtTime(posTrack, clip.duration);
    if (vStart) startPos.fromArray(vStart);
    if (vEnd) endPos.fromArray(vEnd);
  }
  
  if (rotTrack) {
    const qStart = getTrackValueAtTime(rotTrack, 0);
    const qEnd = getTrackValueAtTime(rotTrack, clip.duration);
    if (qStart) {
      if (qStart.length === 4) startRot.fromArray(qStart);
      else if (qStart.length === 3) startRot.setFromEuler(new THREE.Euler().fromArray(qStart));
    }
    if (qEnd) {
      if (qEnd.length === 4) endRot.fromArray(qEnd);
      else if (qEnd.length === 3) endRot.setFromEuler(new THREE.Euler().fromArray(qEnd));
    }
  }
  
  clip._rootCycleData = {
    startPosition: startPos,
    endPosition: endPos,
    cyclePosition: new THREE.Vector3().subVectors(endPos, startPos),
    startRotation: startRot,
    endRotation: endRot,
    cycleRotation: new THREE.Quaternion().copy(startRot).invert().premultiply(endRot)
  };
  
  return clip._rootCycleData;
}

export function sampleClipRootMotion(clip, time) {
  const posTrack = clip.tracks.find((track) => track.name === "Root.position");
  const rotTrack = clip.tracks.find((track) => track.name === "Root.quaternion" || track.name === "Root.rotation");
  const sampleTime = clip.duration > 0 ? THREE.MathUtils.clamp(time, 0, clip.duration) : 0;
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();

  if (posTrack) {
    const value = getTrackValueAtTime(posTrack, sampleTime);
    if (value) position.fromArray(value);
  }

  if (rotTrack) {
    const value = getTrackValueAtTime(rotTrack, sampleTime);
    if (value?.length === 4) {
      quaternion.fromArray(value).normalize();
    } else if (value?.length === 3) {
      quaternion.setFromEuler(new THREE.Euler().fromArray(value));
    }
  }

  return { position, quaternion };
}

export function getDetrendedRootPose(clip, time, config = {}) {
  const sample = sampleClipRootMotion(clip, time).position;
  const cycleData = calculateClipRootCycle(clip);
  if (clip.duration <= 0) return sample;

  const alpha = THREE.MathUtils.clamp(time / clip.duration, 0, 1);
  if (config.bakeIntoPoseXZ !== false) {
    sample.x -= cycleData.cyclePosition.x * alpha;
    sample.z -= cycleData.cyclePosition.z * alpha;
  }
  if (config.bakeIntoPoseY) {
    sample.y -= cycleData.cyclePosition.y * alpha;
  }

  const swayScale = config.rootSwayScale ?? 1;
  if (swayScale < 1) {
    sample.x = cycleData.startPosition.x + (sample.x - cycleData.startPosition.x) * swayScale;
    sample.y = cycleData.startPosition.y + (sample.y - cycleData.startPosition.y) * swayScale;
    sample.z = cycleData.startPosition.z + (sample.z - cycleData.startPosition.z) * swayScale;
  }

  return sample;
}

export function getRootPoseQuaternion(clip, time, config = {}, anchorQuaternion = new THREE.Quaternion()) {
  if (!config.rootPoseRotation) return anchorQuaternion.clone();

  const cycleData = calculateClipRootCycle(clip);
  const currRot = sampleClipRootMotion(clip, time).quaternion;
  const deltaRot = new THREE.Quaternion()
    .copy(cycleData.startRotation)
    .invert()
    .premultiply(currRot);
  const poseRot = deltaRot.multiply(anchorQuaternion).normalize();
  const scale = THREE.MathUtils.clamp(config.rootPoseRotationScale ?? 1, 0, 1);

  return anchorQuaternion.clone().slerp(poseRot, scale);
}

export function getRootPoseRotationAnchorQuaternion(clip, config = {}, fallbackQuaternion = new THREE.Quaternion()) {
  if (config.rootPoseRotationAnchor === "clipStart") {
    return sampleClipRootMotion(clip, 0).quaternion;
  }
  return fallbackQuaternion.clone();
}

export function getInPlaceRootPoseQuaternion(clip, time, config = {}, restQuaternion = new THREE.Quaternion()) {
  if (!clip || config.bakeIntoPoseRotation !== false) {
    return restQuaternion.clone();
  }

  const hasRootRotationTrack = clip.tracks.some((track) =>
    track.name === "Root.quaternion" || track.name === "Root.rotation",
  );
  if (!hasRootRotationTrack) return restQuaternion.clone();

  return sampleClipRootMotion(clip, time).quaternion;
}

export function computeAnimNaturalSpeed(clip, character) {
  if (!clip || clip.duration <= 0) return 0;
  const cycleData = calculateClipRootCycle(clip);
  const localDisp = cycleData.cyclePosition;
  if (!localDisp) return 0;

  character.root.updateMatrixWorld(true);
  const m3 = new THREE.Matrix3().setFromMatrix4(character.scene.matrixWorld);
  const worldDisp = localDisp.clone().applyMatrix3(m3);
  const xzDist = Math.sqrt(worldDisp.x * worldDisp.x + worldDisp.z * worldDisp.z);
  return xzDist / clip.duration;
}

export function getCodeMoveDirection(clip, config = {}, rootYaw = 0) {
  const localDirection = new THREE.Vector3(0, 0, 1);

  if (config.codeMoveBasis === "clipRootDelta") {
    if (clip) {
      const cycleDelta = calculateClipRootCycle(clip).cyclePosition.clone();
      cycleDelta.y = 0;
      if (cycleDelta.lengthSq() > 0.000001) {
        localDirection.copy(cycleDelta.normalize());
      }
    }
  }

  if (Array.isArray(config.codeMoveLocalDirection) && config.codeMoveLocalDirection.length >= 3) {
    localDirection.set(
      Number(config.codeMoveLocalDirection[0]) || 0,
      Number(config.codeMoveLocalDirection[1]) || 0,
      Number(config.codeMoveLocalDirection[2]) || 0,
    );
    localDirection.y = 0;
    if (localDirection.lengthSq() <= 0.000001) localDirection.set(0, 0, 1);
    localDirection.normalize();
  }

  const yawOffset = THREE.MathUtils.degToRad(config.codeMoveYawOffsetDegrees ?? 0);
  return localDirection
    .applyAxisAngle(WORLD_UP, yawOffset)
    .applyAxisAngle(WORLD_UP, rootYaw)
    .normalize();
}

export function getRootMotionDeltaWorld(clip, config = {}, character, deltaPos) {
  character.scene.updateMatrixWorld(true);
  const sceneScale = character.scene.getWorldScale(new THREE.Vector3());
  const scaledLocalDelta = new THREE.Vector3(
    deltaPos.x * sceneScale.x,
    0,
    deltaPos.z * sceneScale.z,
  );

  if (config.rootMotionMoveBasis === "characterForward") {
    const cycleDelta = clip
      ? calculateClipRootCycle(clip).cyclePosition.clone()
      : new THREE.Vector3(0, 0, 1);
    cycleDelta.y = 0;
    if (cycleDelta.lengthSq() <= 0.000001) cycleDelta.set(0, 0, 1);
    cycleDelta.normalize();

    let signedDistance = scaledLocalDelta.dot(cycleDelta);
    if (config.rootMotionForwardOnly) signedDistance = Math.max(0, signedDistance);
    if (Math.abs(signedDistance) <= 0.000001) return new THREE.Vector3();
    return getCodeMoveDirection(clip, config, character.root.rotation.y).multiplyScalar(signedDistance);
  }

  const localDelta = scaledLocalDelta.clone();
  if (config.rootMotionForwardOnly && clip) {
    const cycleDelta = calculateClipRootCycle(clip).cyclePosition.clone();
    cycleDelta.y = 0;
    if (cycleDelta.lengthSq() > 0.000001) {
      cycleDelta.normalize();
      const signedDistance = localDelta.dot(cycleDelta);
      if (signedDistance < 0) localDelta.addScaledVector(cycleDelta, -signedDistance);
    }
  }

  return localDelta
    .applyAxisAngle(WORLD_UP, character.sceneRestRotationY ?? 0)
    .applyQuaternion(character.root.quaternion);
}

export function filterAnimationTracks(clip, model, config) {
  // Missing whole configs get defaults; partial configs are not merged with them.
  config = config || {
    motionMode: "InPlace",
    bakeIntoPoseXZ: true,
    bakeIntoPoseY: true,
    bakeIntoPoseRotation: true
  };

  const clone = clip.clone();
  clone.tracks = clone.tracks.map((track) => {
    const targetName = getTrackTargetName(track.name);
    if (track.name.endsWith(".scale")) return null;

    if (targetName === ROOT_TRACK_NAME) {
      if (isRotationTrack(track.name)) {
        if (config.motionMode === "InPlace" && config.bakeIntoPoseRotation) return null;
        if (config.motionMode === "RootMotion" && config.applyRootRotation === false) return null;
      }
      if (track.name.endsWith(".position") && config.motionMode === "InPlace") {







        const numKeys = track.times.length;
        if (numKeys >= 2) {
          const stride = 3;
          const values = new track.values.constructor(track.values.length);
          const duration = track.times[numKeys - 1] - track.times[0];
          const t0 = track.times[0];

          const startX = track.values[0], startY = track.values[1], startZ = track.values[2];
          const endIdx = (numKeys - 1) * stride;
          const endX = track.values[endIdx], endY = track.values[endIdx + 1], endZ = track.values[endIdx + 2];

          const driftRateX = duration > 0 ? (endX - startX) / duration : 0;
          const driftRateY = duration > 0 ? (endY - startY) / duration : 0;
          const driftRateZ = duration > 0 ? (endZ - startZ) / duration : 0;
          
          for (let i = 0; i < numKeys; i++) {
            const t = track.times[i] - t0;

            values[i * stride]     = track.values[i * stride]     - (config.bakeIntoPoseXZ ? driftRateX * t : 0);
            values[i * stride + 1] = track.values[i * stride + 1] - (config.bakeIntoPoseY  ? driftRateY * t : 0);
            values[i * stride + 2] = track.values[i * stride + 2] - (config.bakeIntoPoseXZ ? driftRateZ * t : 0);
          }





          const swayScale = config.rootSwayScale ?? 1.0;
          if (swayScale < 1.0) {
            const baseX = values[0], baseY = values[1], baseZ = values[2];
            for (let i = 1; i < numKeys; i++) {
              values[i * stride]     = baseX + (values[i * stride]     - baseX) * swayScale;
              values[i * stride + 1] = baseY + (values[i * stride + 1] - baseY) * swayScale;
              values[i * stride + 2] = baseZ + (values[i * stride + 2] - baseZ) * swayScale;
            }
          }
          
          return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
        }
      }
    }

    if (targetName !== ROOT_TRACK_NAME && track.name.endsWith(".position")) {
      if (targetName === "Bip001_Pelvis" || targetName === "Bip001 Pelvis") {
        const target = model.getObjectByName(targetName);
        if (target && track.values.length >= 3) {
          const values = new track.values.constructor(track.values.length);
          const firstX = track.values[0];
          const firstY = track.values[1];
          const firstZ = track.values[2];
          
          for (let i = 0; i < track.values.length; i += 3) {

            values[i] = target.position.x + (track.values[i] - firstX);
            values[i + 1] = target.position.y + (track.values[i + 1] - firstY);
            values[i + 2] = target.position.z + (track.values[i + 2] - firstZ);
          }
          return new THREE.VectorKeyframeTrack(track.name, track.times.slice(), values);
        }
      }
      return null; 
    }
    return track;
  }).filter(Boolean);
  
  clone.resetDuration();
  return clone;
}

export function getTrackTargetName(trackName) {
  const dotIndex = trackName.lastIndexOf(".");
  return dotIndex === -1 ? trackName : trackName.slice(0, dotIndex);
}

export function isRotationTrack(trackName) {
  return trackName.endsWith(".rotation") || trackName.endsWith(".quaternion");
}

export function getPlaybackScale(config = {}, naturalSpeed, { defaultSpeed = 2, controlScale = 1, min = 0, max = 3 } = {}) {
  const configuredSpeed = Number(config.codeMoveSpeed);
  const speed = Number.isFinite(configuredSpeed) && configuredSpeed >= 0 ? configuredSpeed : defaultSpeed;
  return naturalSpeed > 0.1
    ? THREE.MathUtils.clamp(speed / naturalSpeed * controlScale, min, max)
    : controlScale < 1 ? controlScale : 1;
}

export function getPlaybackPolicy(config = {}, { attack = false, previewLoop } = {}) {
  const once = previewLoop === undefined ? config.loop === false || attack : !previewLoop;
  return { loop: once ? THREE.LoopOnce : THREE.LoopRepeat, repetitions: once ? 1 : Infinity, clampWhenFinished: once };
}

// One clip traversal, clamped to [0, duration]. Output position is a world delta;
// quaternion is absolute outer orientation. No collision, transitions or foot lock.
// Clone only transforms so seeking neither mutates the caller nor accumulates drift.
export function computeIntegratedRootMotion(clip, config = {}, character, targetTime, { baseYaw = 0, steps = 120, codeMovement = true } = {}) {
  if (!Number.isFinite(targetTime) || !Number.isFinite(steps) || steps < 1 || !Number.isFinite(baseYaw)) {
    throw new RangeError("Seek time/yaw must be finite and steps must be >= 1");
  }
  const time = THREE.MathUtils.clamp(targetTime, 0, Math.max(0, clip.duration));
  const root = new THREE.Group();
  root.scale.copy(character.root.scale);
  root.rotation.set(0, baseYaw, 0);
  const scene = new THREE.Group();
  scene.position.copy(character.scene.position);
  scene.scale.copy(character.scene.scale);
  scene.quaternion.copy(character.scene.quaternion);
  scene.rotation.y = (character.sceneRestRotationY ?? 0) + THREE.MathUtils.degToRad(config.visualYawOffsetDegrees ?? 0);
  root.add(scene);
  const proxy = { root, scene, sceneRestRotationY: character.sceneRestRotationY };
  if (config.motionMode === "RootMotion" && time > 0) {
    const count = Math.max(1, Math.ceil(steps * time / clip.duration));
    let previous = sampleClipRootMotion(clip, 0);
    for (let i = 1; i <= count; i++) {
      const current = sampleClipRootMotion(clip, time * i / count);
      if (config.applyRootRotation !== false) {
        const delta = previous.quaternion.clone().invert().premultiply(current.quaternion);
        root.updateMatrixWorld(true);
        const parent = new THREE.Quaternion().setFromRotationMatrix(scene.matrixWorld);
        const world = parent.clone().multiply(delta).multiply(parent.clone().invert());
        const yaw = new THREE.Euler().setFromQuaternion(world, "YXZ").y;
        root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yaw));
      }
      const delta = current.position.clone().sub(previous.position);
      delta.y = 0;
      root.position.add(getRootMotionDeltaWorld(clip, config, proxy, delta));
      previous = current;
    }
  } else if (codeMovement && (config.motionMode ?? "InPlace") === "InPlace") {
    // Attack previews disable code movement; RootMotion remains independent.
    // Code movement exists only when explicitly configured for this preview.
    // Convert clip-time to seconds at the gameplay speed-matched playback rate.
    const speed = Number(config.codeMoveSpeed);
    root.updateMatrixWorld(true);
    const rate = getPlaybackScale(config, computeAnimNaturalSpeed(clip, proxy));
    if (Number.isFinite(speed) && speed >= 0 && rate > 0) {
      root.position.copy(getCodeMoveDirection(clip, config, baseYaw)).multiplyScalar(speed * time / rate);
    }
  }
  return { position: root.position.clone(), quaternion: root.quaternion.clone(), time };
}

// Dedicated single-action preview only. Callers create action from the filtered
// clip, keep immutable rest transforms, and own repeat policy/base world position.
// No mixer.update(wallTime): evaluate the pose at the requested clip-time exactly.
export function applyPreviewPose(character, action, clip, time, config = {}, { baseYaw = 0, codeMovement = true } = {}) {
  const motion = computeIntegratedRootMotion(clip, config, character, time, { baseYaw, codeMovement });
  const skeletonRoot = character.scene.getObjectByName(ROOT_TRACK_NAME);
  if (!character.rootRestPosition || !character.rootRestQuaternion) {
    throw new TypeError("Preview requires immutable rootRestPosition and rootRestQuaternion");
  }
  action.getMixer().stopAllAction();
  if (skeletonRoot) {
    skeletonRoot.position.copy(character.rootRestPosition);
    skeletonRoot.quaternion.copy(character.rootRestQuaternion);
  }
  character.root.position.copy(motion.position);
  character.root.quaternion.copy(motion.quaternion);
  character.scene.rotation.y = (character.sceneRestRotationY ?? 0) + THREE.MathUtils.degToRad(config.visualYawOffsetDegrees ?? 0);
  action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1).play();
  // LoopOnce prevents duration from wrapping to zero during an endpoint seek.
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.time = motion.time;
  action.getMixer().update(0);
  action.paused = true;
  if (skeletonRoot && config.motionMode === "RootMotion") {
    const pose = getDetrendedRootPose(clip, motion.time, config);
    skeletonRoot.position.copy(character.rootRestPosition).add(pose).sub(getDetrendedRootPose(clip, 0, config));
    skeletonRoot.position.y = pose.y;
    const anchor = getRootPoseRotationAnchorQuaternion(clip, config, character.rootRestQuaternion);
    skeletonRoot.quaternion.copy(getRootPoseQuaternion(clip, motion.time, config, anchor));
  } else if (skeletonRoot && config.motionMode === "InPlace" && config.bakeIntoPoseRotation !== false) {
    skeletonRoot.quaternion.copy(character.rootRestQuaternion);
  }
  character.root.updateMatrixWorld(true);
  return motion;
}
