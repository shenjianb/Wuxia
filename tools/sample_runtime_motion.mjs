import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const CHARACTER_HEIGHT = 2.2;
const FOOT_BONES = ["Bip001_L_Foot", "Bip001_R_Foot", "Bip001_L_Toe0", "Bip001_R_Toe0"];

const loader = new GLTFLoader();

async function loadGltf(path) {
  const buffer = await readFile(path);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => loader.parse(arrayBuffer, "", resolve, reject));
}

function mergeAnimationClips(clips, name) {
  const tracks = clips.flatMap((clip) => clip.tracks.map((track) => track.clone()));
  return new THREE.AnimationClip(name, -1, tracks);
}

function retargetPositionTracks(clip, model, mode) {
  const clone = clip.clone();
  clone.tracks = clone.tracks.map((track) => {
    if (track.name.endsWith(".scale")) return null;
    if (track.name === "Root.quaternion") return null;
    if (track.name.endsWith(".position") && track.name !== "Root.position") return null;
    if (mode === "no-root-position" && track.name === "Root.position") return null;
    if (!track.name.endsWith(".position")) return track;

    const targetName = track.name.slice(0, -".position".length);
    const target = model.getObjectByName(targetName);
    if (!target || track.values.length < 3) return null;

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
  }).filter(Boolean);
  clone.resetDuration();
  return clone;
}

function normalizeModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = CHARACTER_HEIGHT / Math.max(size.y, 0.001);
  model.scale.multiplyScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= scaledBox.min.y;
}

function span(values, axis) {
  return Math.max(...values.map((value) => value[axis])) - Math.min(...values.map((value) => value[axis]));
}

async function sample(animationPath, mode) {
  const modelGltf = await loadGltf("public/assets/models/SK_BaseMale.glb");
  const animationGltf = await loadGltf(animationPath);
  const model = modelGltf.scene;
  model.rotation.x = Math.PI / 2;
  normalizeModel(model);

  const clip = retargetPositionTracks(mergeAnimationClips(animationGltf.animations, "clip"), model, mode);
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();

  const samples = Object.fromEntries(FOOT_BONES.map((name) => [name, []]));
  const steps = 48;
  for (let i = 0; i <= steps; i += 1) {
    const time = (clip.duration * i) / steps;
    mixer.setTime(time);
    model.updateMatrixWorld(true);

    for (const boneName of FOOT_BONES) {
      const bone = model.getObjectByName(boneName);
      if (!bone) continue;
      const pos = bone.getWorldPosition(new THREE.Vector3());
      samples[boneName].push([pos.x, pos.y, pos.z]);
    }
  }

  return {
    animation: animationPath,
    mode,
    duration: clip.duration,
    trackCounts: {
      total: clip.tracks.length,
      position: clip.tracks.filter((track) => track.name.endsWith(".position")).map((track) => track.name),
      scale: clip.tracks.filter((track) => track.name.endsWith(".scale")).map((track) => track.name),
      rootQuaternion: clip.tracks.filter((track) => track.name === "Root.quaternion").map((track) => track.name),
    },
    bones: Object.fromEntries(Object.entries(samples).map(([boneName, values]) => [
      boneName,
      {
        x: span(values, 0),
        y: span(values, 1),
        z: span(values, 2),
        xz: Math.hypot(span(values, 0), span(values, 2)),
        first: values[0],
        last: values.at(-1),
      },
    ])),
  };
}

const animation = process.argv[2] ?? "public/assets/animations/Anim_Normal_Idle2.glb";
const modes = ["current", "no-root-position"];
console.log(JSON.stringify(await Promise.all(modes.map((mode) => sample(animation, mode))), null, 2));
