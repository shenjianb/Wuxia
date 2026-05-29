import * as THREE from "three/webgpu";

export function createTerrainMesh(gridX, gridZ, worldSizeX, worldSizeZ) {
  const segsX = Math.max(1, gridX - 1);
  const segsZ = Math.max(1, gridZ - 1);
  const geometry = new THREE.PlaneGeometry(worldSizeX, worldSizeZ, segsX, segsZ);
  geometry.rotateX(-Math.PI / 2);

  const vertexCount = gridX * gridZ;
  const colors = new Float32Array(vertexCount * 3);
  colors.fill(0.5);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    roughness: 0.88,
    metalness: 0,
    vertexColors: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "Terrain";
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  mesh.userData = { gridX, gridZ, worldSizeX, worldSizeZ };

  syncHeightData(mesh);

  const wireframe = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color: 0x79d2c0, transparent: true, opacity: 0.55, depthTest: false }),
  );
  wireframe.name = "TerrainWireframe";
  wireframe.visible = false;

  return { mesh, wireframe };
}

export function syncHeightData(terrainMesh) {
  const positions = terrainMesh.geometry.attributes.position.array;
  const { gridX, gridZ } = terrainMesh.userData;
  const vertexCount = gridX * gridZ;
  if (!terrainMesh.userData.heightData || terrainMesh.userData.heightData.length !== vertexCount) {
    terrainMesh.userData.heightData = new Float32Array(vertexCount);
  }
  const hd = terrainMesh.userData.heightData;
  for (let i = 0; i < vertexCount; i++) {
    hd[i] = positions[i * 3 + 1];
  }
}

export function getVerticesInRadius(terrainMesh, worldCenter, radius) {
  const { gridX, gridZ, worldSizeX, worldSizeZ } = terrainMesh.userData;
  const localCenter = terrainMesh.worldToLocal(worldCenter.clone());
  const stepX = gridX > 1 ? worldSizeX / (gridX - 1) : worldSizeX;
  const stepZ = gridZ > 1 ? worldSizeZ / (gridZ - 1) : worldSizeZ;
  const halfWX = worldSizeX / 2;
  const halfWZ = worldSizeZ / 2;

  const hx = (localCenter.x + halfWX) / stepX;
  const hz = (localCenter.z + halfWZ) / stepZ;
  const rangeX = Math.ceil(radius / stepX);
  const rangeZ = Math.ceil(radius / stepZ);

  const minIX = Math.max(0, Math.floor(hx - rangeX));
  const maxIX = Math.min(gridX - 1, Math.ceil(hx + rangeX));
  const minIZ = Math.max(0, Math.floor(hz - rangeZ));
  const maxIZ = Math.min(gridZ - 1, Math.ceil(hz + rangeZ));

  const result = [];
  const radiusSq = radius * radius;

  for (let iz = minIZ; iz <= maxIZ; iz++) {
    for (let ix = minIX; ix <= maxIX; ix++) {
      const vi = iz * gridX + ix;
      const vx = -halfWX + ix * stepX;
      const vz = -halfWZ + iz * stepZ;
      const distSq = (vx - localCenter.x) ** 2 + (vz - localCenter.z) ** 2;
      if (distSq <= radiusSq) {
        const dist = Math.sqrt(distSq);
        const weight = (1 - dist / radius) ** 2;
        result.push({ vertexIndex: vi, weight, dist });
      }
    }
  }
  return result;
}

export function applyHeightBrush(terrainMesh, worldHit, radius, tool, strength) {
  const positions = terrainMesh.geometry.attributes.position.array;
  const heightData = terrainMesh.userData.heightData;
  const vertices = getVerticesInRadius(terrainMesh, worldHit, radius);
  if (!vertices.length) return;

  if (tool === "flatten") {
    let sumH = 0;
    let sumW = 0;
    for (const v of vertices) {
      const h = heightData[v.vertexIndex];
      sumH += h * v.weight;
      sumW += v.weight;
    }
    const targetH = sumW > 1e-6 ? sumH / sumW : 0;
    for (const v of vertices) {
      const t = THREE.MathUtils.clamp(strength * v.weight, 0, 1);
      const newH = heightData[v.vertexIndex] + (targetH - heightData[v.vertexIndex]) * t;
      heightData[v.vertexIndex] = newH;
      positions[v.vertexIndex * 3 + 1] = newH;
    }
  } else {
    const sign = tool === "raise" ? 1 : -1;
    const delta = sign * strength * 0.05;
    for (const v of vertices) {
      const newH = heightData[v.vertexIndex] + delta * v.weight;
      heightData[v.vertexIndex] = newH;
      positions[v.vertexIndex * 3 + 1] = newH;
    }
  }

  terrainMesh.geometry.attributes.position.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

export function setTerrainHeights(terrainMesh, heightArray) {
  const positions = terrainMesh.geometry.attributes.position.array;
  const heightData = terrainMesh.userData.heightData;
  const count = Math.min(heightArray.length, heightData.length);
  for (let i = 0; i < count; i++) {
    heightData[i] = heightArray[i];
    positions[i * 3 + 1] = heightArray[i];
  }
  terrainMesh.geometry.attributes.position.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

export function getTerrainHeights(terrainMesh) {
  return new Float32Array(terrainMesh.userData.heightData);
}

export function getTerrainVertexCount(terrainMesh) {
  return terrainMesh.userData.gridX * terrainMesh.userData.gridZ;
}

export function setTerrainVertexColors(terrainMesh, colorArray) {
  const colors = terrainMesh.geometry.attributes.color;
  if (!colors) return;
  const count = Math.min(colorArray.length, colors.array.length);
  for (let i = 0; i < count; i++) {
    colors.array[i] = colorArray[i];
  }
  colors.needsUpdate = true;
}

export function rebuildTerrain(terrainMesh, wireframe, gridX, gridZ, worldSizeX, worldSizeZ) {
  const oldHD = terrainMesh.userData.heightData;
  const oldGridX = terrainMesh.userData.gridX;
  const oldGridZ = terrainMesh.userData.gridZ;

  const segsX = Math.max(1, gridX - 1);
  const segsZ = Math.max(1, gridZ - 1);
  const newGeometry = new THREE.PlaneGeometry(worldSizeX, worldSizeZ, segsX, segsZ);
  newGeometry.rotateX(-Math.PI / 2);

  const vertexCount = gridX * gridZ;
  const colors = new Float32Array(vertexCount * 3);
  colors.fill(0.5);
  newGeometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const newHD = new Float32Array(vertexCount);
  const positions = newGeometry.attributes.position.array;

  if (oldHD && oldGridX && oldGridZ) {
    const oldStepX = oldGridX > 1 ? worldSizeX / (oldGridX - 1) : worldSizeX;
    const oldStepZ = oldGridZ > 1 ? worldSizeZ / (oldGridZ - 1) : worldSizeZ;
    const newStepX = gridX > 1 ? worldSizeX / (gridX - 1) : worldSizeX;
    const newStepZ = gridZ > 1 ? worldSizeZ / (gridZ - 1) : worldSizeZ;
    const halfWX = worldSizeX / 2;
    const halfWZ = worldSizeZ / 2;

    for (let iz = 0; iz < gridZ; iz++) {
      for (let ix = 0; ix < gridX; ix++) {
        const vi = iz * gridX + ix;
        const wx = -halfWX + ix * newStepX;
        const wz = -halfWZ + iz * newStepZ;
        const oix = THREE.MathUtils.clamp(Math.round((wx + halfWX) / oldStepX), 0, oldGridX - 1);
        const oiz = THREE.MathUtils.clamp(Math.round((wz + halfWZ) / oldStepZ), 0, oldGridZ - 1);
        newHD[vi] = oldHD[oiz * oldGridX + oix];
        positions[vi * 3 + 1] = newHD[vi];
      }
    }
  }

  terrainMesh.geometry.dispose();
  terrainMesh.geometry = newGeometry;
  terrainMesh.userData = { gridX, gridZ, worldSizeX, worldSizeZ, heightData: newHD };

  if (wireframe) {
    wireframe.geometry.dispose();
    wireframe.geometry = new THREE.EdgesGeometry(newGeometry);
    wireframe.material.depthTest = false;
    wireframe.material.opacity = 0.55;
  }

  return terrainMesh;
}

export function updateTerrainWireframe(terrainMesh, wireframe) {
  if (!wireframe) return;
  wireframe.geometry.dispose();
  wireframe.geometry = new THREE.EdgesGeometry(terrainMesh.geometry);
  wireframe.material.depthTest = false;
  wireframe.material.opacity = 0.55;
}
