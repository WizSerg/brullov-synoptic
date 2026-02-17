import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs-extra";
import multer from "multer";
import archiver from "archiver";
import AdmZip from "adm-zip";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const dataDir = path.join(__dirname, "data");
const assetsDir = path.join(dataDir, "assets");
const logsDir = path.join(dataDir, "logs");
const rootPackagePath = path.join(__dirname, "..", "package.json");
const serverPackagePath = path.join(__dirname, "package.json");
const projectPath = path.join(dataDir, "project.json");
const authPath = path.join(dataDir, "auth.json");
const appLogPath = path.join(logsDir, "app.log");
const LOG_ROTATE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const LOG_ROTATE_MAX_FILES = 5;
const BACKGROUND_BASENAME = "background";
const SUPPORTED_BACKGROUND_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
const SESSION_COOKIE_NAME = "synoptic_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const PASSWORD_HASH_ITERATIONS = 120000;
const PASSWORD_HASH_KEYLEN = 64;
const PASSWORD_HASH_DIGEST = "sha512";
const defaultProject = {
  background: false,
  backgroundExt: null,
  backgroundUpdatedAt: null,
  microphones: [],
  showLabels: true,
  micSize: 32,
  fontSettings: {
    seatTextFamily: "system-ui",
    seatTextWeight: "bold",
    labelFamily: "system-ui",
    labelWeight: "normal"
  }
};

const MIC_STATE = {
  ON: "ON",
  OFF: "OFF"
};

const microphoneRuntimeStates = new Map();
const sessionStore = new Map();
let appMetadataPromise = null;

const createPasswordHash = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const hash = crypto
    .pbkdf2Sync(password, salt, PASSWORD_HASH_ITERATIONS, PASSWORD_HASH_KEYLEN, PASSWORD_HASH_DIGEST)
    .toString("hex");

  return {
    hash,
    salt,
    iterations: PASSWORD_HASH_ITERATIONS,
    keylen: PASSWORD_HASH_KEYLEN,
    digest: PASSWORD_HASH_DIGEST
  };
};

const verifyPassword = (password, authConfig) => {
  if (!password || !authConfig?.passwordHash || !authConfig?.salt) {
    return false;
  }

  const hash = crypto
    .pbkdf2Sync(
      password,
      authConfig.salt,
      authConfig.iterations || PASSWORD_HASH_ITERATIONS,
      authConfig.keylen || PASSWORD_HASH_KEYLEN,
      authConfig.digest || PASSWORD_HASH_DIGEST
    )
    .toString("hex");

  if (hash.length !== authConfig.passwordHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(authConfig.passwordHash, "hex"));
};

const parseCookies = (header = "") =>
  header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const [key, ...rest] = item.split("=");
      cookies[key] = decodeURIComponent(rest.join("="));
      return cookies;
    }, {});

const getSessionFromRequest = (req) => {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) {
    return null;
  }

  const session = sessionStore.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt <= Date.now()) {
    sessionStore.delete(token);
    return null;
  }

  return { token, ...session };
};

const setSessionCookie = (res, token) => {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
      SESSION_TTL_MS / 1000
    }${COOKIE_SECURE ? "; Secure" : ""}`
  );
};

const clearSessionCookie = (res) => {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? "; Secure" : ""}`
  );
};

const readAppMetadata = async () => {
  const [rootPackage = {}, serverPackage = {}] = await Promise.all([
    fs.readJson(rootPackagePath).catch(() => ({})),
    fs.readJson(serverPackagePath).catch(() => ({}))
  ]);

  return {
    name: rootPackage.name || serverPackage.name || "synoptic",
    version: rootPackage.version || serverPackage.version || "unknown"
  };
};

const getAppMetadata = async () => {
  if (!appMetadataPromise) {
    appMetadataPromise = readAppMetadata();
  }
  return appMetadataPromise;
};

const ensureData = async () => {
  await fs.ensureDir(assetsDir);
  await fs.ensureDir(logsDir);
  if (!(await fs.pathExists(projectPath))) {
    await fs.writeJson(projectPath, defaultProject, { spaces: 2 });
  }
  if (!(await fs.pathExists(authPath))) {
    const defaultPassword = createPasswordHash("admin");
    await fs.writeJson(
      authPath,
      {
        username: "admin",
        passwordHash: defaultPassword.hash,
        salt: defaultPassword.salt,
        iterations: defaultPassword.iterations,
        keylen: defaultPassword.keylen,
        digest: defaultPassword.digest,
        updatedAt: new Date().toISOString()
      },
      { spaces: 2 }
    );
  }
};

const readAuthConfig = async () => {
  await ensureData();
  return fs.readJson(authPath);
};

const saveAuthConfig = async (authConfig) => {
  await fs.writeJson(authPath, authConfig, { spaces: 2 });
};

const rotateLogsIfNeeded = async (incomingEntryBytes) => {
  if (!(await fs.pathExists(appLogPath))) {
    return;
  }

  const { size } = await fs.stat(appLogPath);
  if (size + incomingEntryBytes <= LOG_ROTATE_MAX_SIZE_BYTES) {
    return;
  }

  const maxSuffix = LOG_ROTATE_MAX_FILES - 1;
  const oldestPath = `${appLogPath}.${maxSuffix}`;
  if (await fs.pathExists(oldestPath)) {
    await fs.remove(oldestPath);
  }

  for (let suffix = maxSuffix - 1; suffix >= 1; suffix -= 1) {
    const sourcePath = `${appLogPath}.${suffix}`;
    const targetPath = `${appLogPath}.${suffix + 1}`;
    if (await fs.pathExists(sourcePath)) {
      await fs.move(sourcePath, targetPath, { overwrite: true });
    }
  }

  await fs.move(appLogPath, `${appLogPath}.1`, { overwrite: true });
};

const appendLogEntry = async (entry) => {
  await ensureData();
  const line = `${JSON.stringify(entry)}\n`;
  const lineBytes = Buffer.byteLength(line, "utf8");
  await rotateLogsIfNeeded(lineBytes);
  await fs.appendFile(appLogPath, line, "utf8");
};

const readRecentLogs = async (limit = 200) => {
  await ensureData();
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.floor(Number(limit))) : 200;

  const logPaths = [];
  for (let suffix = LOG_ROTATE_MAX_FILES - 1; suffix >= 1; suffix -= 1) {
    logPaths.push(`${appLogPath}.${suffix}`);
  }
  logPaths.push(appLogPath);

  const entries = [];
  for (const filePath of logPaths) {
    if (!(await fs.pathExists(filePath))) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  }

  return entries.slice(-normalizedLimit).reverse();
};

const getBackgroundPath = (ext) => path.join(dataDir, `${BACKGROUND_BASENAME}.${ext}`);

const getBackgroundExtensionFromName = (filename = "") => {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  return SUPPORTED_BACKGROUND_EXTENSIONS.has(ext) ? ext : null;
};

const resolveBackgroundExtension = ({ mimetype, originalname }) => {
  if (mimetype === "image/png") {
    return "png";
  }
  if (mimetype === "image/jpeg") {
    return "jpg";
  }
  return getBackgroundExtensionFromName(originalname);
};

const removeStoredBackgroundFiles = async ({ keepExt = null } = {}) => {
  const entries = await fs.readdir(dataDir);
  const keepFilename = keepExt ? `${BACKGROUND_BASENAME}.${keepExt}` : null;
  await Promise.all(
    entries
      .filter((entry) => {
        if (!entry.startsWith(`${BACKGROUND_BASENAME}.`)) {
          return false;
        }
        if (keepFilename && entry === keepFilename) {
          return false;
        }
        return Boolean(getBackgroundExtensionFromName(entry));
      })
      .map((entry) => fs.remove(path.join(dataDir, entry)))
  );
};

const normalizeProjectBackground = async (project) => {
  const existingExt = typeof project.backgroundExt === "string" ? project.backgroundExt : null;
  const hasExisting =
    Boolean(project.background) && Boolean(existingExt) && (await fs.pathExists(getBackgroundPath(existingExt)));

  if (hasExisting) {
    await removeStoredBackgroundFiles({ keepExt: existingExt });
    return {
      ...project,
      background: true,
      backgroundExt: existingExt,
      backgroundUpdatedAt: project.backgroundUpdatedAt ?? null
    };
  }

  if (project.background?.filename) {
    const legacyExt = getBackgroundExtensionFromName(project.background.filename);
    const legacyPath = legacyExt ? path.join(assetsDir, project.background.filename) : null;
    if (legacyPath && (await fs.pathExists(legacyPath))) {
      const destination = getBackgroundPath(legacyExt);
      await removeStoredBackgroundFiles();
      await fs.copyFile(legacyPath, destination);
      return {
        ...project,
        background: true,
        backgroundExt: legacyExt,
        backgroundUpdatedAt: new Date().toISOString()
      };
    }
  }

  await removeStoredBackgroundFiles();
  return {
    ...project,
    background: false,
    backgroundExt: null,
    backgroundUpdatedAt: null
  };
};

const loadProject = async () => {
  await ensureData();
  const project = await fs.readJson(projectPath);
  const { logs: _legacyLogs, ...projectWithoutLogs } = project;
  const normalizedProject = await normalizeProjectBackground(projectWithoutLogs);
  if (JSON.stringify(project) !== JSON.stringify(normalizedProject)) {
    await saveProject(normalizedProject);
  }
  return normalizedProject;
};

const saveProject = async (project) => {
  await fs.writeJson(projectPath, project, { spaces: 2 });
};

const normalizeRuntimeMicState = (state) => (state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF);

const withRuntimeMicStates = (project) => {
  const microphones = Array.isArray(project.microphones)
    ? project.microphones.map((mic) => ({
        ...mic,
        state: normalizeRuntimeMicState(microphoneRuntimeStates.get(mic.id))
      }))
    : [];
  return {
    ...project,
    microphones
  };
};

const reconcileRuntimeMicStates = (microphones) => {
  const incomingIds = new Set();
  for (const mic of microphones || []) {
    if (!mic?.id) {
      continue;
    }
    incomingIds.add(mic.id);
    if (!microphoneRuntimeStates.has(mic.id)) {
      microphoneRuntimeStates.set(mic.id, MIC_STATE.OFF);
    }
  }

  for (const micId of microphoneRuntimeStates.keys()) {
    if (!incomingIds.has(micId)) {
      microphoneRuntimeStates.delete(micId);
    }
  }
};

const sanitizeMicrophonesForStorage = (microphones) =>
  (microphones || []).map((mic) => {
    const { state: _state, ...persistedMic } = mic;
    return persistedMic;
  });

const addLog = async (type, details = null) => {
  const entry = {
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    details
  };
  await appendLogEntry(entry);
  return entry;
};

app.use(express.json({ limit: "10mb" }));
app.use(cors());

const requireAuth = (req, res, next) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  req.session = session;
  next();
};

const backgroundUpload = multer({ storage: multer.memoryStorage() });
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use("/assets", express.static(assetsDir));

app.get("/api/auth/me", async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ authenticated: false });
    return;
  }

  const authConfig = await readAuthConfig();
  res.json({ authenticated: true, username: authConfig.username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const authConfig = await readAuthConfig();
  const validUsername = typeof username === "string" && username === authConfig.username;
  const validPassword = typeof password === "string" && verifyPassword(password, authConfig);

  if (!validUsername || !validPassword) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessionStore.set(token, {
    username: authConfig.username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  setSessionCookie(res, token);
  res.json({ success: true, username: authConfig.username });
});

app.post("/api/logout", (req, res) => {
  const session = getSessionFromRequest(req);
  if (session?.token) {
    sessionStore.delete(session.token);
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof oldPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 1) {
    res.status(400).json({ error: "Invalid password payload" });
    return;
  }

  const authConfig = await readAuthConfig();
  if (!verifyPassword(oldPassword, authConfig)) {
    res.status(400).json({ error: "Old password is incorrect" });
    return;
  }

  const nextPassword = createPasswordHash(newPassword);
  const nextAuthConfig = {
    username: authConfig.username,
    passwordHash: nextPassword.hash,
    salt: nextPassword.salt,
    iterations: nextPassword.iterations,
    keylen: nextPassword.keylen,
    digest: nextPassword.digest,
    updatedAt: new Date().toISOString()
  };

  await saveAuthConfig(nextAuthConfig);
  await addLog("password_change", { username: authConfig.username });
  res.json({ success: true });
});

app.get("/api/background/file", requireAuth, async (_req, res) => {
  const project = await loadProject();
  if (!project.background || !project.backgroundExt) {
    res.status(404).json({ error: "No background image" });
    return;
  }

  const backgroundPath = getBackgroundPath(project.backgroundExt);
  if (!(await fs.pathExists(backgroundPath))) {
    res.status(404).json({ error: "No background image" });
    return;
  }

  res.sendFile(backgroundPath);
});

app.get("/api/project", requireAuth, async (_req, res) => {
  const project = await loadProject();
  reconcileRuntimeMicStates(project.microphones);
  res.json(withRuntimeMicStates(project));
});

app.post("/api/project", requireAuth, async (req, res) => {
  const project = await loadProject();
  const { background, microphones } = req.body || {};
  const { showLabels, micSize, fontSettings } = req.body || {};
  if (background !== undefined) {
    project.background = Boolean(background);
    if (!project.background) {
      project.backgroundExt = null;
      project.backgroundUpdatedAt = null;
      await removeStoredBackgroundFiles();
    }
  }
  if (microphones !== undefined) {
    project.microphones = sanitizeMicrophonesForStorage(microphones);
    reconcileRuntimeMicStates(project.microphones);
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
  await addLog("save", { microphoneCount: project.microphones.length });
  await saveProject(project);
  res.json(withRuntimeMicStates(project));
});

app.post("/api/microphones/:id/toggle", requireAuth, async (req, res) => {
  const micId = req.params.id;
  if (!micId) {
    res.status(400).json({ error: "Missing microphone id" });
    return;
  }

  const project = await loadProject();
  const micExists = Array.isArray(project.microphones) && project.microphones.some((mic) => mic.id === micId);
  if (!micExists) {
    res.status(404).json({ error: "Microphone not found" });
    return;
  }

  const currentState = normalizeRuntimeMicState(microphoneRuntimeStates.get(micId));
  const nextState = currentState === MIC_STATE.ON ? MIC_STATE.OFF : MIC_STATE.ON;
  microphoneRuntimeStates.set(micId, nextState);

  await addLog("mic_toggle", { id: micId, state: nextState, source: "run_click" });

  res.json({ id: micId, state: nextState });
});

app.get("/api/logs", requireAuth, async (req, res) => {
  const limit = req.query.limit ?? 200;
  const logs = await readRecentLogs(limit);
  res.json(logs);
});

app.post("/api/log", requireAuth, async (req, res) => {
  const { type, details } = req.body || {};
  if (!type) {
    res.status(400).json({ error: "Missing log type" });
    return;
  }
  await addLog(type, details ?? null);
  const logs = await readRecentLogs(200);
  res.json(logs);
});

app.post("/api/background", requireAuth, backgroundUpload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const backgroundExt = resolveBackgroundExtension(req.file);
  if (!backgroundExt) {
    res.status(400).json({ error: "Unsupported image type. Use PNG or JPEG." });
    return;
  }

  await removeStoredBackgroundFiles();
  const filename = `${BACKGROUND_BASENAME}.${backgroundExt}`;
  const destination = getBackgroundPath(backgroundExt);
  await fs.writeFile(destination, req.file.buffer);

  const project = await loadProject();
  project.background = true;
  project.backgroundExt = backgroundExt;
  project.backgroundUpdatedAt = new Date().toISOString();
  await addLog("background_upload", { filename });
  await saveProject(project);
  res.json(project);
});

app.post("/api/export", requireAuth, async (req, res) => {
  const project = await loadProject();
  const exportProject = {
    ...project,
    ...(req.body || {}),
    background: req.body?.background !== undefined ? req.body.background : project.background,
    microphones:
      req.body?.microphones !== undefined
        ? sanitizeMicrophonesForStorage(req.body.microphones)
        : sanitizeMicrophonesForStorage(project.microphones),
    showLabels: req.body?.showLabels !== undefined ? req.body.showLabels : project.showLabels,
    micSize: req.body?.micSize !== undefined ? req.body.micSize : project.micSize,
    fontSettings: req.body?.fontSettings !== undefined ? req.body.fontSettings : project.fontSettings
  };

  res.attachment("project.zip");
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => {
    res.status(500).json({ error: err.message });
  });
  archive.pipe(res);
  archive.append(JSON.stringify(exportProject, null, 2), { name: "project.json" });
  if (project.background && project.backgroundExt) {
    const backgroundPath = getBackgroundPath(project.backgroundExt);
    if (await fs.pathExists(backgroundPath)) {
      archive.file(backgroundPath, { name: `assets/${BACKGROUND_BASENAME}.${project.backgroundExt}` });
    }
  }
  await archive.finalize();
});

app.post("/api/import", requireAuth, importUpload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const zip = new AdmZip(req.file.buffer);
  await fs.ensureDir(assetsDir);
  await fs.emptyDir(assetsDir);
  await removeStoredBackgroundFiles();

  let project = { ...defaultProject };
  const entriesByName = new Map(zip.getEntries().map((entry) => [entry.entryName, entry]));

  const projectEntry = entriesByName.get("project.json");
  if (projectEntry) {
    project = JSON.parse(projectEntry.getData().toString("utf8"));
  }

  if (typeof project.showLabels !== "boolean") {
    project.showLabels = defaultProject.showLabels;
  }
  if (typeof project.micSize !== "number") {
    project.micSize = defaultProject.micSize;
  }
  project.microphones = sanitizeMicrophonesForStorage(project.microphones);
  reconcileRuntimeMicStates(project.microphones);
  project.fontSettings = {
    ...defaultProject.fontSettings,
    ...(project.fontSettings || {})
  };

  let importedBackgroundExt = null;
  let importedBackgroundEntry = null;

  if (project.background && project.backgroundExt) {
    const ext = getBackgroundExtensionFromName(project.backgroundExt);
    if (ext) {
      importedBackgroundExt = ext;
      importedBackgroundEntry = entriesByName.get(`assets/${BACKGROUND_BASENAME}.${ext}`) || null;
    }
  }

  if (!importedBackgroundEntry && project.background?.filename) {
    const legacyExt = getBackgroundExtensionFromName(project.background.filename);
    const legacyEntry = legacyExt ? entriesByName.get(`assets/${project.background.filename}`) : null;
    if (legacyExt && legacyEntry) {
      importedBackgroundExt = legacyExt;
      importedBackgroundEntry = legacyEntry;
    }
  }

  if (importedBackgroundExt && importedBackgroundEntry && !importedBackgroundEntry.isDirectory) {
    await fs.writeFile(getBackgroundPath(importedBackgroundExt), importedBackgroundEntry.getData());
    project.background = true;
    project.backgroundExt = importedBackgroundExt;
    project.backgroundUpdatedAt = new Date().toISOString();
  } else {
    project.background = false;
    project.backgroundExt = null;
    project.backgroundUpdatedAt = null;
  }

  await addLog("import", { assetCount: (await fs.readdir(assetsDir)).length });
  await saveProject(project);
  res.json(project);
});

app.get("/api/about", requireAuth, async (_req, res) => {
  const appMeta = await getAppMetadata();
  res.json({
    appName: appMeta.name,
    appVersion: appMeta.version,
    nodeVersion: process.version,
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    hostname: os.hostname() || null
  });
});

if (process.env.NODE_ENV === "production") {
  const clientDist = path.join(__dirname, "..", "client", "dist");
  app.use((req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/assets") || req.path === "/login") {
      next();
      return;
    }

    const session = getSessionFromRequest(req);
    if (!session) {
      res.redirect("/login");
      return;
    }

    next();
  });
  app.use(express.static(clientDist));
  app.get("*", (req, res) => {
    const session = getSessionFromRequest(req);
    if (!session && req.path !== "/login") {
      res.redirect("/login");
      return;
    }
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Synoptic server running on port ${PORT}`);
});
