# Synoptic Scheme MVP (Raspberry Pi)

Local web app demo for building a synoptic scheme of a small meeting room.

## Quick start

```bash
npm install
```

### Development

```bash
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

### Production build + run

```bash
npm run build:start
```

Then open http://localhost:3001 (the server serves the built UI).

## Features (MVP v1)

- Upload a background image (PNG/JPG) and display it on the canvas.
- Add microphone widgets on top of the background.
- Drag microphones in **Edit mode** only (Run mode disables dragging).
- Microphones display stable seat numbers and optional labels.
- Toggle label visibility, mic size, and activity log from the toolbar.
- Delete microphones from the Properties panel (Edit mode only).
- Microphone positions are stored as **relative coordinates** (0..1).
- Save/load the project locally (filesystem JSON + assets).
- Export the project as a zip (`project.json` + assets) and import it back.
- Log actions (add/delete mic, save, import/export, background upload, mic toggles) into rotating files under `server/data/logs/`.

## Acceptance criteria mapping

| Requirement | Implementation |
| --- | --- |
| One screen: Synoptic Scheme | Single page React UI (`Synoptic Scheme`). |
| Two modes: Edit / Run | Mode toggle in the toolbar; drag enabled only in Edit. |
| Upload background | "Upload background" button uploads PNG/JPG to server assets. |
| Add microphone widgets | "Add microphone" button adds a mic to the canvas. |
| Drag microphones in Edit mode only | Konva drag enabled only when mode is Edit. |
| Relative coordinates | Stored as `x`, `y` in range 0..1 in `project.json`. |
| Save/load locally | Express server stores `server/data/project.json` + assets. |
| Export/import zip | Export endpoint streams zip; import uploads zip and restores files. |
| Log actions | Activity log panel reads recent entries from rotating server log files (`server/data/logs/app.log*`). |

## Project structure

```
.
├── client/          # React + Vite frontend
├── server/          # Node.js + Express backend
├── readmi.md        # This README
```

## Notes

- Stored project data lives in `server/data/` (created on first run).
- This MVP does **not** control hardware; it only provides the UI and storage.
