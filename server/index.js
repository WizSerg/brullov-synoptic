import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs-extra";
import multer from "multer";
import archiver from "archiver";
import AdmZip from "adm-zip";
import crypto from "node:crypto";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
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
    seatTextSize: 18,
    labelFamily: "system-ui",
    labelWeight: "normal",
    labelSize: 12
  }
};

const ensureData = async () => {
  await fs.ensureDir(assetsDir);
  if (!(await fs.pathExists(projectPath))) {
    await fs.writeJson(projectPath, defaultProject, { spaces: 2 });
  }
};

const loadProject = async () => {
  await ensureData();
  return fs.readJson(projectPath);
};

const saveProject = async (project) => {
  await fs.writeJson(projectPath, project, { spaces: 2 });
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
  archive.append(JSON.stringify(exportProject, null, 2), { name: "project.json" });
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
