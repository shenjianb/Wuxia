import { readFile } from "node:fs/promises";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const loader = new GLTFLoader();

async function loadGltf(path) {
  const buffer = await readFile(path);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Promise((resolve, reject) => loader.parse(arrayBuffer, "", resolve, reject));
}

for (const path of process.argv.slice(2)) {
  const gltf = await loadGltf(path);
  const objects = [];
  gltf.scene.traverse((obj) => {
    objects.push({
      name: obj.name,
      type: obj.type,
      parent: obj.parent?.name ?? null,
      isBone: obj.isBone,
      isSkinnedMesh: obj.isSkinnedMesh,
    });
  });
  console.log(JSON.stringify({
    path,
    objects,
    animations: gltf.animations.map((clip) => ({
      name: clip.name,
      duration: clip.duration,
      tracks: clip.tracks.map((track) => track.name),
    })),
  }, null, 2));
}
