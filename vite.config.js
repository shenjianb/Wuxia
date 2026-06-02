import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const animationAssetsPath = path.resolve(projectRoot, "public/assets/animations");
const motionConfigPath = path.resolve(animationAssetsPath, "motion_config.json");
const scenesPath = path.resolve(projectRoot, "public/assets/scenes");
const npcsPath = path.resolve(projectRoot, "public/assets/npcs");
const behaviorTreesPath = path.resolve(projectRoot, "public/assets/behavior-trees");
const aiProfilesPath = path.resolve(projectRoot, "public/assets/ai-profiles");

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function motionConfigApi() {
  return {
    name: "motion-config-api",
    configureServer(server) {
      server.middlewares.use("/api/animation-assets", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.setHeader("Allow", "GET");
            res.end();
            return;
          }

          const entries = await fs.readdir(animationAssetsPath, { withFileTypes: true });
          const files = entries
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".glb"))
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
          sendJson(res, 200, { files });
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });

      server.middlewares.use("/api/motion-config", async (req, res) => {
        try {
          if (req.method === "GET") {
            const file = await fs.readFile(motionConfigPath, "utf8");
            sendJson(res, 200, JSON.parse(file));
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            const config = payload.config ?? payload;

            if (!config || Array.isArray(config) || typeof config !== "object") {
              sendJson(res, 400, { error: "Motion config must be a JSON object." });
              return;
            }

            await fs.writeFile(motionConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, POST");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

function scenesApi() {
  return {
    name: "scenes-api",
    configureServer(server) {
      server.middlewares.use("/api/scenes", async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
          const pathParts = url.pathname.replace("/api/scenes", "").replace(/^\/+/, "");
          const sceneName = decodeURIComponent(pathParts);

          if (!sceneName && req.method === "GET") {
            await fs.mkdir(scenesPath, { recursive: true });
            const entries = await fs.readdir(scenesPath, { withFileTypes: true });
            const scenes = [];
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith(".json")) {
                try {
                  const content = await fs.readFile(path.join(scenesPath, entry.name), "utf8");
                  const data = JSON.parse(content);
                  scenes.push({
                    name: data.name || entry.name.replace(".json", ""),
                    created: data.created || "",
                    modified: data.modified || "",
                  });
                } catch {
                  scenes.push({ name: entry.name.replace(".json", ""), created: "", modified: "" });
                }
              }
            }
            sendJson(res, 200, { scenes });
            return;
          }

          if (!sceneName) {
            res.statusCode = 400;
            sendJson(res, 400, { error: "Scene name is required." });
            return;
          }

          const safeName = sceneName.replace(/[<>:"/\\|?*]/g, "_");
          const filePath = path.join(scenesPath, `${safeName}.json`);

          if (req.method === "GET") {
            try {
              const content = await fs.readFile(filePath, "utf8");
              sendJson(res, 200, JSON.parse(content));
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `Scene "${sceneName}" not found.` });
            }
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            if (!payload || typeof payload !== "object") {
              sendJson(res, 400, { error: "Scene data must be a JSON object." });
              return;
            }
            payload.name = payload.name || sceneName;
            payload.modified = new Date().toISOString();
            payload.created = payload.created || payload.modified;
            await fs.mkdir(scenesPath, { recursive: true });
            await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "DELETE") {
            try {
              await fs.unlink(filePath);
              sendJson(res, 200, { ok: true });
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `Scene "${sceneName}" not found.` });
            }
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, DELETE");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

function behaviorTreesApi() {
  return {
    name: "behavior-trees-api",
    configureServer(server) {
      server.middlewares.use("/api/behavior-trees", async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
          const pathParts = url.pathname.replace("/api/behavior-trees", "").replace(/^\/+/, "");
          const treeId = decodeURIComponent(pathParts);

          if (!treeId && req.method === "GET") {
            await fs.mkdir(behaviorTreesPath, { recursive: true });
            const entries = await fs.readdir(behaviorTreesPath, { withFileTypes: true });
            const trees = [];
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith(".json")) {
                try {
                  const content = await fs.readFile(path.join(behaviorTreesPath, entry.name), "utf8");
                  const data = JSON.parse(content);
                  trees.push({
                    id: data.id || entry.name.replace(".json", ""),
                    name: data.name || data.id || entry.name.replace(".json", ""),
                    created: data.created || "",
                    modified: data.modified || "",
                  });
                } catch {
                  const baseName = entry.name.replace(".json", "");
                  trees.push({ id: baseName, name: baseName, created: "", modified: "" });
                }
              }
            }
            trees.sort((a, b) => (a.created || "").localeCompare(b.created || ""));
            sendJson(res, 200, { trees });
            return;
          }

          if (!treeId) {
            sendJson(res, 400, { error: "Tree id is required." });
            return;
          }

          const safeId = treeId.replace(/[<>:"/\\|?*]/g, "_");
          const filePath = path.join(behaviorTreesPath, `${safeId}.json`);

          if (req.method === "GET") {
            try {
              const content = await fs.readFile(filePath, "utf8");
              sendJson(res, 200, JSON.parse(content));
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `Behavior tree "${treeId}" not found.` });
            }
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            if (!payload || typeof payload !== "object") {
              sendJson(res, 400, { error: "Behavior tree data must be a JSON object." });
              return;
            }
            payload.id = payload.id || treeId;
            payload.modified = new Date().toISOString();
            payload.created = payload.created || payload.modified;
            if (!payload.name) payload.name = payload.id;
            await fs.mkdir(behaviorTreesPath, { recursive: true });
            await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "DELETE") {
            try {
              await fs.unlink(filePath);
              sendJson(res, 200, { ok: true });
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `Behavior tree "${treeId}" not found.` });
            }
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, DELETE");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

function aiProfilesApi() {
  const profileTypes = new Set(["brain-processing", "personality"]);

  return {
    name: "ai-profiles-api",
    configureServer(server) {
      server.middlewares.use("/api/ai-profiles", async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
          const pathParts = url.pathname
            .replace("/api/ai-profiles", "")
            .replace(/^\/+/, "")
            .split("/")
            .filter(Boolean)
            .map((part) => decodeURIComponent(part));
          const profileType = pathParts[0] || "";
          const profileId = pathParts[1] || "";

          if (!profileTypes.has(profileType)) {
            sendJson(res, 400, { error: "Profile type must be brain-processing or personality." });
            return;
          }

          const typePath = path.join(aiProfilesPath, profileType);

          if (!profileId && req.method === "GET") {
            await fs.mkdir(typePath, { recursive: true });
            const entries = await fs.readdir(typePath, { withFileTypes: true });
            const profiles = [];
            for (const entry of entries) {
              if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
              try {
                const content = await fs.readFile(path.join(typePath, entry.name), "utf8");
                const data = JSON.parse(content);
                profiles.push({
                  id: data.id || entry.name.replace(".json", ""),
                  name: data.name || data.id || entry.name.replace(".json", ""),
                  description: data.description || "",
                  created: data.created || "",
                  modified: data.modified || "",
                });
              } catch {
                const id = entry.name.replace(".json", "");
                profiles.push({ id, name: id, description: "", created: "", modified: "" });
              }
            }
            profiles.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
            sendJson(res, 200, { profiles });
            return;
          }

          if (!profileId) {
            sendJson(res, 400, { error: "Profile id is required." });
            return;
          }

          const safeId = profileId.replace(/[<>:"/\\|?*]/g, "_");
          const filePath = path.join(typePath, `${safeId}.json`);

          if (req.method === "GET") {
            try {
              const content = await fs.readFile(filePath, "utf8");
              sendJson(res, 200, JSON.parse(content));
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `AI profile "${profileId}" not found.` });
            }
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            if (!payload || typeof payload !== "object") {
              sendJson(res, 400, { error: "AI profile data must be a JSON object." });
              return;
            }
            payload.id = payload.id || profileId;
            payload.type = profileType;
            payload.modified = new Date().toISOString();
            payload.created = payload.created || payload.modified;
            if (!payload.name) payload.name = payload.id;
            await fs.mkdir(typePath, { recursive: true });
            await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "DELETE") {
            try {
              await fs.unlink(filePath);
              sendJson(res, 200, { ok: true });
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `AI profile "${profileId}" not found.` });
            }
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, DELETE");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

function npcApi() {
  return {
    name: "npc-api",
    configureServer(server) {
      server.middlewares.use("/api/npcs", async (req, res) => {
        try {
          const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
          const pathParts = url.pathname.replace("/api/npcs", "").replace(/^\/+/, "");
          const npcId = decodeURIComponent(pathParts);

          if (!npcId && req.method === "GET") {
            await fs.mkdir(npcsPath, { recursive: true });
            const entries = await fs.readdir(npcsPath, { withFileTypes: true });
            const npcs = [];
            for (const entry of entries) {
              if (entry.isFile() && entry.name.endsWith(".json")) {
                try {
                  const content = await fs.readFile(path.join(npcsPath, entry.name), "utf8");
                  const data = JSON.parse(content);
                  npcs.push({
                    id: data.id || entry.name.replace(".json", ""),
                    name: data.attributes?.name || data.id || entry.name.replace(".json", ""),
                    faction: data.faction !== undefined ? data.faction : 0,
                    modelType: data.modelType || "BaseMale",
                    created: data.created || "",
                    modified: data.modified || "",
                  });
                } catch {
                  npcs.push({ id: entry.name.replace(".json", ""), name: entry.name.replace(".json", ""), faction: 0, modelType: "BaseMale", created: "", modified: "" });
                }
              }
            }
            sendJson(res, 200, { npcs });
            return;
          }

          if (!npcId) {
            res.statusCode = 400;
            sendJson(res, 400, { error: "NPC id is required." });
            return;
          }

          const safeId = npcId.replace(/[<>:"/\\|?*]/g, "_");
          const filePath = path.join(npcsPath, `${safeId}.json`);

          if (req.method === "GET") {
            try {
              const content = await fs.readFile(filePath, "utf8");
              sendJson(res, 200, JSON.parse(content));
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `NPC "${npcId}" not found.` });
            }
            return;
          }

          if (req.method === "PUT" || req.method === "POST") {
            const body = await readRequestBody(req);
            const payload = JSON.parse(body || "{}");
            if (!payload || typeof payload !== "object") {
              sendJson(res, 400, { error: "NPC data must be a JSON object." });
              return;
            }
            payload.id = payload.id || npcId;
            payload.modified = new Date().toISOString();
            payload.created = payload.created || payload.modified;
            await fs.mkdir(npcsPath, { recursive: true });
            await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
            sendJson(res, 200, { ok: true });
            return;
          }

          if (req.method === "DELETE") {
            try {
              await fs.unlink(filePath);
              sendJson(res, 200, { ok: true });
            } catch {
              res.statusCode = 404;
              sendJson(res, 404, { error: `NPC "${npcId}" not found.` });
            }
            return;
          }

          res.statusCode = 405;
          res.setHeader("Allow", "GET, PUT, DELETE");
          res.end();
        } catch (error) {
          sendJson(res, 500, { error: error.message });
        }
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [motionConfigApi(), scenesApi(), npcApi(), behaviorTreesApi(), aiProfilesApi()],
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(projectRoot, "index.html"),
        motionEditor: path.resolve(projectRoot, "motion-editor.html"),
        sceneEditor: path.resolve(projectRoot, "scene-editor.html"),
        npcEditor: path.resolve(projectRoot, "npc-editor.html"),
        behaviorEditor: path.resolve(projectRoot, "behavior-editor.html"),
      },
    },
  },
});
