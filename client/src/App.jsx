import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Circle, Group, Text, Rect } from "react-konva";
import useImage from "use-image";
import { languageOptions, translate } from "./i18n";

const DEFAULT_PROJECT = {
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

const FONT_OPTIONS = [
  { value: "system-ui", label: "System default" },
  { value: "Arial", label: "Arial" },
  { value: "Roboto", label: "Roboto" },
  { value: "monospace", label: "Monospace" }
];

const MIC_STATE = {
  ON: "ON",
  OFF: "OFF"
};

const formatTimestamp = (value) => new Date(value).toLocaleString();

const logLabel = (entry) => {
  switch (entry.type) {
    case "add_mic":
      return "Added microphone";
    case "delete_mic":
      return "Deleted microphone";
    case "save":
      return "Saved project";
    case "export":
      return "Exported project";
    case "import":
      return "Imported project";
    case "background_upload":
      return "Uploaded background";
    default:
      return entry.type;
  }
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const MIN_MIC_SIZE = 20;
const MAX_MIC_SIZE = 64;
const MIC_SIZE_STEP = 4;

const getNextSeatNumber = (microphones) => {
  if (!Array.isArray(microphones) || microphones.length === 0) {
    return 1;
  }
  const maxSeat = microphones.reduce((max, mic) => {
    if (typeof mic.seatNumber === "number") {
      return Math.max(max, mic.seatNumber);
    }
    return max;
  }, 0);
  return maxSeat + 1;
};

const normalizeProject = (data) => {
  const microphones = Array.isArray(data.microphones) ? data.microphones : [];
  let nextSeatNumber = getNextSeatNumber(microphones);
  const normalizedMics = microphones.map((mic) => {
    const seatNumber = typeof mic.seatNumber === "number" ? mic.seatNumber : nextSeatNumber;
    if (typeof mic.seatNumber !== "number") {
      nextSeatNumber += 1;
    }
    return {
      ...mic,
      seatNumber,
      seatText: typeof mic.seatText === "string" ? mic.seatText : `${seatNumber}`,
      label: typeof mic.label === "string" ? mic.label : "",
      state: mic.state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF
    };
  });
  return {
    ...DEFAULT_PROJECT,
    ...data,
    background: Boolean(data.background),
    backgroundExt: typeof data.backgroundExt === "string" ? data.backgroundExt : null,
    backgroundUpdatedAt: typeof data.backgroundUpdatedAt === "string" ? data.backgroundUpdatedAt : null,
    microphones: normalizedMics,
    showLabels: typeof data.showLabels === "boolean" ? data.showLabels : DEFAULT_PROJECT.showLabels,
    micSize:
      typeof data.micSize === "number" ? clamp(data.micSize, MIN_MIC_SIZE, MAX_MIC_SIZE) : DEFAULT_PROJECT.micSize,
    fontSettings: {
      ...DEFAULT_PROJECT.fontSettings,
      ...(data.fontSettings || {})
    }
  };
};

const App = ({ onLogout = () => {}, username = "admin", language = "en", onLanguageChange = () => {} }) => {
  const [mode, setMode] = useState("edit");
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [dirty, setDirty] = useState(false);
  const [toastMessage, setToastMessage] = useState("");
  const [stageSize, setStageSize] = useState({ width: 900, height: 520 });
  const containerRef = useRef(null);
  const previousModeRef = useRef("edit");
  const backgroundUrl =
    project.background && project.backgroundExt
      ? `/api/background/file?v=${encodeURIComponent(project.backgroundUpdatedAt || "current")}`
      : "";
  const [bgImage] = useImage(backgroundUrl);
  const [selectedMicId, setSelectedMicId] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAbout, setShowAbout] = useState(false);
  const [aboutInfo, setAboutInfo] = useState(null);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordStatus, setPasswordStatus] = useState("");

  const microphones = project.microphones ?? [];
  const t = (key, params) => translate(language, key, params);

  const stageDimensions = useMemo(() => {
    if (!containerRef.current) {
      return stageSize;
    }
    return stageSize;
  }, [stageSize]);

  const fetchProject = async () => {
    const response = await fetch("/api/project");
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    setProject(normalizeProject(data));
    setDirty(false);
  };

  const showToast = (message) => {
    setToastMessage(message);
    window.setTimeout(() => {
      setToastMessage((current) => (current === message ? "" : current));
    }, 3500);
  };

  const logAction = async (type, details) => {
    const response = await fetch("/api/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, details })
    });
    if (!response.ok) {
      return;
    }
    const logs = await response.json();
    setLogs(Array.isArray(logs) ? logs : []);
  };

  const fetchLogs = async (limit = 200) => {
    const response = await fetch(`/api/logs?limit=${encodeURIComponent(limit)}`);
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    setLogs(Array.isArray(data) ? data : []);
  };

  const fetchAbout = async () => {
    const response = await fetch("/api/about");
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    setAboutInfo(data || null);
  };

  useEffect(() => {
    fetchProject();
    fetchLogs();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      setStageSize({
        width: Math.max(320, Math.floor(width)),
        height: Math.max(240, Math.floor(height))
      });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!showLogs) {
      return;
    }

    fetchLogs();

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setShowLogs(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showLogs]);

  useEffect(() => {
    if (!showSettings) {
      return;
    }

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setShowSettings(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showSettings]);

  useEffect(() => {
    if (!showAbout) {
      return;
    }

    fetchAbout();

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setShowAbout(false);
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [showAbout]);

  const handleBackgroundUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/background", {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const importedProject = normalizeProject(data);
    setProject(importedProject);
    setDirty(true);
    const autosaved = await handleSave(importedProject);
    if (!autosaved) {
      console.error("Autosave failed after background upload");
      showToast("Autosave failed after background upload.");
    }
    event.target.value = "";
  };

  const handleAddMic = () => {
    const newMic = {
      id: crypto.randomUUID(),
      x: 0.5,
      y: 0.5,
      seatNumber: getNextSeatNumber(microphones),
      state: MIC_STATE.OFF
    };
    newMic.seatText = `${newMic.seatNumber}`;
    newMic.label = "";
    setProject((prev) => ({
      ...prev,
      microphones: [...prev.microphones, newMic]
    }));
    setDirty(true);
    logAction("add_mic", { id: newMic.id });
    setSelectedMicId(newMic.id);
  };

  const handleSave = async (projectToSave = project) => {
    try {
      const response = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          background: projectToSave.background,
          microphones: projectToSave.microphones,
          showLabels: projectToSave.showLabels,
          micSize: projectToSave.micSize,
          fontSettings: projectToSave.fontSettings
        })
      });
      if (!response.ok) {
        console.error("Save request failed with status", response.status);
        return false;
      }
      const data = await response.json();
      setProject(normalizeProject(data));
      setDirty(false);
      return true;
    } catch (error) {
      console.error("Save request failed", error);
      return false;
    }
  };

  const handleExport = async () => {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: project.background,
        microphones: project.microphones,
        showLabels: project.showLabels,
        micSize: project.micSize,
        fontSettings: project.fontSettings
      })
    });
    if (!response.ok) {
      return;
    }
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "project.zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    const response = await fetch("/api/import", {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    const importedProject = normalizeProject(data);
    setProject(importedProject);
    setDirty(true);
    const autosaved = await handleSave(importedProject);
    if (!autosaved) {
      console.error("Autosave failed after import");
      showToast("Autosave failed after import.");
    }
    event.target.value = "";
  };

  const handleDragEnd = (event, mic) => {
    const { width, height } = stageDimensions;
    const nextX = clamp(event.target.x() / width, 0, 1);
    const nextY = clamp(event.target.y() / height, 0, 1);

    setProject((prev) => ({
      ...prev,
      microphones: prev.microphones.map((item) =>
        item.id === mic.id ? { ...item, x: nextX, y: nextY } : item
      )
    }));
    setDirty(true);
  };

  const handleMicClick = async (micId) => {
    if (mode !== "edit") {
      const response = await fetch(`/api/microphones/${micId}/toggle`, { method: "POST" });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setProject((prev) => ({
        ...prev,
        microphones: prev.microphones.map((item) => (item.id === data.id ? { ...item, state: data.state } : item))
      }));
      return;
    }

    setSelectedMicId(micId);
  };

  const handleDeleteMic = () => {
    if (mode !== "edit") {
      return;
    }
    const mic = microphones.find((item) => item.id === selectedMicId);
    if (!mic) {
      return;
    }
    const confirmed = window.confirm(`Delete microphone ${mic.seatNumber}?`);
    if (!confirmed) {
      return;
    }
    setProject((prev) => ({
      ...prev,
      microphones: prev.microphones.filter((item) => item.id !== mic.id)
    }));
    setDirty(true);
    logAction("delete_mic", { id: mic.id, seatNumber: mic.seatNumber });
    setSelectedMicId(null);
  };

  const handleSelectedMicChange = (field, value) => {
    if (!selectedMicId) {
      return;
    }
    setProject((prev) => ({
      ...prev,
      microphones: prev.microphones.map((item) => (item.id === selectedMicId ? { ...item, [field]: value } : item))
    }));
    setDirty(true);
  };


  const handleFontSettingChange = (field, value) => {
    setProject((prev) => ({
      ...prev,
      fontSettings: {
        ...prev.fontSettings,
        [field]: value
      }
    }));
    setDirty(true);
  };

  const handleChangePassword = async (event) => {
    event.preventDefault();
    setPasswordStatus("");

    if (!newPassword) {
      setPasswordStatus("New password cannot be empty.");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordStatus("New password and confirmation do not match.");
      return;
    }

    const response = await fetch("/api/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPassword, newPassword })
    });

    if (!response.ok) {
      setPasswordStatus("Password update failed. Check old password.");
      return;
    }

    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordStatus("Password updated.");
  };

  useEffect(() => {
    const previousMode = previousModeRef.current;
    previousModeRef.current = mode;
    if (previousMode !== "edit" || mode !== "run" || !dirty) {
      return;
    }

    const autosave = async () => {
      const autosaved = await handleSave();
      if (!autosaved) {
        console.error("Autosave failed while exiting edit mode");
        showToast("Autosave failed while switching to Run mode.");
      }
    };

    autosave();
  }, [mode, dirty]);

  useEffect(() => {
    if (mode === "run") {
      setSelectedMicId(null);
    }
  }, [mode]);

  const selectedMic = microphones.find((mic) => mic.id === selectedMicId) ?? null;
  const showPropertiesOverlay = mode === "edit" && Boolean(selectedMic);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar__group">
          <span className={`mode-badge mode-badge--${mode}`}>{mode === "edit" ? t("mode.edit") : t("mode.run")}</span>
          <button
            type="button"
            className="button"
            onClick={() => setMode((prev) => (prev === "edit" ? "run" : "edit"))}
          >
            {t("mode.toggle")}
          </button>
          <span className="dirty-indicator">{dirty ? t("status.unsaved") : t("status.saved")}</span>
        </div>
        <div className="toolbar__group">
          <span className="dirty-indicator">{t("user.label", { username })}</span>
          <button type="button" className="button button--secondary" onClick={() => setShowLogs(true)}>
            {t("toolbar.logs")}
          </button>
          <button type="button" className="button button--secondary" onClick={() => setShowSettings(true)}>
            {t("toolbar.settings")}
          </button>
          <button type="button" className="button button--secondary" onClick={() => setShowAbout(true)}>
            {t("toolbar.about")}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setProject((prev) => ({ ...prev, showLabels: !prev.showLabels }));
              setDirty(true);
            }}
          >
            {t("toolbar.labels", { state: project.showLabels ? t("common.on") : t("common.off") })}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setProject((prev) => ({
                ...prev,
                micSize: clamp(prev.micSize - MIC_SIZE_STEP, MIN_MIC_SIZE, MAX_MIC_SIZE)
              }));
              setDirty(true);
            }}
          >
            -
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setProject((prev) => ({
                ...prev,
                micSize: clamp(prev.micSize + MIC_SIZE_STEP, MIN_MIC_SIZE, MAX_MIC_SIZE)
              }));
              setDirty(true);
            }}
          >
            +
          </button>
          <button type="button" className="button button--secondary" onClick={onLogout}>
            {t("toolbar.logout")}
          </button>
        </div>
        <div className="toolbar__group">
          <label className="button button--secondary">
            {t("toolbar.uploadBackground")}
            <input type="file" accept="image/png, image/jpeg" onChange={handleBackgroundUpload} hidden />
          </label>
          <button type="button" className="button" onClick={handleAddMic} disabled={mode !== "edit"}>
            {t("toolbar.addMicrophone")}
          </button>
          <button type="button" className="button" onClick={handleExport}>
            {t("toolbar.exportZip")}
          </button>
          <label className="button button--secondary">
            {t("toolbar.importZip")}
            <input type="file" accept=".zip" onChange={handleImport} hidden />
          </label>
        </div>
      </header>
      <main className="layout">
        <section className="canvas-panel">
          <div className="canvas-container" ref={containerRef}>
            <Stage width={stageDimensions.width} height={stageDimensions.height}>
              <Layer>
                {bgImage ? (
                  <KonvaImage image={bgImage} width={stageDimensions.width} height={stageDimensions.height} />
                ) : (
                  <Rect
                    width={stageDimensions.width}
                    height={stageDimensions.height}
                    fill="#f4f5f7"
                    stroke="#d7dbe0"
                    dash={[6, 4]}
                  />
                )}
                {microphones.map((mic, index) => {
                  const absoluteX = mic.x * stageDimensions.width;
                  const absoluteY = mic.y * stageDimensions.height;
                  const micRadius = project.micSize / 2;
                  const isSelected = mode === "edit" && mic.id === selectedMicId;
                  return (
                    <Group
                      key={mic.id}
                      x={absoluteX}
                      y={absoluteY}
                      draggable={mode === "edit"}
                      onDragEnd={(event) => handleDragEnd(event, mic)}
                      onClick={() => handleMicClick(mic.id)}
                      onTap={() => handleMicClick(mic.id)}
                    >
                      <Circle
                        radius={micRadius}
                        fill={
                          mode === "edit" ? "#4c6ef5" : mic.state === MIC_STATE.ON ? "#2f9e44" : "#868e96"
                        }
                        stroke={isSelected ? "#f59f00" : undefined}
                        strokeWidth={isSelected ? 3 : 0}
                      />
                      <Text
                        text={mic.seatText || `${mic.seatNumber ?? index + 1}`}
                        x={-micRadius}
                        y={-micRadius}
                        width={project.micSize}
                        height={project.micSize}
                        align="center"
                        verticalAlign="middle"
                        fontSize={Math.max(12, Math.round(project.micSize * 0.6))}
                        fontFamily={project.fontSettings.seatTextFamily}
                        fontStyle={project.fontSettings.seatTextWeight}
                        fill="#ffffff"
                      />
                      {project.showLabels && mic.label && (
                        <Text
                          text={mic.label}
                          x={-60}
                          y={micRadius + 8}
                          width={120}
                          align="center"
                          fontSize={12}
                          fontFamily={project.fontSettings.labelFamily}
                          fontStyle={project.fontSettings.labelWeight}
                          fill="#1f2933"
                        />
                      )}
                    </Group>
                  );
                })}
              </Layer>
            </Stage>
            {!project.background && <div className="canvas-placeholder">{t("canvas.uploadPrompt")}</div>}
          </div>
          {showPropertiesOverlay && (
            <aside className="properties-panel properties-panel--overlay">
              <h2>Properties</h2>
              <div className="properties-panel__body">
                <div className="property-row">
                  <span className="property-label">Seat number</span>
                  <span className="property-value">{selectedMic.seatNumber}</span>
                </div>
                <label className="property-field">
                  <span className="property-label">Seat text</span>
                  <input
                    className="input"
                    type="text"
                    value={selectedMic.seatText ?? ""}
                    onChange={(event) => handleSelectedMicChange("seatText", event.target.value)}
                    placeholder="e.g. 1, CHAIRMAN"
                  />
                </label>
                <label className="property-field">
                  <span className="property-label">Label</span>
                  <input
                    className="input"
                    type="text"
                    value={selectedMic.label ?? ""}
                    onChange={(event) => handleSelectedMicChange("label", event.target.value)}
                    placeholder="Shown when Labels are On"
                  />
                </label>
                <button type="button" className="button button--danger" onClick={handleDeleteMic}>
                  Delete microphone
                </button>
              </div>
            </aside>
          )}
        </section>
      </main>
      {showLogs && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowLogs(false)}>
          <div
            className="log-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Activity log"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{t("log.title")}</h2>
            <ul>
              {logs.length === 0 && <li className="log-empty">{t("log.empty")}</li>}
              {logs.map((entry) => (
                <li key={entry.id}>
                  <span className="log-title">{logLabel(entry)}</span>
                  <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
                </li>
              ))}
            </ul>
            <div className="log-modal__actions">
              <button type="button" className="button button--secondary" onClick={() => setShowLogs(false)}>
                {t("settings.close")}
              </button>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowSettings(false)}>
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Font settings"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{t("settings.title")}</h2>
            <div className="settings-grid">
              <label className="property-field">
                <span className="property-label">{t("settings.language")}</span>
                <select className="input" value={language} onChange={(event) => onLanguageChange(event.target.value)}>
                  {languageOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="property-field">
                <span className="property-label">Mic seat text font</span>
                <select
                  className="input"
                  value={project.fontSettings.seatTextFamily}
                  onChange={(event) => handleFontSettingChange("seatTextFamily", event.target.value)}
                >
                  {FONT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="property-field">
                <span className="property-label">Mic seat text weight</span>
                <select
                  className="input"
                  value={project.fontSettings.seatTextWeight}
                  onChange={(event) => handleFontSettingChange("seatTextWeight", event.target.value)}
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                </select>
              </label>
              <label className="property-field">
                <span className="property-label">Mic label font</span>
                <select
                  className="input"
                  value={project.fontSettings.labelFamily}
                  onChange={(event) => handleFontSettingChange("labelFamily", event.target.value)}
                >
                  {FONT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="property-field">
                <span className="property-label">Mic label weight</span>
                <select
                  className="input"
                  value={project.fontSettings.labelWeight}
                  onChange={(event) => handleFontSettingChange("labelWeight", event.target.value)}
                >
                  <option value="normal">Normal</option>
                  <option value="bold">Bold</option>
                </select>
              </label>
            </div>
            <form className="password-form" onSubmit={handleChangePassword}>
              <h3>Change password</h3>
              <label className="property-field">
                <span className="property-label">Old password</span>
                <input
                  className="input"
                  type="password"
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                />
              </label>
              <label className="property-field">
                <span className="property-label">New password</span>
                <input
                  className="input"
                  type="password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label className="property-field">
                <span className="property-label">Confirm new password</span>
                <input
                  className="input"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              {passwordStatus && <p className="log-empty">{passwordStatus}</p>}
              <div className="log-modal__actions">
                <button type="submit" className="button">
                  Update password
                </button>
              </div>
            </form>
            <div className="log-modal__actions">
              <button type="button" className="button button--secondary" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {showAbout && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowAbout(false)}>
          <div
            className="about-modal"
            role="dialog"
            aria-modal="true"
            aria-label="About"
            onClick={(event) => event.stopPropagation()}
          >
            <h2>About</h2>
            <div className="about-grid">
              <div className="about-row">
                <span className="property-label">App</span>
                <span className="property-value">{aboutInfo?.appName || "—"}</span>
              </div>
              <div className="about-row">
                <span className="property-label">Version</span>
                <span className="property-value">{aboutInfo?.appVersion || "—"}</span>
              </div>
              <div className="about-row">
                <span className="property-label">Node.js</span>
                <span className="property-value">{aboutInfo?.nodeVersion || "—"}</span>
              </div>
              <div className="about-row">
                <span className="property-label">Platform</span>
                <span className="property-value">{aboutInfo?.platform || "—"}</span>
              </div>
              <div className="about-row">
                <span className="property-label">Release</span>
                <span className="property-value">{aboutInfo?.release || "—"}</span>
              </div>
              <div className="about-row">
                <span className="property-label">Architecture</span>
                <span className="property-value">{aboutInfo?.arch || "—"}</span>
              </div>
              {aboutInfo?.hostname && (
                <div className="about-row">
                  <span className="property-label">Hostname</span>
                  <span className="property-value">{aboutInfo.hostname}</span>
                </div>
              )}
            </div>
            <div className="log-modal__actions">
              <button type="button" className="button button--secondary" onClick={() => setShowAbout(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
      {toastMessage && <div className="toast toast--error">{toastMessage}</div>}
    </div>
  );
};

export default App;
