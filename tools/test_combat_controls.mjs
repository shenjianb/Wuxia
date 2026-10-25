import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { parseAst } from "rollup/parseAst";
import * as THREE from "three";
import * as controls from "../src/combat-controls.js";
import * as moves from "../src/combat-move-manager.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("all eight body/world sectors, including wraparound", () => {
  for (let body = -8; body <= 8; body++) {
    controls.RELATIVE_DIRECTIONS.forEach((direction, index) => {
      const yaw = body * Math.PI / 4;
      assert.equal(controls.relativeAttackDirection(yaw + index * Math.PI / 4, yaw), direction);
    });
  }
  assert.equal(controls.relativeAttackDirection(-Math.PI / 2, Math.PI / 2), "back");
});

test("shortest turn crosses zero and is frame-rate independent", () => {
  const from = 179 * Math.PI / 180;
  const to = -179 * Math.PI / 180;
  assert.ok(controls.shortestAngle(from, to) > 0);
  close(controls.shortestAngle(controls.stepFacing(from, to, 1), to), 0);
  close(controls.shortestAngle(0, Math.PI), Math.PI);
  let low = 0, high = 0;
  for (let i = 0; i < 30; i++) low = controls.stepFacing(low, 2.8, 1 / 30);
  for (let i = 0; i < 120; i++) high = controls.stepFacing(high, 2.8, 1 / 120);
  close(low, high);
  close(controls.stepFacing(0, 2, 0.01), 0.055);
});

test("release chord once, regardless of release order or key repeat", () => {
  for (const release of [["KeyA", "KeyW"], ["KeyW", "KeyA"]]) {
    const chord = controls.createAttackChord();
    assert.equal(controls.updateAttackChord(chord, "KeyA", true), null);
    assert.equal(controls.updateAttackChord(chord, "KeyA", true), null);
    assert.equal(controls.updateAttackChord(chord, "KeyW", true), null);
    assert.equal(controls.updateAttackChord(chord, release[0], false), null);
    assert.deepEqual(controls.updateAttackChord(chord, release[1], false), { x: -1, y: 1 });
    assert.equal(controls.updateAttackChord(chord, release[1], false), null);
  }
  const chord = controls.createAttackChord();
  controls.updateAttackChord(chord, "KeyA", true);
  assert.deepEqual(controls.updateAttackChord(chord, "KeyA", false), { x: -1, y: 0 });
  controls.updateAttackChord(chord, "KeyW", true);
  assert.deepEqual(controls.updateAttackChord(chord, "KeyW", false), { x: 0, y: 1 });
  controls.updateAttackChord(chord, "KeyW", true);
  controls.updateAttackChord(chord, "KeyS", true);
  controls.updateAttackChord(chord, "KeyS", false);
  assert.equal(controls.updateAttackChord(chord, "KeyW", false), null);
});

test("interrupt window uses clip progress and old configs remain closed", () => {
  assert.equal(controls.isActionInterruptible({}, 0.9, 1), false);
  assert.equal(controls.isActionInterruptible({ interruptWindow: [0.3, 0.7] }, 0.5, 2), false);
  assert.equal(controls.isActionInterruptible({ interruptWindow: [0.3, 0.7] }, 0.6, 2), true);
  assert.equal(controls.isActionInterruptible({ interruptWindow: [0.3, 0.7] }, 1.4, 2), true);
  assert.equal(controls.isActionInterruptible({ interruptWindow: [0.3, 0.7] }, 1.5, 2), false);
  assert.deepEqual(controls.normalizeInterruptWindow([1.2, -0.2]), [0, 1]);
  assert.equal(controls.normalizeInterruptWindow([NaN, 1]), null);
});

test("eight pools preserve legacy moves, defaults, weights and direction filtering", () => {
  const original = JSON.parse(readFileSync(new URL("../public/assets/combat/move_manager.json", import.meta.url)));
  const manager = moves.normalizeCombatMoveManager(original);
  assert.equal(Object.keys(manager.directions).length, 8);
  assert.equal(moves.getAllCombatMoves(manager).length, moves.getAllCombatMoves(original).length);
  manager.directions.back.moves = [
    moves.normalizeCombatMove({ id: "a", actionName: "a", weight: 0 }, "back"),
    moves.normalizeCombatMove({ id: "b", actionName: "b", weight: 0 }, "back"),
  ];
  manager.directions.back.defaultMoveId = "b";
  assert.equal(moves.selectCombatMove(manager, "back", () => true).id, "b");
  assert.equal(moves.selectCombatMove(manager, "back", (move) => move.id !== "b").id, "a");
  assert.equal(moves.selectCombatMove(manager, "leftForward", () => true), null);
  manager.directions.back.moves[0].weight = 1;
  manager.directions.back.moves[1].weight = 3;
  assert.equal(moves.selectCombatMove(manager, "back", () => true, manager.directions.forward.moves[0], () => 0.9).id, "b");
  assert.equal(moves.selectCombatMove(manager, "back", () => true, manager.directions.back.moves[0], () => 0.9).id, "b");
  assert.equal(moves.selectCombatMove(manager, "back", () => false), null);
  assert.equal(moves.normalizeMoveImpact({ hitstun: { enabled: true } }).hitstun.duration, 0.3);
});

// Run actual runtime functions with real Three.js vectors/actions, without a GPU.
const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const functions = new Map(parseAst(source).body.filter((node) => node.type === "FunctionDeclaration").map((node) => [node.id.name, source.slice(node.start, node.end)]));
function runtime() {
  const listeners = new Map();
  const documentListeners = new Map();
  let now = 0;
  const context = vm.createContext({
    THREE, ...controls, ...moves,
    COMBAT_ATTACK_DIRECTIONS: controls.RELATIVE_DIRECTIONS,
    COMBAT_ATTACK_RECOVERY_DURATION: 0.3, FACING_TURN_SPEED: 5.5,
    DIRECTION_ONLY_ATTACK_DURATION_MS: 300,
    WORLD_UP: new THREE.Vector3(0, 1, 0),
    animations: {}, motionConfig: {}, runtimeNpcs: [], combatAttackActionNames: new Set(),
    performance: { now: () => now },
    window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    document: { hidden: false, querySelectorAll: () => [], addEventListener: (name, callback) => documentListeners.set(name, callback) },
    sampleClipRootMotion: () => ({ position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }),
    getActionName: (character, action) => Object.keys(character.actions).find((name) => character.actions[name] === action),
    getRuntimeCharacterId: (character) => character?.runtime?.id || "player",
    normalizeRuntimeNonNegativeNumber: (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback,
    getRuntimeAttackConfig: (node) => node?.params?.attack || {},
    getRuntimePosition: (value) => value?.isVector3 ? value : null,
    updateCombatModeUI() {}, toggleCombatColliderDebug() {}, resize() {},
    updateCharacterLocomotion(character, intent) { context.lastLocomotion = intent; },
    evaluateCombatAttackHits() {}, NPC_ATTACK_COOLDOWN: 1.2,
    getPlayerCombatTargets: () => [], getNpcCombatTargets: () => [],
    combatColliderDebug: { objects: [], hits: [] },
    attackDirectionMarkers: new Map(), scene: new THREE.Scene(),
    getRuntimeCombatCharacters: () => [context.player, ...context.runtimeNpcs.map((npc) => npc.character)],
  });
  const names = ["createCombatAttackState", "createHitReactionState", "resolveCombatAttackMove", "getCharacterAvailableCombatMoves", "getRuntimeCombatMoveById", "requestCombatAttack", "beginCombatAttack", "beginCharacterCombatAttack", "restartCharacterAction", "finishCombatAttack", "finishCharacterCombatAttack", "cancelCombatAttack", "cancelCharacterCombatAttack", "isCombatAttackAction", "isCombatAttackComplete", "updateCombatAttackState", "hasPendingFacing", "canInterruptCharacterAction", "configureAnimationAction", "screenDirection", "bindInput", "toggleCombatMode", "updatePlayer", "consumeCombatRecoveryControlScale", "getCharacterCombatAttackState", "applyCharacterHitReaction", "updateCharacterHitReaction", "clearCharacterHitReaction", "updateNpcCombatAttack", "getCombatKnockbackDirection", "updateAttackDirectionMarkers"];
  names.push("canChangeCharacterAction", "updateDirectionOnlyAttack");
  vm.runInContext(names.map((name) => { assert.ok(functions.has(name), name); return functions.get(name); }).join("\n"), context);
  context.combatMoveManager = moves.normalizeCombatMoveManager({});
  for (const direction of controls.RELATIVE_DIRECTIONS) {
    const actionName = `attack_${direction}`;
    context.animations[actionName] = new THREE.AnimationClip(actionName, 2, []);
    context.motionConfig[actionName] = { loop: false };
    context.combatAttackActionNames.add(actionName);
    context.combatMoveManager.directions[direction].moves.push(moves.normalizeCombatMove({ id: actionName, actionName }, direction));
  }
  context.animations.idle = new THREE.AnimationClip("idle", 2, []);
  context.motionConfig.idle = {};
  function character() {
    const root = new THREE.Group();
    const mixer = new THREE.AnimationMixer(root);
    const actions = Object.fromEntries(Object.entries(context.animations).map(([name, clip]) => [name, mixer.clipAction(clip)]));
    return { root, actions, mixer, currentAction: actions.idle, desiredAction: actions.idle,
      hitReaction: context.createHitReactionState(), rootMotionState: { prevTime: 0, prevPosition: new THREE.Vector3(), prevQuaternion: new THREE.Quaternion() } };
  }
  context.player = character();
  context.state = { mode: "game", combatMode: true, combatAttack: context.createCombatAttackState(), keys: { forward: false }, facingKeys: new Set(), facingTarget: null };
  context.camera = new THREE.PerspectiveCamera();
  context.camera.position.set(0, 5, 5); context.camera.lookAt(0, 0, 0);
  context.bindInput();
  return { context, character, advance: (ms) => { now += ms; },
    key: (code, down, repeat = false) => listeners.get(down ? "keydown" : "keyup")({ code, repeat, preventDefault() {} }),
    blur: () => listeners.get("blur")() };
}

test("runtime release, locked direction, no hold repeat, and blur cleanup", () => {
  const { context: c, key, blur } = runtime();
  key("KeyA", true); key("KeyW", true);
  c.updateCombatAttackState(); assert.equal(c.state.combatAttack.sequence, 0);
  key("KeyA", false); assert.equal(c.state.combatAttack.pendingAttack, null);
  key("KeyW", false); c.updateCombatAttackState();
  const attack = c.state.combatAttack;
  assert.equal(attack.sequence, 1);
  assert.equal(attack.activeDirection, "rightBack");
  const locked = attack.worldDirection.clone();
  c.player.root.rotation.y = 1;
  c.updateAttackDirectionMarkers();
  assert.ok(c.attackDirectionMarkers.get(c.player).visible);
  assert.ok(attack.worldDirection.equals(locked));
  c.player.currentAction = c.player.actions[attack.activeActionName];
  c.player.currentAction.time = 2;
  c.updateCombatAttackState(); c.updateAttackDirectionMarkers();
  assert.equal(attack.active, false);
  assert.equal(c.attackDirectionMarkers.get(c.player).visible, false);
  key("KeyW", true);
  for (let i = 0; i < 3; i++) c.updateCombatAttackState();
  assert.equal(attack.sequence, 1);
  blur(); key("KeyW", false); c.updateCombatAttackState();
  assert.equal(attack.sequence, 1);
  key("ArrowRight", true); key("ArrowRight", false);
  const target = c.state.facingTarget;
  const old = c.player.root.rotation.y;
  c.updatePlayer(0.01);
  assert.ok(Math.abs(controls.shortestAngle(old, c.player.root.rotation.y)) <= 0.055 + 1e-8);
  assert.equal(c.state.facingTarget, target);
});

test("runtime buffers attack outside interval and interrupts only inside", () => {
  const { context: c, advance } = runtime();
  const forward = new THREE.Vector3(0, 0, 1);
  c.requestCombatAttack(forward); c.updateCombatAttackState();
  const attack = c.state.combatAttack;
  c.player.currentAction = c.player.actions[attack.activeActionName];
  c.motionConfig[attack.activeActionName].interruptWindow = [0.5, 0.8];
  c.player.currentAction.time = 0.4;
  c.requestCombatAttack(new THREE.Vector3(1, 0, 0)); c.updateCombatAttackState();
  assert.equal(attack.sequence, 1); assert.ok(attack.pendingAttack);
  c.player.currentAction.time = 1.2; c.updateCombatAttackState();
  assert.equal(attack.sequence, 2); assert.equal(attack.activeDirection, "left");
  c.player.currentAction = c.player.actions[attack.activeActionName];
  c.player.currentAction.time = 0.2;
  c.requestCombatAttack(forward); advance(1300); c.updateCombatAttackState();
  assert.equal(attack.pendingAttack, null);
  c.motionConfig[attack.activeActionName].interruptWindow = [0.5, 0.8];
  c.state.keys.forward = true;
  c.updateCombatAttackState(); assert.equal(attack.active, true);
  c.player.currentAction.time = 1.2;
  c.updateCombatAttackState(); assert.equal(attack.active, false);
  close(attack.recoveryTimer, 0.3);
});

test("hitstun with/without animation blocks new input and preserves no-animation pose", () => {
  for (const actionName of ["", "attack_back"]) {
    const { context: c, key } = runtime();
    const before = c.player.desiredAction;
    assert.equal(c.applyCharacterHitReaction(c.player, actionName, null, 0.6), true);
    if (!actionName) assert.equal(c.player.desiredAction, before);
    key("KeyW", true); key("KeyW", false);
    assert.equal(c.state.combatAttack.pendingAttack, null);
    assert.equal(c.beginCharacterCombatAttack(c.player, c.state.combatAttack, "forward"), false);
    assert.equal(c.updateCharacterHitReaction(c.player, 0.3), true);
    assert.equal(c.updateCharacterHitReaction(c.player, 0.31), false);
    assert.equal(c.player.hitReaction.active, false);
  }
});

test("configured locomotion action also gates attack and facing changes", () => {
  const { context: c } = runtime();
  c.motionConfig.idle = { loop: true, interruptWindow: [0.5, 0.8] };
  c.player.currentAction.time = 0.3;
  c.state.facingTarget = 1;
  c.requestCombatAttack(new THREE.Vector3(0, 0, 1));
  c.updatePlayer(0.02);
  assert.equal(c.state.combatAttack.active, false);
  close(c.player.root.rotation.y, 0);
  c.player.currentAction.time = 1.1;
  c.updatePlayer(0.02);
  assert.equal(c.state.combatAttack.active, true);
});

test("diagonal facing survives either release order, delayed release, and repeat", () => {
  for (const codes of [["ArrowLeft", "ArrowDown"], ["ArrowRight", "ArrowDown"], ["ArrowLeft", "ArrowUp"], ["ArrowRight", "ArrowUp"]]) {
    for (const release of [codes, [...codes].reverse()]) {
      const { context: c, key, advance } = runtime();
      key(codes[0], true); key(codes[1], true);
      const diagonal = c.state.facingTarget;
      key(release[0], false); advance(200);
      key(release[1], true, true);
      close(c.state.facingTarget, diagonal);
      key(release[1], false);
      close(c.state.facingTarget, diagonal);
      assert.equal(c.state.facingKeys.size, 0);
      key(codes[0], true);
      assert.notEqual(c.state.facingTarget, diagonal);
    }
  }
});

test("empty or unavailable direction pool still starts one locked arrow without animation or hits", () => {
  for (const direction of controls.RELATIVE_DIRECTIONS) {
    const { context: c, advance } = runtime();
    c.combatMoveManager.directions[direction].moves = [];
    const yaw = controls.RELATIVE_DIRECTIONS.indexOf(direction) * Math.PI / 4;
    const intended = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const pose = c.player.desiredAction;
    c.requestCombatAttack(intended);
    assert.equal(c.updateCombatAttackState(), "directionOnly");
    const attack = c.state.combatAttack;
    assert.equal(attack.active, true);
    assert.equal(attack.directionOnly, true);
    assert.equal(attack.activeDirection, direction);
    assert.equal(attack.activeMoveId, null);
    assert.equal(attack.activeStrength, 0);
    assert.equal(c.player.desiredAction, pose);
    c.player.root.rotation.y = 1.3;
    c.updateAttackDirectionMarkers();
    assert.ok(c.attackDirectionMarkers.get(c.player).visible);
    assert.ok(attack.worldDirection.distanceTo(intended) < 1e-8);
    advance(301); c.updateCombatAttackState(); c.updateAttackDirectionMarkers();
    assert.equal(attack.active, false);
    assert.equal(c.attackDirectionMarkers.get(c.player).visible, false);
    c.updateCombatAttackState();
    assert.equal(attack.sequence, 1);
  }
  const { context: c } = runtime();
  delete c.player.actions.attack_forward;
  c.requestCombatAttack(new THREE.Vector3(0, 0, 1));
  assert.equal(c.updateCombatAttackState(), "directionOnly");
});

test("NPC empty pool also shows direction and ends with cooldown; stun cancels preview", () => {
  const { context: c, character, advance } = runtime();
  c.combatMoveManager.directions.back.moves = [];
  const npc = { character: character(), combatAttack: c.createCombatAttackState(), blackboard: {}, attackTargetPosition: new THREE.Vector3(0, 0, -3) };
  c.runtimeNpcs.push(npc);
  assert.equal(c.updateNpcCombatAttack(npc, true, 0.01), "directionOnly");
  c.updateAttackDirectionMarkers();
  assert.ok(c.attackDirectionMarkers.get(npc.character).visible);
  advance(301);
  assert.equal(c.updateNpcCombatAttack(npc, true, 0.01), null);
  close(npc.combatAttack.aiCooldown, 1.2);
  c.requestCombatAttack(new THREE.Vector3(0, 0, -1)); c.updateCombatAttackState();
  assert.equal(c.state.combatAttack.directionOnly, true);
  c.applyCharacterHitReaction(c.player, "", npc.character, 0.3);
  c.updateAttackDirectionMarkers();
  assert.equal(c.state.combatAttack.active, false);
  assert.equal(c.state.combatAttack.worldDirection, null);
});

test("NPC uses target-relative pool and knockback follows locked world direction", () => {
  const { context: c, character } = runtime();
  const npc = { character: character(), combatAttack: c.createCombatAttackState(), blackboard: {}, attackTargetPosition: new THREE.Vector3(-3, 0, 0) };
  c.runtimeNpcs.push(npc);
  c.updateNpcCombatAttack(npc, true, 0.01, { params: { attack: { combatMoveId: "attack_forward" } } });
  assert.equal(npc.combatAttack.activeDirection, "right");
  assert.equal(npc.combatAttack.activeMoveId, "attack_right");
  npc.character.root.rotation.y = 1.2;
  assert.ok(c.getCombatKnockbackDirection(npc.character, {}).equals(new THREE.Vector3(-1, 0, 0)));
  const custom = c.getCombatKnockbackDirection(npc.character, { impact: { knockback: { customDirection: true, directionDegrees: 90 } } });
  close(custom.z, 1);
});
