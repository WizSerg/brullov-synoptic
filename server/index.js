import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs-extra";
import multer from "multer";
import archiver from "archiver";
import AdmZip from "adm-zip";
import crypto from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const TCP_PORT = 15000;
const dataDir = path.join(__dirname, "data");
const assetsDir = path.join(dataDir, "assets");
const projectPath = path.join(dataDir, "project.json");
const defaultProject = {
  background: null,
  microphones: [],
  logs: [],
  showLabels: true,
  micSize: 32,
  fontSettings: {
    seatTextFamily: "system-ui",
    seatTextWeight: "bold",
    labelFamily: "system-ui",
    labelWeight: "normal"
  }
};

const tcpClients = new Set();
const sseClients = new Set();

const sanitizeProject = (project) => {
  const base = {
    ...defaultProject,
    ...(project || {})
  };
  const microphones = Array.isArray(base.microphones) ? base.microphones : [];
  let nextMicId = microphones.reduce((max, mic) => {
    if (typeof mic?.micId === "number" && Number.isFinite(mic.micId)) {
      return Math.max(max, Math.floor(mic.micId));
    }
    return max;
  }, 0);

  base.microphones = microphones.map((mic) => {
    let micId = mic?.micId;
    if (typeof micId !== "number" || !Number.isFinite(micId)) {
      nextMicId += 1;
      micId = nextMicId;
    } else {
      micId = Math.floor(micId);
    }

    return {
      ...mic,
      micId,
      isOn: typeof mic?.isOn === "boolean" ? mic.isOn : false
    };
  });

  return base;
};

const ensureData = async () => {
  await fs.ensureDir(assetsDir);
  if (!(await fs.pathExists(projectPath))) {
    await fs.writeJson(projectPath, sanitizeProject(defaultProject), { spaces: 2 });
  }
};

const loadProject = async () => {
  await ensureData();
  const project = await fs.readJson(projectPath);
  const sanitized = sanitizeProject(project);
  await saveProject(sanitized);
  return sanitized;
};

const saveProject = async (project) => {
  await fs.writeJson(projectPath, sanitizeProject(project), { spaces: 2 });
};

const addLog = (project, type, details = null) => {
  const entry = {
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    details
  };
  project.logs.unshift(entry);
  return entry;
};

const writeTcpLine = (socket, line) => {
  socket.write(`${line}\n`);
};

const broadcastTcp = (line) => {
  for (const client of tcpClients) {
    if (client.destroyed) {
      tcpClients.delete(client);
      continue;
    }
    writeTcpLine(client, line);
  }
};

const broadcastSse = (event) => {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
};

const broadcastMicState = (mic) => {
  const state = mic.isOn ? "ON" : "OFF";
  const eventLine = `EVENT MIC ${mic.micId} ${state}`;
  broadcastTcp(eventLine);
  broadcastSse({ type: "MIC_STATE", micId: mic.micId, isOn: mic.isOn });
};

const broadcastConferenceConnectionState = (state) => {
  broadcastTcp(`EVENT ${state}`);
};

const toggleMicByMicId = async (micId) => {
  const project = await loadProject();
  const mic = project.microphones.find((item) => item.micId === micId);
  if (!mic) {
    const eventLine = `EVENT MIC ${micId} NOT_FOUND`;
    broadcastTcp(eventLine);
    return { ok: false };
  }

  mic.isOn = !mic.isOn;
  await saveProject(project);
  broadcastMicState(mic);
  return { ok: true, mic };
};

const handleTcpCommand = async (line) => {
  const match = line.match(/^SET\s+MIC\s+(\d+)\s+TOGGLE$/i);
  if (!match) {
    return;
  }
  const micId = Number.parseInt(match[1], 10);
  if (!Number.isFinite(micId)) {
    return;
  }
  await toggleMicByMicId(micId);
};

const tcpServer = net.createServer((socket) => {
  socket.setEncoding("utf8");
  tcpClients.add(socket);
  writeTcpLine(socket, "SYNOPTIC/1.0");
  broadcastConferenceConnectionState("CONNECTED");

  let buffer = "";

  socket.on("data", async (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const line = part.trim();
      if (!line) {
        continue;
      }
      try {
        await handleTcpCommand(line);
      } catch (error) {
        console.error("Failed to process TCP command", error);
      }
    }
  });

  socket.on("close", () => {
    tcpClients.delete(socket);
    broadcastConferenceConnectionState("DISCONNECTED");
  });

  socket.on("error", () => {
    tcpClients.delete(socket);
  });
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`Synoptic TCP integration server running on port ${TCP_PORT}`);
});

app.use(express.json({ limit: "10mb" }));
app.use(cors());

const backgroundStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, assetsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path
      .basename(file.originalname, ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${Date.now()}-${base || "background"}${ext}`);
  }
});

const backgroundUpload = multer({ storage: backgroundStorage });
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use("/assets", express.static(assetsDir));

app.get("/api/events", (_req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write("data: {}\n\n");

  sseClients.add(res);
  _req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/api/project", async (_req, res) => {
  const project = await loadProject();
  res.json(project);
});

app.post("/api/project", async (req, res) => {
  const project = await loadProject();
  const { background, microphones } = req.body || {};
  const { showLabels, micSize, fontSettings } = req.body || {};
  if (background !== undefined) {
    project.background = background;
  }
  if (microphones !== undefined) {
    project.microphones = microphones;
  }
  if (showLabels !== undefined) {
    project.showLabels = showLabels;
  }
  if (micSize !== undefined) {
    project.micSize = micSize;
  }
  if (fontSettings !== undefined) {
    project.fontSettings = {
      ...defaultProject.fontSettings,
      ...fontSettings
    };
  }
  addLog(project, "save", { microphoneCount: project.microphones.length });
  await saveProject(project);
  res.json(sanitizeProject(project));
});

app.post("/api/microphones/:micId/toggle", async (req, res) => {
  const micId = Number.parseInt(req.params.micId, 10);
  if (!Number.isFinite(micId)) {
    res.status(400).json({ error: "Invalid micId" });
    return;
  }

  const result = await toggleMicByMicId(micId);
  if (!result.ok) {
    res.status(404).json({ error: "Microphone not found" });
    return;
  }

  const project = await loadProject();
  res.json(project);
});

app.post("/api/log", async (req, res) => {
  const { type, details } = req.body || {};
  if (!type) {
    res.status(400).json({ error: "Missing log type" });
    return;
  }
  const project = await loadProject();
  addLog(project, type, details ?? null);
  await saveProject(project);
  res.json(project.logs);
});

app.post("/api/background", backgroundUpload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const project = await loadProject();
  const background = {
    filename: req.file.filename,
    url: `/assets/${req.file.filename}`
  };
  project.background = background;
  addLog(project, "background_upload", { filename: req.file.filename });
  await saveProject(project);
  res.json(project);
});

app.post("/api/export", async (req, res) => {
  const project = await loadProject();
  const exportProject = {
    ...project,
    ...(req.body || {}),
    background: req.body?.background !== undefined ? req.body.background : project.background,
    microphones: req.body?.microphones !== undefined ? req.body.microphones : project.microphones,
    showLabels: req.body?.showLabels !== undefined ? req.body.showLabels : project.showLabels,
    micSize: req.body?.micSize !== undefined ? req.body.micSize : project.micSize,
    fontSettings: req.body?.fontSettings !== undefined ? req.body.fontSettings : project.fontSettings,
    logs: req.body?.logs !== undefined ? req.body.logs : project.logs
  };

  res.attachment("project.zip");
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    res.status(500).json({ error: err.message });
  });
  archive.pipe(res);
  archive.append(JSON.stringify(sanitizeProject(exportProject), null, 2), { name: "project.json" });
  if (await fs.pathExists(assetsDir)) {
    archive.directory(assetsDir, "assets");
  }
  await archive.finalize();
});

app.post("/api/import", importUpload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const zip = new AdmZip(req.file.buffer);
  await fs.ensureDir(assetsDir);
  await fs.emptyDir(assetsDir);

  let project = { ...defaultProject };

  for (const entry of zip.getEntries()) {
    const entryName = entry.entryName;
    if (entryName === "project.json") {
      project = JSON.parse(entry.getData().toString("utf8"));
      continue;
    }
    if (entryName.startsWith("assets/") && !entry.isDirectory) {
      const relPath = entryName.replace(/^assets\//, "");
      if (!relPath) {
        continue;
      }
      const dest = path.join(assetsDir, relPath);
      await fs.ensureDir(path.dirname(dest));
      await fs.writeFile(dest, entry.getData());
    }
  }

  if (!Array.isArray(project.logs)) {
    project.logs = [];
  }
  if (typeof project.showLabels !== "boolean") {
    project.showLabels = defaultProject.showLabels;
  }
  if (typeof project.micSize !== "number") {
    project.micSize = defaultProject.micSize;
  }
  project.fontSettings = {
    ...defaultProject.fontSettings,
    ...(project.fontSettings || {})
  };

  project = sanitizeProject(project);

  addLog(project, "import", { assetCount: (await fs.readdir(assetsDir)).length });
  await saveProject(project);
  res.json(project);
});

if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Synoptic server running on port ${PORT}`);
});
