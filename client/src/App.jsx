import { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Circle, Group, Text, Rect } from "react-konva";
import useImage from "use-image";

const DEFAULT_PROJECT = {
  background: null,
  microphones: [],
  logs: []
};

const formatTimestamp = (value) => new Date(value).toLocaleString();

const logLabel = (entry) => {
  switch (entry.type) {
    case "add_mic":
      return "Added microphone";
    case "move_mic":
      return "Moved microphone";
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

const App = () => {
  const [mode, setMode] = useState("edit");
  const [project, setProject] = useState(DEFAULT_PROJECT);
  const [stageSize, setStageSize] = useState({ width: 900, height: 520 });
  const containerRef = useRef(null);
  const [bgImage] = useImage(project.background?.url || "");

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
    setProject(data);
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
    setProject(data);
    event.target.value = "";
  };

  const handleAddMic = () => {
    const newMic = {
      id: crypto.randomUUID(),
      x: 0.5,
      y: 0.5
    };
    setProject((prev) => ({
      ...prev,
      microphones: [...prev.microphones, newMic]
    }));
    logAction("add_mic", { id: newMic.id });
  };

  const handleSave = async () => {
    const response = await fetch("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        background: project.background,
        microphones: project.microphones
      })
    });
    if (!response.ok) {
      return;
    }
    const data = await response.json();
    setProject(data);
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
    setProject(data);
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

    logAction("move_mic", { id: mic.id, x: nextX, y: nextY });
  };

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
                  return (
                    <Group
                      key={mic.id}
                      x={absoluteX}
                      y={absoluteY}
                      draggable={mode === "edit"}
                      onDragEnd={(event) => handleDragEnd(event, mic)}
                    >
                      <Circle radius={14} fill={mode === "edit" ? "#4c6ef5" : "#868e96"} />
                      <Text
                        text={`Mic ${index + 1}`}
                        offsetX={-18}
                        offsetY={-30}
                        fontSize={12}
                        fill="#1f2933"
                      />
                    </Group>
                  );
                })}
              </Layer>
            </Stage>
            {!project.background && (
              <div className="canvas-placeholder">Upload a background image to start.</div>
            )}
          </div>
        </section>
        <aside className="log-panel">
          <h2>Activity log</h2>
          <ul>
            {project.logs.length === 0 && <li className="log-empty">No actions yet.</li>}
            {project.logs.map((entry) => (
              <li key={entry.id}>
                <span className="log-title">{logLabel(entry)}</span>
                <span className="log-time">{formatTimestamp(entry.timestamp)}</span>
              </li>
            ))}
          </ul>
        </aside>
      </main>
    </div>
  );
};

export default App;
