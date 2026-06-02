# Three.js 本体 GLB + 动作 GLB InPlace 动画播放机制

> 纯 InPlace 模式，不含 RootMotion / Foot Lock / VisualYaw / Combat，即插即用。
>
> 示例实现参考: `D:\Wuxia_Web\src\main.js`（`filterAnimationTracks`、`getDetrendedRootPose` 等函数）

---

## 1. 资产约定

| 资产 | 内容 | 约束 |
|---|---|---|
| 本体 GLB | 模型 Mesh + 骨架 Armature | **不含任何 AnimationClip**，骨骼在 Rest Pose |
| 动作 GLB | 仅 AnimationClip（骨骼轨道） | 骨骼名必须与本体 GLB 完全一致 |
| motion_config.json | 每动作的 InPlace 播放参数 | 运行时可选，未配置的使用默认值 |

---

## 2. 核心概念

```
character.root (THREE.Group)          ← 代码控制移动/旋转
  └── gltf.scene (model)              ← 模型本体 + 骨架
        └── Root (bone)               ← 动画轨道 target（存在轨道数据）
              └── Bip001 Pelvis
                    └── ...
```

- 外层 `character.root` 负责世界位置和朝向
- 内层 skeleton 的 `Root` 骨骼接收动画数据
- 模型标准化后坐标已对齐 Y-up，**不需要手动 `rotation.x = Math.PI / 2`**

---

## 3. 初始化流程

```
1. 加载本体 GLB
2. normalizeModel()  → 统一身高 + 底部对齐地面
3. 保存 Root 骨骼 Rest Pose（rootRestPosition / rootRestQuaternion）
4. 创建 AnimationMixer 绑定到 model (gltf.scene)
5. 加载 motion_config.json（可选）
6. 加载所有动作 GLB → 提取 AnimationClip
7. mergeAnimationClips() 合并同动作的 clip
8. filterAnimationTracks() 预处理轨道（核心！）
9. mixer.clipAction(filteredClip) 创建 action
10. configureAnimationAction() 设置 loop / timeScale
```

---

## 4. filterAnimationTracks() — 轨道预处理

这是整个机制的**核心函数**。对每条轨道做一次预处理，Runtime 即可零额外开销直接播放。

### 处理规则

| 轨道类型 | 处理 | 原因 |
|---|---|---|
| `.scale` | **丢弃** | 避免骨骼缩放形变 |
| `Root.position` | **Bake Into Pose** | 去除线性漂移，保留摆动 |
| `Root.quaternion` + `bakeIntoPoseRotation: true` | **丢弃** | InPlace 不需要 Root 自转 |
| `Root.quaternion` + `bakeIntoPoseRotation: false` | **保留** | 需要 Root 旋转作为姿势 |
| `Pelvis.position` | **相对化重定位** | 动画增量偏移到目标模型的 Pelvis Rest Pose |
| 其他骨骼 `.position` | **丢弃** | 避免骨骼伸缩变形 |
| 其他骨骼 `.rotation` / `.quaternion` | **原样保留** | 核心动画数据 |

### Bake Into Pose 算法

```
原始轨道: rootPos(t) = linearDrift(t) + oscillation(t)

linearDrift(t) = startPos + (endPos - startPos) × (t / duration)

bakedPos[i] = rawPos[i] - driftRate × (time[i] - time[0])
其中 driftRate = (endPos - startPos) / duration
```

- `bakeIntoPoseXZ = true`: 去除水平面 (X, Z) 的线性漂移（前进/侧移），保留左右摇摆
- `bakeIntoPoseY  = true`: 去除垂直方向 (Y) 的线性漂移，保留上下起伏

效果：动画循环尾帧 = 首帧值，loop 无缝衔接；身体重心正常摆动但角色不向前漂移。

### Sway Scale（振幅缩减）

```
if (swayScale < 1.0) {
  bakedPos[i] = firstPos + (bakedPos[i] - firstPos) × swayScale;
}
```

| 值 | 效果 |
|---|---|
| `1.0`（默认） | 保留全部摆动 |
| `0.0` | 完全锁定到首帧（等效丢弃轨道） |
| `0.5 ~ 1.5` | 调整重心偏移量，控制上半身晃动幅度 |

Root 的摆动会被父子层级传递到 Pelvis 并叠加放大（**Double Oscillation**）。通过 `rootSwayScale` 可主动消减这种叠加。

### Pelvis 相对化重定位

```js
// 保证动画在不同身高/比例的模型上可用
values[i] = modelBone.position.x + (trackValues[i] - firstFrameValue)
```

只保留 Pelvis 骨骼的位置轨道（已相对化到模型 Rest Pose）；其他骨骼的位置轨道全部丢弃，防止比例伸缩变形。

---

## 5. 每帧更新顺序

```
1. mixer.update(delta)              ← 推进动画数据到 skeleton
2. 恢复 Root 骨骼姿势                ← 从去趋势后的样本拉取位置和旋转
3. 动作切换 / 过渡混合               ← fadeIn / fadeOut
4. InPlace 代码位移                  ← 根据输入驱动 character.root.position
5. 步速匹配                          ← action.timeScale = moveSpeed / naturalAnimSpeed
6. 代码旋转                          ← character.root.rotation.y
```

**第 2 步详解 — Root 姿势恢复**:

```js
// 每帧从过滤后的 clip 计算去趋势 Root 姿态，写入 skeleton Root
const rootPose = getDetrendedRootPose(clip, action.time, config);
skeletonRoot.position.copy(rootPose);

// bakeIntoPoseRotation === true → 恢复为首帧 Rest Pose
// bakeIntoPoseRotation === false → 使用 clip 自身的 Root 旋转
const rot = getInPlaceRootPoseQuaternion(clip, action.time, config, rootRestQuaternion);
skeletonRoot.quaternion.copy(rot);
```

**第 5 步详解 — 步速匹配**:

```js
// 动画每循环一个周期的 XZ 水平移动距离 / 时长 = 固有速度
const naturalSpeed = computeAnimNaturalSpeed(actionName, character);

// timeScale = 代码移动速度 / 动画固有速度 → 脚底不打滑
action.timeScale = clamp(codeMoveSpeed / naturalSpeed, 0, 3.0);
```

---

## 6. motion_config.json 配置项（仅 InPlace 相关）

```json
{
  "idle": {
    "motionMode": "InPlace",
    "loop": true,
    "bakeIntoPoseXZ": true,
    "bakeIntoPoseY": true,
    "bakeIntoPoseRotation": false,
    "rootSwayScale": 1.5
  },
  "walk": {
    "motionMode": "InPlace",
    "loop": true,
    "bakeIntoPoseXZ": true,
    "bakeIntoPoseY": true,
    "bakeIntoPoseRotation": false,
    "rootSwayScale": 1.5,
    "codeMoveSpeed": 2
  },
  "turnLeft": {
    "motionMode": "InPlace",
    "loop": true,
    "bakeIntoPoseXZ": true,
    "bakeIntoPoseY": true,
    "bakeIntoPoseRotation": true
  },
  "turnRight": {
    "motionMode": "InPlace",
    "loop": true,
    "bakeIntoPoseXZ": true,
    "bakeIntoPoseY": true,
    "bakeIntoPoseRotation": true
  }
}
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `motionMode` | string | `"InPlace"` | 固定为 `"InPlace"` |
| `loop` | bool | `true` | 是否循环播放 |
| `bakeIntoPoseXZ` | bool | `true` | 去除 Root 水平 (X, Z) 线性漂移 |
| `bakeIntoPoseY` | bool | `true` | 去除 Root 垂直 (Y) 线性漂移 |
| `bakeIntoPoseRotation` | bool | `true` | 去除 Root 旋转轨道（锁定为 Rest Pose） |
| `rootSwayScale` | number | `1.0` | 摆动振幅比例 (0 = 锁定, 1 = 全量) |
| `codeMoveSpeed` | number | — | InPlace 代码移动速度（用于步速匹配） |

### 默认配置（未找到 key 时使用）

```js
{
  motionMode: "InPlace",
  loop: true,
  bakeIntoPoseXZ: true,
  bakeIntoPoseY: true,
  bakeIntoPoseRotation: true,
  rootSwayScale: 1,
}
```

---

## 7. 需要迁移的核心函数（最小集合）

从参考实现 (`src/main.js`) 中提取以下函数，复制到目标项目即用：

| 函数 | 用途 |
|---|---|
| `filterAnimationTracks(clip, model)` | 轨道预处理：去趋势、重定位、丢弃、swayScale |
| `mergeAnimationClips(clips, name)` | 将同动作多个 clip 的 tracks 合并为一个 clip |
| `getTrackValueAtTime(track, time)` | 在各关键帧之间插值采样 |
| `calculateClipRootCycle(clip)` | 计算首末帧 Root 位移和旋转增量 |
| `sampleClipRootMotion(clip, time)` | 在指定时间采样 Root 的 position 和 quaternion |
| `getDetrendedRootPose(clip, time, config)` | 用 cycle 数据去趋势，返回纯摆动位置 |
| `getInPlaceRootPoseQuaternion(clip, time, config, restQuat)` | 获取 InPlace 模式 Root 旋转姿态 |
| `normalizeModel(model)` | 标准化模型到目标身高并底部对齐地面 |
| `getTrackTargetName(trackName)` | 从 `boneName.property` 中提取 boneName |
| `isRotationTrack(trackName)` | 判断 track 名是否为旋转轨道 |
| `configureAnimationAction(name, action)` | 配置 action 的 loop 模式和 clampWhenFinished |
| `computeAnimNaturalSpeed(name, character)` | 计算动画每循环 XZ 世界位移 / 时长（步速匹配） |

### 必需常量

```js
const ROOT_TRACK_NAME = "Root";        // 骨架顶层骨骼名
const CHARACTER_HEIGHT = 2.2;          // 目标角色身高（世界单位）
const ACTION_FADE_DURATION = 0.22;     // 动作过渡淡入淡出时长（秒）
```

---

## 8. 最小可运行整合示例

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ============ 引入上述核心函数（此处省略具体实现） ============
// 需要自行从 src/main.js 复制以下函数并接入:
//   normalizeModel, mergeAnimationClips, filterAnimationTracks,
//   getDetrendedRootPose, getInPlaceRootPoseQuaternion,
//   configureAnimationAction, computeAnimNaturalSpeed

const loader = new GLTFLoader();

// ===== 第 1 步：加载本体模型 =====
const bodyGltf = await loader.loadAsync('character_body.glb');
normalizeModel(bodyGltf.scene);

const skeletonRoot = bodyGltf.scene.getObjectByName('Root');
const rootRestPos    = skeletonRoot.position.clone();
const rootRestQuat   = skeletonRoot.quaternion.clone();

const mixer = new THREE.AnimationMixer(bodyGltf.scene);

// ===== 第 2 步：加载 motion_config.json（可选） =====
let motionConfig = {};
try {
  motionConfig = await fetch('motion_config.json').then(r => r.json());
} catch (e) {
  // 使用默认 InPlace 配置
}

// ===== 第 3 步：加载动作 GLB =====
const [idleGltf, walkGltf] = await Promise.all([
  loader.loadAsync('anim_idle.glb'),
  loader.loadAsync('anim_walk.glb'),
]);

// 合并 + 过滤
const idleClip = mergeAnimationClips(idleGltf.animations, 'idle');
const walkClip = mergeAnimationClips(walkGltf.animations, 'walk');

const clips = {
  idle: filterAnimationTracks(idleClip, bodyGltf.scene),
  walk: filterAnimationTracks(walkClip, bodyGltf.scene),
};

// ===== 第 4 步：创建 action =====
const idleAction = mixer.clipAction(clips.idle);
const walkAction = mixer.clipAction(clips.walk);

configureAnimationAction('idle', idleAction);
configureAnimationAction('walk', walkAction);

idleAction.play();

const actions = { idle: idleAction, walk: walkAction };
let currentAction = idleAction;
let currentActionName = 'idle';

const character = {
  root: new THREE.Group(),
  scene: bodyGltf.scene,
  mixer,
  actions,
};
character.root.add(bodyGltf.scene);
scene.add(character.root);

// ===== 第 5 步：每帧更新 =====
function update(delta) {
  // 5.1 推进动画
  mixer.update(delta);

  // 5.2 恢复 Root 骨骼姿势
  const config = motionConfig[currentActionName] || {};
  const clip = clips[currentActionName];
  if (clip) {
    skeletonRoot.position.copy(getDetrendedRootPose(clip, currentAction.time, config));

    const restQuat = config.bakeIntoPoseRotation !== false
      ? rootRestQuat
      : rootRestQuat;
    skeletonRoot.quaternion.copy(
      getInPlaceRootPoseQuaternion(clip, currentAction.time, config, restQuat),
    );
  }

  // 5.3 切换动作
  const nextName = inputForward ? 'walk' : 'idle';
  if (nextName !== currentActionName) {
    const nextAction = actions[nextName];
    if (nextAction) {
      const duration = 0.22;
      nextAction.reset().fadeIn(duration).play();
      currentAction.fadeOut(duration);
      currentAction = nextAction;
      currentActionName = nextName;
    }
  }

  // 5.4 代码位移 + 步速匹配
  if (inputForward) {
    const speed = motionConfig.walk?.codeMoveSpeed ?? 2;
    const naturalSpeed = computeAnimNaturalSpeed('walk', character);
    if (naturalSpeed > 0.1) {
      walkAction.timeScale = THREE.MathUtils.clamp(speed / naturalSpeed, 0, 3.0);
    }
    const forward = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(character.root.quaternion)
      .normalize();
    character.root.position.addScaledVector(forward, speed * delta);
  }

  // 5.5 代码旋转
  if (inputTurn !== 0) {
    character.root.rotation.y += inputTurn * TURN_SPEED * delta;
  }
}
```

---

## 9. 完整函数源代码参考

以下是 `src/main.js` 中核心函数的完整代码，可直接复制后接入。

### 9.1 filterAnimationTracks

```js
function filterAnimationTracks(clip, model) {
  const config = motionConfig[clip.name] || {
    motionMode: "InPlace",
    bakeIntoPoseXZ: true,
    bakeIntoPoseY: true,
    bakeIntoPoseRotation: true,
  };

  const clone = clip.clone();
  clone.tracks = clone.tracks.map((track) => {
    const targetName = getTrackTargetName(track.name);
    if (track.name.endsWith(".scale")) return null;

    if (targetName === ROOT_TRACK_NAME) {
      if (isRotationTrack(track.name)) {
        if (config.motionMode === "InPlace" && config.bakeIntoPoseRotation) return null;
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
            values[i]     = target.position.x + (track.values[i]     - firstX);
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
```

### 9.2 辅助函数

```js
const ROOT_TRACK_NAME = "Root";

function getTrackTargetName(trackName) {
  const dotIndex = trackName.lastIndexOf(".");
  return dotIndex === -1 ? trackName : trackName.slice(0, dotIndex);
}

function isRotationTrack(trackName) {
  return trackName.endsWith(".rotation") || trackName.endsWith(".quaternion");
}

function mergeAnimationClips(clips, name) {
  const tracks = clips.flatMap((clip) => clip.tracks.map((track) => track.clone()));
  return new THREE.AnimationClip(name, -1, tracks);
}

function configureAnimationAction(actionName, action) {
  const config = motionConfig[actionName] || {};
  action.clampWhenFinished = config.loop === false;
  action.setLoop(
    config.loop === false ? THREE.LoopOnce : THREE.LoopRepeat,
    config.loop === false ? 1 : Infinity,
  );
  action.timeScale = 1;
  action.paused = false;
}
```

### 9.3 getTrackValueAtTime

```js
function getTrackValueAtTime(track, time) {
  if (!track || !track.times.length) return null;
  const times = track.times;
  const values = track.values;
  const stride = track.values.length / track.times.length;

  if (time <= times[0]) return Array.from(values.slice(0, stride));
  if (time >= times[times.length - 1]) return Array.from(values.slice(values.length - stride));

  let i = 0;
  while (i < times.length - 1 && time > times[i + 1]) i++;

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
```

### 9.4 calculateClipRootCycle

```js
function calculateClipRootCycle(clip) {
  const cacheKey = "_rootCycleData";
  if (clip[cacheKey]) return clip[cacheKey];

  const posTrack = clip.tracks.find((t) => t.name === "Root.position");
  const rotTrack = clip.tracks.find((t) => t.name === "Root.quaternion" || t.name === "Root.rotation");

  const startPos = new THREE.Vector3();
  const endPos   = new THREE.Vector3();
  const startRot = new THREE.Quaternion();
  const endRot   = new THREE.Quaternion();

  if (posTrack) {
    const vStart = getTrackValueAtTime(posTrack, 0);
    const vEnd   = getTrackValueAtTime(posTrack, clip.duration);
    if (vStart) startPos.fromArray(vStart);
    if (vEnd)   endPos.fromArray(vEnd);
  }

  if (rotTrack) {
    const qStart = getTrackValueAtTime(rotTrack, 0);
    const qEnd   = getTrackValueAtTime(rotTrack, clip.duration);
    if (qStart) {
      if (qStart.length === 4) startRot.fromArray(qStart);
      else if (qStart.length === 3) startRot.setFromEuler(new THREE.Euler().fromArray(qStart));
    }
    if (qEnd) {
      if (qEnd.length === 4) endRot.fromArray(qEnd);
      else if (qEnd.length === 3) endRot.setFromEuler(new THREE.Euler().fromArray(qEnd));
    }
  }

  clip[cacheKey] = {
    startPosition: startPos,
    endPosition: endPos,
    cyclePosition: new THREE.Vector3().subVectors(endPos, startPos),
    startRotation: startRot,
    endRotation: endRot,
    cycleRotation: new THREE.Quaternion().copy(startRot).invert().premultiply(endRot),
  };
  return clip[cacheKey];
}
```

### 9.5 sampleClipRootMotion

```js
function sampleClipRootMotion(clip, time) {
  const posTrack = clip.tracks.find((t) => t.name === "Root.position");
  const rotTrack = clip.tracks.find((t) => t.name === "Root.quaternion" || t.name === "Root.rotation");
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
```

### 9.6 getDetrendedRootPose

```js
function getDetrendedRootPose(clip, time, config = {}) {
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
```

### 9.7 getInPlaceRootPoseQuaternion

```js
function getInPlaceRootPoseQuaternion(clip, time, config = {}, restQuaternion = new THREE.Quaternion()) {
  if (!clip || config.bakeIntoPoseRotation !== false) {
    return restQuaternion.clone();
  }

  const hasRootRotationTrack = clip.tracks.some(
    (track) => track.name === "Root.quaternion" || track.name === "Root.rotation",
  );
  if (!hasRootRotationTrack) return restQuaternion.clone();

  return sampleClipRootMotion(clip, time).quaternion;
}
```

### 9.8 normalizeModel

```js
function normalizeModel(model) {
  const CHARACTER_HEIGHT = 2.2;

  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const scale = CHARACTER_HEIGHT / Math.max(size.y, 0.001);
  model.scale.multiplyScalar(scale);

  const scaledBox = new THREE.Box3().setFromObject(model);
  const center = scaledBox.getCenter(new THREE.Vector3());
  const minY = scaledBox.min.y;
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= minY;
}
```

### 9.9 computeAnimNaturalSpeed

```js
function computeAnimNaturalSpeed(actionName, character) {
  const clip = clips[actionName]; // 需要将 clips 暴露到可访问的作用域
  if (!clip || clip.duration <= 0) return 0;
  const cycleData = calculateClipRootCycle(clip);
  const localDisp = cycleData.cyclePosition;
  if (!localDisp) return 0;

  // 将局部位移变换到世界空间
  character.scene.updateMatrixWorld(true);
  const m3 = new THREE.Matrix3().setFromMatrix4(character.scene.matrixWorld);
  const worldDisp = localDisp.clone().applyMatrix3(m3);
  const xzDist = Math.sqrt(worldDisp.x * worldDisp.x + worldDisp.z * worldDisp.z);
  return xzDist / clip.duration;
}
```

---

## 10. Blender 导出注意事项

- 本体 GLB 导出前确保所有骨骼在 Rest Pose，NLA 轨道清空
- 动作 GLB 可以 Bake Action 后再导出，也可以保留原始关键帧
- GLB 导出时选 **Y Up** 坐标系，确保与 Three.js 一致
- 动作 GLB 中的骨骼层级必须与本体 GLB **完全相同**
- 使用自动化脚本（如 `tools/build_glb_assets.py`）统一处理转换，避免手动导出引入不一致

---

## 11. 常见问题

| 问题 | 原因 | 解决 |
|---|---|---|
| 角色播放动画时躺倒 | Root Bone 被重置为 identity 而非 Rest Pose | 保存模型的 `rootRestQuaternion`，每帧恢复 |
| 动画循环时角色向前跳一下 | `bakeIntoPoseXZ` 为 false，Root 漂移未去除 | 设为 `true` |
| 播放时上身晃动过大 | Root + Pelvis 双层摆动叠加（Double Oscillation） | 调低 `rootSwayScale`（如 0.4 ~ 0.8） |
| 切换模型后骨骼错位 | Pelvis 未做相对化重定位 | 确认 `filterAnimationTracks` 中 Pelvis position 处理 |
| 动作 GLB 加载后看不到动画 | 骨骼名不匹配 | 用 Blender 检查命名，注意大小写和空格 |
| 走路时脚下打滑 | 未做步速匹配 | 确认 `timeScale = codeSpeed / naturalSpeed` 逻辑 |
| 角色变成了扁平形变 | 其他骨骼 `.position` 轨道未丢弃 | 确认 `filterAnimationTracks` 中 `return null` 分支覆盖了所有非 Root/Pelvis 骨骼 |
