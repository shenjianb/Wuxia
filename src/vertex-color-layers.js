function normalBlend(dst, src) {
  return [src[0], src[1], src[2]];
}

function multiplyBlend(dst, src) {
  return [dst[0] * src[0], dst[1] * src[1], dst[2] * src[2]];
}

function overlayBlend(dst, src) {
  const result = [];
  for (let i = 0; i < 3; i++) {
    if (dst[i] < 0.5) {
      result.push(2 * dst[i] * src[i]);
    } else {
      result.push(1 - 2 * (1 - dst[i]) * (1 - src[i]));
    }
  }
  return result;
}

export const BLEND_MODES = {
  normal: { label: "覆盖", fn: normalBlend },
  multiply: { label: "正片叠底", fn: multiplyBlend },
  overlay: { label: "叠加", fn: overlayBlend },
};

let nextLayerId = 1;

export class LayerManager {
  constructor(vertexCount) {
    this.vertexCount = vertexCount;
    this.layers = [];
  }

  addLayer(name) {
    const id = `layer_${nextLayerId++}`;
    this.layers.push({
      id,
      name: name || `图层 ${this.layers.length + 1}`,
      visible: true,
      blendMode: "normal",
      order: this.layers.length,
      data: new Map(),
    });
    return id;
  }

  removeLayer(layerId) {
    const idx = this.layers.findIndex((l) => l.id === layerId);
    if (idx === -1) return false;
    this.layers.splice(idx, 1);
    return true;
  }

  getLayer(layerId) {
    return this.layers.find((l) => l.id === layerId) || null;
  }

  getLayerList() {
    return [...this.layers].sort((a, b) => a.order - b.order);
  }

  setLayerVisibility(layerId, visible) {
    const layer = this.getLayer(layerId);
    if (layer) layer.visible = visible;
  }

  setLayerBlendMode(layerId, mode) {
    if (!BLEND_MODES[mode]) return;
    const layer = this.getLayer(layerId);
    if (layer) layer.blendMode = mode;
  }

  moveLayerUp(layerId) {
    const layer = this.getLayer(layerId);
    if (!layer || layer.order <= 0) return;
    const other = this.layers.find((l) => l.order === layer.order - 1);
    if (other) { layer.order--; other.order++; }
  }

  moveLayerDown(layerId) {
    const layer = this.getLayer(layerId);
    if (!layer || layer.order >= this.layers.length - 1) return;
    const other = this.layers.find((l) => l.order === layer.order + 1);
    if (other) { layer.order++; other.order--; }
  }

  paintVertex(layerId, vertexIndex, r, g, b, intensity) {
    const layer = this.getLayer(layerId);
    if (!layer || vertexIndex < 0 || vertexIndex >= this.vertexCount) return;
    intensity = Math.max(0, Math.min(1, intensity));
    if (intensity <= 0) return;

    const existing = layer.data.get(vertexIndex);
    if (existing) {
      const t = intensity;
      existing[0] = existing[0] + (r - existing[0]) * t;
      existing[1] = existing[1] + (g - existing[1]) * t;
      existing[2] = existing[2] + (b - existing[2]) * t;
    } else {
      layer.data.set(vertexIndex, [r * intensity, g * intensity, b * intensity]);
    }
  }

  paintVertices(layerId, vertexEntries, r, g, b, intensity) {
    for (const entry of vertexEntries) {
      this.paintVertex(layerId, entry.vertexIndex, r, g, b, intensity * entry.weight);
    }
  }

  eraseVertices(layerId, vertexIndices) {
    const layer = this.getLayer(layerId);
    if (!layer) return;
    for (const vi of vertexIndices) {
      layer.data.delete(vi);
    }
  }

  compositeAll(baseRGB = [0.5, 0.5, 0.5]) {
    const result = new Float32Array(this.vertexCount * 3);
    result.fill(baseRGB[0]);
    for (let i = 0; i < this.vertexCount; i++) {
      const idx = i * 3;
      result[idx] = baseRGB[0];
      result[idx + 1] = baseRGB[1];
      result[idx + 2] = baseRGB[2];
    }

    const sorted = this.getLayerList().filter((l) => l.visible);
    for (const layer of sorted) {
      const blendFn = BLEND_MODES[layer.blendMode]?.fn ?? normalBlend;
      for (const [vi, color] of layer.data) {
        const idx = vi * 3;
        const dst = [result[idx], result[idx + 1], result[idx + 2]];
        const blended = blendFn(dst, color);
        result[idx] = blended[0];
        result[idx + 1] = blended[1];
        result[idx + 2] = blended[2];
      }
    }
    return result;
  }

  serialize() {
    const sorted = this.getLayerList();
    return sorted.map((layer) => {
      const obj = {};
      for (const [vi, color] of layer.data) {
        obj[vi] = [color[0], color[1], color[2]];
      }
      return {
        id: layer.id,
        name: layer.name,
        visible: layer.visible,
        blendMode: layer.blendMode,
        order: layer.order,
        data: obj,
      };
    });
  }

  deserialize(layersData) {
    this.layers = [];
    for (const ld of layersData) {
      const data = new Map();
      if (ld.data) {
        for (const key of Object.keys(ld.data)) {
          const vi = Number(key);
          const color = ld.data[key];
          if (Array.isArray(color) && color.length >= 3) {
            data.set(vi, [color[0], color[1], color[2]]);
          }
        }
      }
      this.layers.push({
        id: ld.id || `layer_${nextLayerId++}`,
        name: ld.name || "图层",
        visible: ld.visible !== false,
        blendMode: ld.blendMode || "normal",
        order: ld.order ?? this.layers.length,
        data,
      });
    }
  }
}

export class ColorPalette {
  constructor() {
    this.presets = [
      { name: "草绿", hex: "#4CAF50" },
      { name: "泥土", hex: "#8D6E63" },
      { name: "沙地", hex: "#D4C5A9" },
      { name: "岩石", hex: "#78909C" },
      { name: "雪白", hex: "#ECEFF1" },
      { name: "暗绿", hex: "#2E7D32" },
      { name: "棕土", hex: "#5D4037" },
      { name: "灰石", hex: "#616161" },
      { name: "红土", hex: "#D84315" },
      { name: "深水", hex: "#1565C0" },
      { name: "苔绿", hex: "#558B2F" },
      { name: "碳黑", hex: "#37474F" },
    ];
    this.currentHex = this.presets[0].hex;
    this.currentColor = hexToRgb(this.currentHex);
  }

  setColor(hex) {
    this.currentHex = hex;
    this.currentColor = hexToRgb(hex);
  }

  getRGB() {
    return this.currentColor.slice();
  }
}

function hexToRgb(hex) {
  hex = hex.replace("#", "");
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  const num = parseInt(hex, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}
