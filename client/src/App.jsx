import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Circle, Group, Text, Rect } from "react-konva";
import useImage from "use-image";

const DEFAULT_PROJECT = {
  background: null,
  microphones: [],
  logs: [],
  showLabels: true,
  micSize: 32
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
    if (typeof mic.seatNumber === "number") {
      return mic;
    }
    const updated = { ...mic, seatNumber: nextSeatNumber };
    nextSeatNumber += 1;
    return updated;
  });
  return {
    ...DEFAULT_PROJECT,
    ...data,
    microphones: normalizedMics,
    showLabels: typeof data.showLabels === "boolean" ? data.showLabels : DEFAULT_PROJECT.showLabels,
    micSize:
      typeof data.micSize === "number" ? clamp(data.micSize, MIN_MIC_SIZE, MAX_MIC_SIZE) : DEFAULT_PROJECT.micSize
  };
};

const App = () => {
  const [mode, setMode] = useState("edit");
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [stageSize, setStageSize] = useState({ width: 900, height: 520 });
  const containerRef = useRef(null);
  const [bgImage] = useImage(project.background?.url || "");
  const [selectedMicId, setSelectedMicId] = useState(null);
  const [showLogs, setShowLogs] = useState(false);

  const microphones = project.microphones ?? [];

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
    setProject((prev) => ({ ...prev, logs }));
  };

  useEffect(() => {
    fetchProject();
  }, []);

  useEffect(() => {
    if (mode === "run") {
      setSelectedMicId(null);
    }
  }, [mode]);

  useEffect(() => {
    if (!showLogs) {
      return;
    }
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setShowLogs(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showLogs]);

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
    setProject(normalizeProject(data));
    event.target.value = "";
  };

  const handleAddMic = () => {
    const newMic = {
      id: crypto.randomUUID(),
      x: 0.5,
      y: 0.5,
      seatNumber: getNextSeatNumber(microphones)
    };
    setProject((prev) => ({
      ...prev,
      microphones: [...prev.microphones, newMic]
    }));
    logAction("add_mic", { id: newMic.id });
    setSelectedMicId(newMic.id);
  };

  const handleSave = async () => {
    const response = await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: project.background,
        microphones: project.microphones,
        showLabels: project.showLabels,
        micSize: project.micSize
      })
    });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    setProject(normalizeProject(data));
  };

  const handleExport = async () => {
    const response = await fetch("/api/export");
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
    fetchProject();
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
    setProject(normalizeProject(data));
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

  };

  const handleSelectMic = (micId) => {
    if (mode !== "edit") {
      const mic = microphones.find((item) => item.id === micId);
      if (mic) {
        console.info(`Clicked mic ${mic.seatNumber ?? "?"}`);
      }
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
    logAction("delete_mic", { id: mic.id, seatNumber: mic.seatNumber });
    setSelectedMicId(null);
  };

  const selectedMic = microphones.find((mic) => mic.id === selectedMicId) ?? null;

  return (
    <div className="app">
      <header className="toolbar">
        <div className="toolbar__group">
          <span className={`mode-badge mode-badge--${mode}`}>
            {mode === "edit" ? "Edit mode" : "Run mode"}
          </span>
          <button
            type="button"
            className="button"
            onClick={() => setMode((prev) => (prev === "edit" ? "run" : "edit"))}
          >
            Toggle mode
          </button>
        </div>
        <div className="toolbar__group">
          <button type="button" className="button button--secondary" onClick={() => setShowLogs(true)}>
            Logs
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setProject((prev) => ({ ...prev, showLabels: !prev.showLabels }))}
          >
            Labels: {project.showLabels ? "On" : "Off"}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              setProject((prev) => ({
                ...prev,
                micSize: clamp(prev.micSize - MIC_SIZE_STEP, MIN_MIC_SIZE, MAX_MIC_SIZE)
              }))
            }
          >
            -
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              setProject((prev) => ({
                ...prev,
                micSize: clamp(prev.micSize + MIC_SIZE_STEP, MIN_MIC_SIZE, MAX_MIC_SIZE)
              }))
            }
          >
            +
          </button>
        </div>
        <div className="toolbar__group">
          <label className="button button--secondary">
            Upload background
            <input type="file" accept="image/png, image/jpeg" onChange={handleBackgroundUpload} hidden />
          </label>
          <button type="button" className="button" onClick={handleAddMic} disabled={mode !== "edit"}>
            Add microphone
          </button>
          <button type="button" className="button" onClick={handleSave}>
            Save project
          </button>
          <button type="button" className="button" onClick={handleExport}>
            Export zip
          </button>
          <label className="button button--secondary">
            Import zip
            <input type="file" accept=".zip" onChange={handleImport} hidden />
          </label>
        </div>
      </header>
      <main className="layout">
        <section className="canvas-panel" ref={containerRef}>
          <div className="canvas-container">
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
                      onClick={() => handleSelectMic(mic.id)}
                      onTap={() => handleSelectMic(mic.id)}
                    >
                      <Circle
                        radius={micRadius}
                        fill={mode === "edit" ? "#4c6ef5" : "#868e96"}
                        stroke={isSelected ? "#f59f00" : undefined}
                        strokeWidth={isSelected ? 3 : 0}
                      />
                      <Text
                        text={`${mic.seatNumber ?? index + 1}`}
                        x={-micRadius}
                        y={-micRadius}
                        width={project.micSize}
                        height={project.micSize}
                        align="center"
                        verticalAlign="middle"
                        fontSize={Math.max(12, Math.round(project.micSize * 0.6))}
                        fontStyle="bold"
                        fill="#ffffff"
                      />
                      {project.showLabels && (
                        <Text
                          text={`Mic ${mic.seatNumber ?? index + 1}`}
                          x={-60}
                          y={micRadius + 8}
                          width={120}
                          align="center"
                          fontSize={12}
                          fill="#1f2933"
                        />
                      )}
                    </Group>
                  );
                })}
              </Layer>
            </Stage>
            {!project.background && (
              <div className="canvas-placeholder">Upload a background image to start.</div>
            )}
          </div>

          {mode === "edit" && selectedMic && (
            <aside className="properties-overlay">
              <div className="properties-panel">
                <h2>Properties</h2>
                <div className="properties-panel__body">
                  <div className="property-row">
                    <span className="property-label">Seat number</span>
                    <span className="property-value">{selectedMic.seatNumber}</span>
                  </div>
                  <div className="property-row">
                    <span className="property-label">Position</span>
                    <span className="property-value">
                      {Math.round(selectedMic.x * 100)}%, {Math.round(selectedMic.y * 100)}%
                    </span>
                  </div>
                  <button type="button" className="button button--danger" onClick={handleDeleteMic}>
                    Delete microphone
                  </button>
                </div>
              </div>
            </aside>
          )}
        </section>
      </main>
      {showLogs && (
        <div className="modal-backdrop" role="presentation" onClick={() => setShowLogs(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="Activity log" onClick={(event) => event.stopPropagation()}>
            <div className="modal__header">
              <h2>Activity log</h2>
              <button type="button" className="button button--secondary" onClick={() => setShowLogs(false)}>
                Close
              </button>
            </div>
            <div className="log-panel">
              <ul>
                {project.logs.length === 0 && <li className="log-empty">No actions yet.</li>}
                {project.logs.map((entry) => (
                  <li key={entry.id}>
                    <span className="log-title">{logLabel(entry)}</span>
                    <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
