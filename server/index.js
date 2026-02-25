import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs-extra";
import multer from "multer";
import archiver from "archiver";
import AdmZip from "adm-zip";
import crypto from "node:crypto";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "url";
import { ConferenceManager } from "./conference/manager.js";
import { DEFAULT_CONFERENCE_SETTINGS, MIC_STATE } from "./conference/constants.js";
import { hasDriverType, listDriverTypes } from "./conference/registry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const TCP_INTEGRATION_PORT = 31415;
const dataDir = path.join(__dirname, "data");
const assetsDir = path.join(dataDir, "assets");
const logsDir = path.join(dataDir, "logs");
const rootPackagePath = path.join(__dirname, "..", "package.json");
const serverPackagePath = path.join(__dirname, "package.json");
const projectPath = path.join(dataDir, "project.json");
const authPath = path.join(dataDir, "auth.json");
const appLogPath = path.join(logsDir, "app.log");
const conferenceSettingsPath = path.join(dataDir, "conference-settings.json");
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
  micButtonStyleCss: "",
  fontSettings: {
    micTextFamily: "system-ui",
    micTextWeight: "bold",
    labelFamily: "system-ui",
    labelWeight: "normal"
  }
};

const microphoneRuntimeStates = new Map();
const sessionStore = new Map();
let appMetadataPromise = null;
const tcpClients = new Set();
const micPendingStates = new Map();

const sendTcpLine = (socket, message) => {
  if (!socket || socket.destroyed) {
    return;
  }
  socket.write(`${message}\n\r`);
};

const broadcastTcpLine = (message) => {
  for (const socket of tcpClients) {
    sendTcpLine(socket, message);
  }
};

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
  if (!(await fs.pathExists(conferenceSettingsPath))) {
    await fs.writeJson(conferenceSettingsPath, DEFAULT_CONFERENCE_SETTINGS, { spaces: 2 });
  }
};

const readAuthConfig = async () => {
  await ensureData();
  return fs.readJson(authPath);
};

const saveAuthConfig = async (authConfig) => {
  await fs.writeJson(authPath, authConfig, { spaces: 2 });
};


const normalizeConferenceSettings = (settings = {}) => ({
  enabled: Boolean(settings.enabled),
  type: typeof settings.type === "string" ? settings.type : DEFAULT_CONFERENCE_SETTINGS.type,
  deviceIp: typeof settings.deviceIp === "string" ? settings.deviceIp.trim() : "",
  bindIp: typeof settings.bindIp === "string" ? settings.bindIp.trim() : "",
  options: {
    ...DEFAULT_CONFERENCE_SETTINGS.options,
    ...(settings.options || {})
  }
});

const readConferenceSettings = async () => {
  await ensureData();
  const settings = await fs.readJson(conferenceSettingsPath);
  return normalizeConferenceSettings(settings);
};

const saveConferenceSettings = async (settings) => {
  await fs.writeJson(conferenceSettingsPath, normalizeConferenceSettings(settings), { spaces: 2 });
};

const isValidIpv4 = (value) => {
  if (typeof value !== "string") {
    return false;
  }
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
};

const validateConferenceSettings = (settings) => {
  if (!hasDriverType(settings.type)) {
    return `Unsupported conference type: ${settings.type}. Available: ${listDriverTypes().join(", ")}`;
  }
  if (!isValidIpv4(settings.deviceIp)) {
    return "Invalid conference deviceIp";
  }
  if (settings.type === "dcs150" && !isValidIpv4(settings.bindIp)) {
    return "Invalid conference bindIp for dcs150";
  }
  return null;
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

const normalizeRuntimeMicState = (state) =>
  state === MIC_STATE.ON ? MIC_STATE.ON : state === MIC_STATE.UNKNOWN ? MIC_STATE.UNKNOWN : MIC_STATE.OFF;

const withRuntimeMicStates = (project) => {
  const microphones = Array.isArray(project.microphones)
    ? project.microphones.map((mic) => ({
        ...mic,
        state: normalizeRuntimeMicState(microphoneRuntimeStates.get(mic.micId)),
        pending: micPendingStates.get(mic.micId) || false
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
    if (!Number.isInteger(mic?.micId)) {
      continue;
    }
    incomingIds.add(mic.micId);
    if (!microphoneRuntimeStates.has(mic.micId)) {
      microphoneRuntimeStates.set(mic.micId, MIC_STATE.OFF);
    }
  }

  for (const micId of microphoneRuntimeStates.keys()) {
    if (!incomingIds.has(micId)) {
      microphoneRuntimeStates.delete(micId);
      micPendingStates.delete(micId);
    }
  }
};

const emitMicEvent = (micId, state) => {
  if (!Number.isInteger(micId) || !state) {
    return;
  }
  broadcastTcpLine(`EVENT MIC ${micId} ${state}`);
};

const parseMicId = (micId) => {
  const parsed = Number(micId);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
};

const setMicrophoneStateById = async (micId, requestedState, source) => {
  const normalizedMicId = parseMicId(micId);
  if (!normalizedMicId) {
    return { status: "BAD_REQUEST" };
  }

  const project = await loadProject();
  const micExists = Array.isArray(project.microphones) && project.microphones.some((mic) => mic.micId === normalizedMicId);
  if (!micExists) {
    emitMicEvent(normalizedMicId, "NOT_FOUND");
    return { status: "NOT_FOUND", id: normalizedMicId };
  }

  const state = requestedState === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF;
  micPendingStates.set(normalizedMicId, true);

  try {
    await conferenceManager.setMicState(normalizedMicId, state);
  } catch (error) {
    micPendingStates.set(normalizedMicId, false);
    microphoneRuntimeStates.set(normalizedMicId, MIC_STATE.UNKNOWN);
    emitMicEvent(normalizedMicId, MIC_STATE.UNKNOWN);
    await addLog("mic_state_failed", { id: normalizedMicId, state, source, error: error.message });
    return { status: "ERROR", id: normalizedMicId, error: error.message };
  }

  microphoneRuntimeStates.set(normalizedMicId, state);
  micPendingStates.set(normalizedMicId, false);
  await addLog("mic_state", { id: normalizedMicId, state, source });
  emitMicEvent(normalizedMicId, state);
  return { status: "OK", id: normalizedMicId, state };
};

const toggleMicrophoneById = async (micId, source) => {
  const normalizedMicId = parseMicId(micId);
  if (!normalizedMicId) {
    return { status: "BAD_REQUEST" };
  }
  const currentState = normalizeRuntimeMicState(microphoneRuntimeStates.get(normalizedMicId));
  const nextState = currentState === MIC_STATE.ON ? MIC_STATE.OFF : MIC_STATE.ON;
  return setMicrophoneStateById(normalizedMicId, nextState, source);
};

const sanitizeMicrophonesForStorage = (microphones) =>
  (microphones || [])
    .map((mic) => {
      const normalizedMicId = parseMicId(mic.micId);
      if (!normalizedMicId) {
        return null;
      }

      return {
        id: typeof mic.id === "string" && mic.id ? mic.id : crypto.randomUUID(),
        micId: normalizedMicId,
        micText:
          typeof mic.micText === "string"
            ? mic.micText
            : typeof mic.seatText === "string"
              ? mic.seatText
              : String(normalizedMicId),
        label: typeof mic.label === "string" ? mic.label : "",
        x: Number.isFinite(Number(mic.x)) ? Number(mic.x) : 0.5,
        y: Number.isFinite(Number(mic.y)) ? Number(mic.y) : 0.5,
        sizeScale: Number.isFinite(Number(mic.sizeScale)) ? Number(mic.sizeScale) : 1,
        buttonStyleCss: typeof mic.buttonStyleCss === "string" ? mic.buttonStyleCss : ""
      };
    })
    .filter(Boolean);

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

const conferenceManager = new ConferenceManager({
  onMicStateChange: async ({ micId, state }) => {
    if (!Number.isInteger(micId)) {
      return;
    }
    microphoneRuntimeStates.set(micId, normalizeRuntimeMicState(state));
    micPendingStates.set(micId, false);
    emitMicEvent(micId, normalizeRuntimeMicState(state));
    await addLog("mic_feedback", { id: micId, state });
  },
  onHealth: async (health) => {
    await addLog("conference_health", health);
  }
});

conferenceManager.on("error", async (event) => {
  await addLog("conference_error", event);
});

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

app.get("/api/conference/settings", requireAuth, async (_req, res) => {
  const settings = await readConferenceSettings();
  res.json(settings);
});

app.post("/api/conference/settings", requireAuth, async (req, res) => {
  const nextSettings = normalizeConferenceSettings(req.body || {});
  const validationError = validateConferenceSettings(nextSettings);
  if (validationError) {
    res.status(400).json({ error: validationError });
    return;
  }

  const previousSettings = await readConferenceSettings();

  try {
    await conferenceManager.switchConfig(nextSettings);
    await saveConferenceSettings(nextSettings);
  } catch (error) {
    try {
      await conferenceManager.switchConfig(previousSettings);
    } catch {
      // ignore rollback errors
    }
    res.status(400).json({ error: error.message });
    return;
  }

  await addLog("conference_settings", nextSettings);
  res.json(nextSettings);
});

app.get("/api/conference/status", requireAuth, async (_req, res) => {
  res.json(conferenceManager.getStatus());
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
  const { showLabels, micSize, fontSettings, micButtonStyleCss } = req.body || {};
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
  if (micButtonStyleCss !== undefined) {
    project.micButtonStyleCss = typeof micButtonStyleCss === "string" ? micButtonStyleCss : "";
  }
  await addLog("save", { microphoneCount: project.microphones.length });
  await saveProject(project);
  res.json(withRuntimeMicStates(project));
});

const sendMicActionResult = (res, result) => {
  if (result.status === "BAD_REQUEST") {
    res.status(400).json({ error: "Invalid microphone id" });
    return;
  }

  if (result.status === "NOT_FOUND") {
    res.status(404).json({ error: "Microphone not found" });
    return;
  }

  if (result.status === "ERROR") {
    res.status(502).json({ error: result.error || "Conference driver command failed" });
    return;
  }

  res.json({ id: result.id, state: result.state });
};

app.post("/api/microphones/:id/on", requireAuth, async (req, res) => {
  const result = await setMicrophoneStateById(req.params.id, MIC_STATE.ON, "run_click");
  sendMicActionResult(res, result);
});

app.post("/api/microphones/:id/off", requireAuth, async (req, res) => {
  const result = await setMicrophoneStateById(req.params.id, MIC_STATE.OFF, "run_click");
  sendMicActionResult(res, result);
});

app.post("/api/microphones/:id/toggle", requireAuth, async (req, res) => {
  const result = await toggleMicrophoneById(req.params.id, "run_click");
  sendMicActionResult(res, result);
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
    micButtonStyleCss:
      req.body?.micButtonStyleCss !== undefined ? req.body.micButtonStyleCss : project.micButtonStyleCss,
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
  project.micButtonStyleCss = typeof project.micButtonStyleCss === "string" ? project.micButtonStyleCss : "";

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

const tcpServer = net.createServer((socket) => {
  socket.setEncoding("ascii");
  tcpClients.add(socket);

  getAppMetadata()
    .then((appMeta) => {
      sendTcpLine(socket, `RMS SYNOPTIC/${appMeta.version}`);
    })
    .catch(() => {
      sendTcpLine(socket, "RMS SYNOPTIC/unknown");
    });

  let buffer = "";

  socket.on("data", async (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      const match = line.match(/^SET MIC (\S+) (ON|OFF|TOGGLE)$/);
      if (!match) {
        continue;
      }

      const micId = match[1];
      const action = match[2];
      try {
        if (action === "ON") {
          await setMicrophoneStateById(micId, MIC_STATE.ON, "tcp_client");
        } else if (action === "OFF") {
          await setMicrophoneStateById(micId, MIC_STATE.OFF, "tcp_client");
        } else {
          await toggleMicrophoneById(micId, "tcp_client");
        }
      } catch (error) {
        console.error("TCP command handling error", error);
      }
    }
  });

  const handleDisconnect = () => {
    tcpClients.delete(socket);
  };

  socket.on("close", handleDisconnect);
  socket.on("end", handleDisconnect);
  socket.on("error", (error) => {
    tcpClients.delete(socket);
    console.error("TCP client socket error", error);
  });
});

tcpServer.on("error", (error) => {
  console.error("TCP integration server error", error);
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

const bootstrapConference = async () => {
  await ensureData();
  const settings = await readConferenceSettings();
  if (!settings.enabled) {
    await conferenceManager.switchConfig(settings);
    return;
  }

  const validationError = validateConferenceSettings(settings);
  if (validationError) {
    await addLog("conference_settings_invalid", { error: validationError, settings });
    await conferenceManager.switchConfig({ ...settings, enabled: false });
    return;
  }

  try {
    await conferenceManager.switchConfig(settings);
  } catch (error) {
    await addLog("conference_start_failed", { error: error.message, settings });
    await conferenceManager.switchConfig({ ...settings, enabled: false });
  }
};

await bootstrapConference();

app.listen(PORT, () => {
  console.log(`Synoptic server running on port ${PORT}`);
});

tcpServer.listen(TCP_INTEGRATION_PORT, () => {
  console.log(`TCP integration server running on port ${TCP_INTEGRATION_PORT}`);
});
