import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { parseAst } from "rollup/parseAst";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { getAllCombatMoves, normalizeCombatMoveManager, inferAnimationFileForActionName } from "../src/combat-move-manager.js";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root));
const json = path => JSON.parse(read(path));
const hash = data => createHash("sha256").update(data).digest("hex");
const source = read("src/main.js").toString();
const ast = parseAst(source);
const functions = Object.fromEntries(ast.body.filter(n => n.type === "FunctionDeclaration").map(n => [n.id.name, source.slice(n.start, n.end)]));
const extractedNames = new Set(["getTrackValueAtTime", "calculateClipRootCycle", "sampleClipRootMotion", "getDetrendedRootPose", "getRootPoseQuaternion", "getRootPoseRotationAnchorQuaternion", "getInPlaceRootPoseQuaternion", "computeAnimNaturalSpeed", "getConfiguredCodeMoveDirection", "getRootMotionDeltaWorld", "filterAnimationTracks", "getTrackTargetName", "isRotationTrack"]);
const preservedRuntimeSHA256 = hash(ast.body.filter(n => !(n.type === "FunctionDeclaration" && extractedNames.has(n.id.name)) && !(n.type === "ImportDeclaration" && n.source.value === "./animation-motion.js")).map(n => source.slice(n.start, n.end)).join("\n"));
const config = json("public/assets/animations/motion_config.json");
const manager = normalizeCombatMoveManager(json("public/assets/combat/move_manager.json"));
const fixturePath = "tools/fixtures/animation-runtime-baseline.json";
const baseline = json(fixturePath);
assert.ok(!process.argv.includes("--capture-metrics"), "Baseline is immutable: captured from the pre-extraction runtime, not regenerable from shared code");
assert.equal(preservedRuntimeSHA256, baseline.preservedRuntimeSHA256, "Non-math runtime AST changed");
const strictBaseline = process.argv.includes("--strict-baseline");
const changedInputs = Object.entries(baseline.assetSHA256).filter(([path, expected]) => hash(read(path)) !== expected).map(([path]) => path);
if (strictBaseline) assert.deepEqual(changedInputs, [], "Strict baseline inputs changed");
const assets = {};
const assetNode = ast.body.find(n => n.type === "VariableDeclaration" && n.declarations.some(d => d.id.name === "ASSETS"));
const assetContext = vm.createContext({ assetUrl: x => x });
vm.runInContext(source.slice(assetNode.start, assetNode.end) + "\nglobalThis.assets = ASSETS;", assetContext);
Object.entries(assetContext.assets.animations).forEach(([name, path]) => { assets[name] = "public/" + path.replace(/^\.\//, ""); });
for (const move of getAllCombatMoves(manager)) {
  for (const [name, explicit] of [[move.actionName, move.actionFile], [move.impact?.hitstun?.hitActionName, ""]]) {
    if (name && !assets[name]) assets[name] = "public/assets/animations/" + (explicit || inferAnimationFileForActionName(name, [], config));
  }
}
for (const name of Object.keys(config)) if (!assets[name]) assets[name] = "public/assets/animations/" + inferAnimationFileForActionName(name, [], config);
for (const file of readdirSync(new URL("public/assets/animations/", root)).filter(x => x.endsWith(".glb"))) {
  const path = "public/assets/animations/" + file;
  if (!Object.values(assets).includes(path)) assets["asset:" + file] = path;
}
const animations = {};
const oracle = vm.createContext({ THREE, animations, motionConfig: {}, WORLD_UP: new THREE.Vector3(0, 1, 0), ROOT_TRACK_NAME: "Root", CHARACTER_HEIGHT: 2.2, PLAYER_SPEED: 2, isCombatAttackAction: () => false });
// Keep geometry/skin/bones, but strip texture references before GLTFLoader parses.
async function glb(path) {
  const bytes = read(path), length = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + length).toString());
  for (const material of document.materials || []) {
    for (const key of Object.keys(material)) if (/texture/i.test(key)) delete material[key];
    for (const key of Object.keys(material.pbrMetallicRoughness || {})) if (/texture/i.test(key)) delete material.pbrMetallicRoughness[key];
    delete material.extensions;
  }
  document.images = []; document.textures = [];
  const binary = bytes.subarray(20 + length), encoded = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 32); encoded.copy(padded);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + binary.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const data = Buffer.concat([header, padded, binary]);
  return new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
}
for (const [name, path] of Object.entries(assets)) animations[name] = new THREE.AnimationClip(name, -1, (await glb(path)).animations.flatMap(c => c.tracks.map(t => t.clone())));
const shared = await import("../src/animation-motion.js");
const bindings = ast.body.find(n => n.type === "ImportDeclaration" && n.source.value === "./animation-motion.js");
assert.ok(bindings, "Runtime must explicitly import shared math");
for (const specifier of bindings.specifiers) oracle[specifier.local.name] = shared[specifier.imported.name];
vm.runInContext([...extractedNames].map(name => functions[name]).join("\n"), oracle);
const api = process.argv.includes("--runtime-wrappers") ? {
  ...shared,
  ...Object.fromEntries([...extractedNames].filter(n => !["computeAnimNaturalSpeed", "getConfiguredCodeMoveDirection", "getRootMotionDeltaWorld", "filterAnimationTracks"].includes(n)).map(n => [n, oracle[n]])),
  getCodeMoveDirection: (clip, cfg, yaw) => oracle.getConfiguredCodeMoveDirection(clip.name, { root: { rotation: { y: yaw } } }),
  computeAnimNaturalSpeed: (clip, character) => oracle.computeAnimNaturalSpeed(clip.name, character),
  getRootMotionDeltaWorld: (clip, cfg, character, delta) => oracle.getRootMotionDeltaWorld(clip.name, character, delta),
  filterAnimationTracks: (clip, model) => oracle.filterAnimationTracks(clip, model),
} : shared;
const metrics = {}, restTransforms = {}, probes = {};
let metricKey = "misc", checks = 0;
function plain(value) {
  if (value?.toArray) return value.toArray();
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return Array.from(value, plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}
function record(value, label) {
  metrics[metricKey] ??= createHash("sha256");
  metrics[metricKey].update(JSON.stringify([label, plain(value)], (k, v) => typeof v === "number" && !Number.isFinite(v) ? String(v) : v));
  checks++;
}
function clipData(clip) { return { duration: clip.duration, tracks: clip.tracks.map(t => ({ name: t.name, times: t.times, values: t.values, interpolation: t.getInterpolation() })) }; }
const variants = [undefined, {}, { motionMode: "InPlace" }, { motionMode: "RootMotion" }, { motionMode: "InPlace", bakeIntoPoseXZ: true, bakeIntoPoseY: true, bakeIntoPoseRotation: true, rootSwayScale: 0.35 }, { motionMode: "RootMotion", applyRootRotation: false, rootPoseRotation: true, rootPoseRotationAnchor: "clipStart", rootPoseRotationScale: 0.4, rootMotionMoveBasis: "characterForward", rootMotionForwardOnly: true, codeMoveBasis: "clipRootDelta", codeMoveYawOffsetDegrees: 37 }, { motionMode: "RootMotion", rootPoseRotation: true, rootPoseRotationScale: 2, rootSwayScale: 1.5, rootMotionForwardOnly: true, codeMoveLocalDirection: [-1, 8, 2] }, { motionMode: "InPlace", bakeIntoPoseRotation: false, codeMoveLocalDirection: [0, 1, 0] }];
for (const gender of ["Male", "Female"]) {
  const model = (await glb("public/assets/models/SK_Base" + gender + ".glb")).scene;
  // Unchanged runtime normalization is exercised against frozen rest snapshots.
  vm.runInContext(functions.normalizeModel, oracle);
  oracle.normalizeModel(model);
  const outer = new THREE.Group(); outer.add(model);
  const bone = model.getObjectByName("Root");
  const character = { root: outer, scene: model, sceneRestRotationY: model.rotation.y, rootRestPosition: bone.position.clone(), rootRestQuaternion: bone.quaternion.clone() };
  restTransforms[gender] = [];
  model.traverse(o => { if (o.isBone) restTransforms[gender].push({ name: o.name, position: o.position.toArray(), quaternion: o.quaternion.toArray(), scale: o.scale.toArray() }); });
  for (const [name, original] of Object.entries(animations)) {
    for (const [variant, cfg] of [config[name], ...variants].entries()) {
      metricKey = gender + "/" + name + "/" + variant;
      oracle.motionConfig = cfg === undefined ? {} : { [name]: cfg };
      const clip = original.clone();
      record(api.calculateClipRootCycle(clip), "cycle");
      assert.equal(api.calculateClipRootCycle(clip), clip._rootCycleData);
      record(clipData(api.filterAnimationTracks(clip, model, cfg)), "filter");
      for (const track of clip.tracks) {
        record(api.getTrackTargetName(track.name), "target");
        record(api.isRotationTrack(track.name), "rotation");
      }
      for (const fraction of [-0.1, 0, 0.137, 0.5, 0.999, 1, 1.2]) {
        const t = fraction * clip.duration;
        for (const track of clip.tracks.filter(t => t.name.startsWith("Root."))) record(api.getTrackValueAtTime(track, t), "track");
        record(api.sampleClipRootMotion(clip, t), "sample");
        record(api.getDetrendedRootPose(clip, t, cfg), "detrend");
        for (const anchor of [bone.quaternion, new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.7, 0.3))]) {
          record(api.getRootPoseQuaternion(clip, t, cfg, anchor), "pose");
          record(api.getRootPoseRotationAnchorQuaternion(clip, cfg, anchor), "anchor");
          record(api.getInPlaceRootPoseQuaternion(clip, t, cfg, anchor), "inplace");
        }
      }
      for (const yaw of [-2.1, 0, 0.8]) for (const scale of [0.5, 1, 2]) {
        outer.rotation.y = yaw; outer.scale.set(scale, scale * 0.8, scale * 1.3);
        model.rotation.y = character.sceneRestRotationY + 0.4;
        outer.updateMatrixWorld(true);
        record(api.getCodeMoveDirection(clip, cfg, yaw), "direction");
        record(api.computeAnimNaturalSpeed(clip, character), "speed");
        for (const delta of [new THREE.Vector3(1, 3, -2), new THREE.Vector3(-2, 1, 1), new THREE.Vector3()]) record(api.getRootMotionDeltaWorld(clip, cfg, character, delta), "world");
      }
      for (const attack of [false, true]) for (const previewLoop of [undefined, false, true]) record(api.getPlaybackPolicy(cfg, { attack, previewLoop }), "policy");
    }
    probes[gender + "/" + name] = plain({ duration: original.duration, cycle: api.calculateClipRootCycle(original), midpoint: api.sampleClipRootMotion(original, original.duration / 2) });
  }
}
metricKey = "playback";
for (const cfg of [{}, { codeMoveSpeed: 0 }, { codeMoveSpeed: 1 }, { codeMoveSpeed: "4" }, { codeMoveSpeed: -1 }, { codeMoveSpeed: "bad" }]) for (const natural of [0, 0.1, 0.11, 2, 10]) for (const control of [0, 0.3, 1]) record(api.getPlaybackScale(cfg, natural, { controlScale: control }), "scale");
const digests = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, value.digest("hex")]));
if (changedInputs.length === 0) {
  assert.deepEqual(restTransforms, baseline.restTransforms, "Model bone rest transforms changed");
  assert.deepEqual(probes, baseline.probes, "Readable runtime probes differ");
  for (const [key, digest] of Object.entries(digests)) assert.equal(digest, baseline.metrics[key], "Runtime snapshot differs: " + key);
  assert.deepEqual(Object.keys(digests), Object.keys(baseline.metrics), "Snapshot coverage changed");
  console.log("PASS: " + checks + " snapshots; " + Object.keys(assets).length + " animation assets; male/female bones; runtime " + baseline.sourceSHA256);
} else {
  console.log("SKIP: frozen asset parity (inputs tuned: " + changedInputs.join(", ") + "). Current assets still sampled; deterministic/analytic tests continue. Use --strict-baseline to require original inputs.");
}

const close = (a, b, label) => {
  const left = plain(a), right = plain(b);
  assert.equal(left.length, right.length, label);
  left.forEach((v, i) => assert.ok(Math.abs(v - right[i]) < 1e-8, label + ": " + v + " != " + right[i]));
};
let seeks = 0;
for (const gender of ["Male", "Female"]) {
  const model = (await glb("public/assets/models/SK_Base" + gender + ".glb")).scene;
  oracle.normalizeModel(model);
  const outer = new THREE.Group(); outer.add(model);
  const bone = model.getObjectByName("Root");
  const character = { root: outer, scene: model, sceneRestRotationY: model.rotation.y, rootRestPosition: bone.position.clone(), rootRestQuaternion: bone.quaternion.clone() };
  const mixer = new THREE.AnimationMixer(model);
  for (const [name, clip] of Object.entries(animations)) {
    const cfg = config[name] ?? {};
    const action = mixer.clipAction(shared.filterAnimationTracks(clip, model, config[name]));
    for (const yaw of [-1.2, 0.7]) {
      const take = t => {
        const result = shared.applyPreviewPose(character, action, clip, t, cfg, { baseYaw: yaw });
        assert.equal(action.time, result.time, "Preview uses clip-time, not playback-scaled wall-time");
        return plain({ result, position: outer.position, quaternion: outer.quaternion, rootPosition: bone.position, rootQuaternion: bone.quaternion, bones: restTransforms[gender].map(rest => {
          const b = model.getObjectByName(rest.name);
          return { position: b.position, quaternion: b.quaternion };
        }) });
      };
      for (const t of [0, clip.duration * 0.31, clip.duration, clip.duration * 0.81]) {
        const first = take(t);
        take(clip.duration * 0.13);
        const repeat = take(t);
        assert.deepEqual(repeat, first, gender + "/" + name + " deterministic seek " + t);
        close(outer.position, first.result.position, "No duplicate outer displacement");
        const before = plain({ position: outer.position, quaternion: outer.quaternion, sceneQuaternion: model.quaternion });
        const integrated = shared.computeIntegratedRootMotion(clip, cfg, character, t, { baseYaw: yaw });
        assert.deepEqual(plain({ position: outer.position, quaternion: outer.quaternion, sceneQuaternion: model.quaternion }), before, "Integration is non-mutating");
        close(integrated.position, outer.position, "Seek applies integrated displacement once");
        close(integrated.quaternion, outer.quaternion, "Seek applies outer orientation once");
        seeks++;
      }
    }
    mixer.stopAllAction(); mixer.uncacheAction(action.getClip());
  }
}
// Independent analytic translation/yaw expectations, not a second call to shared math.
const testRoot = new THREE.Group(), testScene = new THREE.Group(); testRoot.add(testScene);
const testBone = new THREE.Bone(); testBone.name = "Root"; testScene.add(testBone);
testScene.scale.setScalar(2);
const character = { root: testRoot, scene: testScene, sceneRestRotationY: 0, rootRestPosition: new THREE.Vector3(3, 4, 5), rootRestQuaternion: new THREE.Quaternion() };
const linear = new THREE.AnimationClip("linear", 2, [new THREE.VectorKeyframeTrack("Root.position", [0, 2], [0, 0, 0, 2, 0, 4])]);
const rootCfg = { motionMode: "RootMotion", applyRootRotation: false, bakeIntoPoseXZ: true, rootPoseRotation: false, visualYawOffsetDegrees: 60 };
close(shared.computeIntegratedRootMotion(linear, rootCfg, character, 1, { baseYaw: Math.PI / 2 }).position, [4, 0, -2], "World projection ignores visual yaw");
close(shared.computeIntegratedRootMotion(linear, rootCfg, character, 1, { baseYaw: Math.PI / 2, steps: 1 }).position, [4, 0, -2], "Linear integration agrees across steps");
const mixer = new THREE.AnimationMixer(testScene), action = mixer.clipAction(shared.filterAnimationTracks(linear, testScene, rootCfg));
shared.applyPreviewPose(character, action, linear, 1, rootCfg, { baseYaw: Math.PI / 2 });
close(testBone.position, [3, 0, 5], "Root pose anchored separately from outer translation");
const codeCfg = { motionMode: "InPlace", codeMoveSpeed: 2, bakeIntoPoseXZ: true };
close(shared.computeIntegratedRootMotion(linear, codeCfg, character, 1).position, [0, 0, Math.sqrt(20)], "Code displacement uses clip-time at speed-matched rate");
close(shared.computeIntegratedRootMotion(linear, codeCfg, character, 1, { codeMovement: true }).position, [0, 0, Math.sqrt(20)], "Explicit code movement preserves walk displacement");
close(shared.computeIntegratedRootMotion(linear, codeCfg, character, 1, { codeMovement: false }).position, [0, 0, 0], "InPlace attack suppresses explicit code speed");
const codeAction = mixer.clipAction(shared.filterAnimationTracks(linear, testScene, codeCfg));
shared.applyPreviewPose(character, codeAction, linear, 1, codeCfg);
const walkPose = plain({ position: testBone.position, quaternion: testBone.quaternion, time: codeAction.time });
close(testRoot.position, [0, 0, Math.sqrt(20)], "Default preview keeps walk movement");
shared.applyPreviewPose(character, codeAction, linear, 1, codeCfg, { codeMovement: false });
close(testRoot.position, [0, 0, 0], "Preview forwards codeMovement false without residual displacement");
assert.deepEqual(plain({ position: testBone.position, quaternion: testBone.quaternion, time: codeAction.time }), walkPose, "Disabling code movement leaves clip pose/time unchanged");
close(testBone.position, [0, 0, 0], "Baked linear clip retains analytic InPlace pose");
shared.applyPreviewPose(character, codeAction, linear, 1, codeCfg, { codeMovement: true });
close(testRoot.position, [0, 0, Math.sqrt(20)], "Preview can re-enable walk movement after stationary attack");
close(shared.computeIntegratedRootMotion(linear, rootCfg, character, 1, { baseYaw: Math.PI / 2, codeMovement: false }).position, [4, 0, -2], "RootMotion trajectory ignores codeMovement false");
shared.applyPreviewPose(character, action, linear, 1, rootCfg, { baseYaw: Math.PI / 2, codeMovement: false });
close(testRoot.position, [4, 0, -2], "RootMotion preview is unaffected by code movement suppression");
const rotation = new THREE.AnimationClip("yaw", 1, [new THREE.QuaternionKeyframeTrack("Root.quaternion", [0, 1], [0, 0, 0, 1, 0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)])]);
testScene.scale.setScalar(1); testScene.rotation.set(0, 0, 0);
close(shared.computeIntegratedRootMotion(rotation, { motionMode: "RootMotion" }, character, 1).quaternion, [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)], "Root yaw integration sign");
close(shared.computeIntegratedRootMotion(rotation, { motionMode: "RootMotion", applyRootRotation: false }, character, 1).quaternion, [0, 0, 0, 1], "Disabled outer rotation");
assert.throws(() => shared.computeIntegratedRootMotion(linear, {}, character, NaN), RangeError);
assert.throws(() => shared.computeIntegratedRootMotion(linear, {}, character, 1, { steps: 0 }), RangeError);
console.log("PASS: " + seeks + " real-asset deterministic seeks, no duplicate displacement, clip endpoints, analytic projections/code speed/root yaw, non-mutating integration");

// Snapshot without updating matrices: even stale matrices/flags belong to the caller.
function transformState(objects) {
  return objects.map(object => ({
    object, parent: object.parent, children: [...object.children],
    values: plain({ position: object.position, quaternion: object.quaternion, scale: object.scale,
      rotation: object.rotation.toArray(), matrix: object.matrix, matrixWorld: object.matrixWorld,
      matrixAutoUpdate: object.matrixAutoUpdate, matrixWorldAutoUpdate: object.matrixWorldAutoUpdate,
      matrixWorldNeedsUpdate: object.matrixWorldNeedsUpdate }),
  }));
}
const callerParent = new THREE.Group();
callerParent.position.set(7, -3, 5); callerParent.rotation.set(0.1, 0.4, -0.2); callerParent.scale.set(2, 3, 4);
const callerRoot = new THREE.Group(), callerScene = new THREE.Group();
callerParent.add(callerRoot); callerRoot.add(callerScene);
callerRoot.position.set(-4, 2, 8); callerRoot.rotation.set(0.2, -0.6, 0.1); callerRoot.scale.set(0.8, 1.1, 1.3);
callerScene.position.set(0.3, -1.7, 0.9); callerScene.rotation.set(-0.4, 0.2, 0.3); callerScene.scale.set(0.7, 0.9, 1.2);
callerParent.updateMatrixWorld(true);
callerRoot.position.x += 0.25; // Deliberately leave matrix/matrixWorld stale.
callerRoot.matrixAutoUpdate = false; callerScene.matrixWorldAutoUpdate = false;
callerRoot.matrixWorldNeedsUpdate = true;
const caller = { root: callerRoot, scene: callerScene, sceneRestRotationY: 0.2 };
for (const cfg of [rootCfg, { motionMode: "RootMotion", applyRootRotation: true }, codeCfg]) {
  const before = transformState([callerParent, callerRoot, callerScene]);
  shared.computeIntegratedRootMotion(linear, cfg, caller, 1, { baseYaw: -0.7, steps: 7 });
  const after = transformState([callerParent, callerRoot, callerScene]);
  before.forEach((state, i) => {
    assert.equal(after[i].object, state.object);
    assert.equal(after[i].parent, state.parent, "Integration preserves parent identity");
    assert.equal(after[i].children.length, state.children.length);
    state.children.forEach((child, j) => assert.equal(after[i].children[j], child));
    assert.deepEqual(after[i].values, state.values, "Integration preserves scales, positions, Euler/quaternion, local/world matrices and update flags");
  });
}

// Independent samplers: use Three's generic linear interpolant, NOT shared helpers.
// Runtime quaternion component interpolation is linear then normalized, not slerp.
function referenceValues(track, time) {
  if (!track || !track.times.length) return null;
  return Array.from(new THREE.LinearInterpolant(track.times, track.values, track.getValueSize(), new Float64Array(track.getValueSize())).evaluate(time));
}
function referenceRotation(value) {
  if (!value) return new THREE.Quaternion();
  return value.length === 4 ? new THREE.Quaternion().fromArray(value) : new THREE.Quaternion().setFromEuler(new THREE.Euler().fromArray(value));
}
function referenceSample(clip, time) {
  const t = Math.min(Math.max(time, 0), Math.max(clip.duration, 0));
  return {
    position: new THREE.Vector3().fromArray(referenceValues(clip.tracks.find(t => t.name === "Root.position"), t) || [0, 0, 0]),
    quaternion: referenceRotation(referenceValues(clip.tracks.find(t => t.name === "Root.quaternion" || t.name === "Root.rotation"), t)).normalize(),
  };
}
function referenceCycle(clip) {
  const frozen = baseline.probes["Male/" + clip.name]?.cycle;
  if (frozen && changedInputs.length === 0) return Object.fromEntries(Object.entries(frozen).map(([key, values]) => [key, values.length === 3 ? new THREE.Vector3().fromArray(values) : new THREE.Quaternion().fromArray(values)]));
  const start = referenceSample(clip, 0), end = referenceSample(clip, clip.duration);
  const rotationTrack = clip.tracks.find(t => t.name === "Root.quaternion" || t.name === "Root.rotation");
  // Cycle endpoints preserve raw quaternion components; runtime samples normalize.
  return { startPosition: start.position, endPosition: end.position,
    startRotation: referenceRotation(referenceValues(rotationTrack, 0)), endRotation: referenceRotation(referenceValues(rotationTrack, clip.duration)),
    cyclePosition: end.position.clone().sub(start.position) };
}
function referenceProject(clip, cfg, actor, delta) {
  actor.scene.updateMatrixWorld(true);
  const scale = actor.scene.getWorldScale(new THREE.Vector3());
  const movement = new THREE.Vector3(delta.x * scale.x, 0, delta.z * scale.z);
  const forward = referenceCycle(clip).cyclePosition.clone().setY(0);
  if (cfg.rootMotionMoveBasis === "characterForward") {
    if (forward.lengthSq() <= 1e-6) forward.set(0, 0, 1);
    let distance = movement.dot(forward.normalize());
    if (cfg.rootMotionForwardOnly) distance = Math.max(0, distance);
    if (Math.abs(distance) <= 1e-6) return new THREE.Vector3();
    const direction = cfg.codeMoveBasis === "clipRootDelta" ? forward.clone() : new THREE.Vector3(0, 0, 1);
    if (Array.isArray(cfg.codeMoveLocalDirection) && cfg.codeMoveLocalDirection.length >= 3) {
      direction.set(Number(cfg.codeMoveLocalDirection[0]) || 0, 0, Number(cfg.codeMoveLocalDirection[2]) || 0);
      if (direction.lengthSq() <= 1e-6) direction.set(0, 0, 1);
      direction.normalize();
    }
    return direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), (cfg.codeMoveYawOffsetDegrees ?? 0) * Math.PI / 180 + actor.root.rotation.y).multiplyScalar(distance);
  }
  if (cfg.rootMotionForwardOnly && forward.lengthSq() > 1e-6) {
    forward.normalize();
    const distance = movement.dot(forward);
    if (distance < 0) movement.addScaledVector(forward, -distance);
  }
  return movement.applyAxisAngle(new THREE.Vector3(0, 1, 0), actor.sceneRestRotationY ?? 0).applyQuaternion(actor.root.quaternion);
}

// Execute only the original increment/rotation/projection statements from update().
// Their containing runtime AST is already checked against the pre-extraction hash.
let rootFrameBlock;
function findRootFrame(node) {
  if (!node || typeof node !== "object") return;
  if (node.type === "BlockStatement" && node.body[0]?.declarations?.[0]?.id?.name === "currTime") rootFrameBlock = node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(findRootFrame);
    else if (value && typeof value === "object") findRootFrame(value);
  }
}
findRootFrame(ast.body.find(n => n.type === "FunctionDeclaration" && n.id.name === "update"));
assert.ok(rootFrameBlock, "Original root frame block found");
const nextPositionStatement = rootFrameBlock.body.find(n => n.declarations?.[0]?.id?.name === "nextPos");
assert.ok(nextPositionStatement, "Stop frame extraction before collision/lifecycle handling");
const frameSource = source.slice(rootFrameBlock.body[0].start, nextPositionStatement.end)
  .replace("getRootMotionDeltaWorld(actionName, character, deltaPos)", "project(clip, config, character, deltaPos)");
function frameRunner(sample, cycle, project) {
  const context = vm.createContext({ THREE, sampleClipRootMotion: sample, calculateClipRootCycle: cycle, project });
  return vm.runInContext("(function(clip, config, character, activeAction, applyRootRotation = true, controlOnlyHitReaction = false, cancelledAttack = false) {\n" + frameSource + "\nreturn { deltaPos, deltaRot, nextPos, currPos, currRot };\n})", context);
}
const originalFrame = frameRunner(referenceSample, referenceCycle, referenceProject);
const extractedFrame = frameRunner(shared.sampleClipRootMotion, shared.calculateClipRootCycle, shared.getRootMotionDeltaWorld);
function frameActor(template, yaw, cfg) {
  const root = new THREE.Group(), scene = new THREE.Group(); root.add(scene);
  root.scale.copy(template.root.scale); root.rotation.y = yaw;
  scene.position.copy(template.scene.position); scene.scale.copy(template.scene.scale); scene.quaternion.copy(template.scene.quaternion);
  scene.rotation.y = (template.sceneRestRotationY ?? 0) + (cfg.visualYawOffsetDegrees ?? 0) * Math.PI / 180;
  return { root, scene, sceneRestRotationY: template.sceneRestRotationY };
}
function stepFrame(run, clip, cfg, actor, previousTime, time, rotationEnabled = cfg.applyRootRotation !== false) {
  const previous = referenceSample(clip, previousTime);
  actor.rootMotionState = { prevTime: previousTime, prevPosition: previous.position, prevQuaternion: previous.quaternion };
  const result = run(clip, cfg, actor, { time }, rotationEnabled);
  actor.root.position.copy(result.nextPos);
  return result;
}
const combined = new THREE.AnimationClip("combined-frame-test", 1, [
  new THREE.VectorKeyframeTrack("Root.position", [0, 0.4, 1], [0, 0, 0, -0.3, 0.2, 0.7, 1, 0, 2]),
  new THREE.QuaternionKeyframeTrack("Root.quaternion", [0, 0.4, 1], [
    ...new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, -0.3, 0.1)).toArray(),
    ...new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.1, 0.7, 0.3)).toArray(),
    ...new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, 1.1, -0.2)).toArray(),
  ]),
]);
let integratedCases = 0, wrapCases = 0;
const template = { root: new THREE.Group(), scene: new THREE.Group(), sceneRestRotationY: 0.25 };
template.root.scale.set(0.8, 1.1, 1.3); template.scene.scale.set(0.7, 0.9, 1.2); template.scene.position.set(0.2, -0.1, 0.4);
for (const clip of [combined, ...Object.values(animations)]) {
  if (changedInputs.length === 0 && clip !== combined) {
    close(referenceSample(clip, clip.duration / 2).position, baseline.probes["Male/" + clip.name].midpoint.position, "Independent midpoint matches frozen oracle");
    close(referenceSample(clip, clip.duration / 2).quaternion, baseline.probes["Male/" + clip.name].midpoint.quaternion, "Independent quaternion matches frozen oracle");
  }
  for (const cfg of [
    { motionMode: "RootMotion", visualYawOffsetDegrees: 35 },
    { motionMode: "RootMotion", rootMotionForwardOnly: true, applyRootRotation: false },
    { motionMode: "RootMotion", rootMotionMoveBasis: "characterForward", rootMotionForwardOnly: true, codeMoveBasis: "clipRootDelta", codeMoveYawOffsetDegrees: -20 },
  ]) for (const yaw of [-0.8, 1.2]) {
    const target = clip.duration * 0.77, steps = 13, count = Math.ceil(steps * target / clip.duration);
    const expectedActor = frameActor(template, yaw, cfg);
    for (let i = 1; i <= count; i++) stepFrame(originalFrame, clip, cfg, expectedActor, target * (i - 1) / count, target * i / count);
    const actual = shared.computeIntegratedRootMotion(clip, cfg, template, target, { baseYaw: yaw, steps });
    close(actual.position, expectedActor.root.position, "Combined translation/rotation vs original frame stepping: " + clip.name);
    close(actual.quaternion, expectedActor.root.quaternion, "Integrated orientation vs original frame stepping: " + clip.name);
    integratedCases++;
    for (const [previousFraction, currentFraction] of [[0.2, 0.4], [0.93, 0.07], [1, 0], [0.99, 0]]) {
      const expectedActor = frameActor(template, yaw, cfg), actualActor = frameActor(template, yaw, cfg);
      const prev = previousFraction * clip.duration, now = currentFraction * clip.duration;
      const expected = stepFrame(originalFrame, clip, cfg, expectedActor, prev, now);
      const actual = stepFrame(extractedFrame, clip, cfg, actualActor, prev, now);
      close(actual.deltaPos, expected.deltaPos, "Frame translation increment");
      close(actual.deltaRot, expected.deltaRot, "Frame quaternion increment/order");
      close(actualActor.root.position, expectedActor.root.position, "Frame world translation");
      close(actualActor.root.quaternion, expectedActor.root.quaternion, "Frame world orientation");
      if (now < prev) {
        const cycle = referenceCycle(clip), previous = referenceSample(clip, prev), current = referenceSample(clip, now);
        const endpointSum = cycle.endPosition.clone().sub(previous.position).add(current.position).sub(cycle.startPosition).setY(0);
        close(actual.deltaPos, endpointSum, "Wrap displacement is tail plus head, not backward jump");
        const tail = previous.quaternion.clone().invert().premultiply(cycle.endRotation);
        const head = cycle.startRotation.clone().invert().premultiply(current.quaternion);
        close(actual.deltaRot, cfg.applyRootRotation === false ? new THREE.Quaternion() : head.multiply(tail), "Wrap quaternion order is head * tail");
        wrapCases++;
      }
    }
  }
}
console.log("PASS: full caller transform/hierarchy/matrix safety; " + integratedCases + " independent original-frame integrations; " + wrapCases + " wrapped frame increments");
