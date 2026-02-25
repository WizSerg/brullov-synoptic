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

- Single-user authentication (cookie session).
- Default credentials: `admin` / `admin`.
- Login page (`/login`) and redirect for unauthenticated users.
- Change password from Settings (old/new/confirm).

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

## Authentication

- Auth is intentionally minimal: one local account, one effective role (admin).
- Credentials are stored in `server/data/auth.json` with PBKDF2 hash + salt (no plaintext passwords).
- Default first-run credentials:
  - username: `admin`
  - password: `admin`
- Session is cookie-based (`HttpOnly`, `SameSite=Lax`).

### Auth API

- `POST /api/login`
  - Body: `{ "username": "admin", "password": "admin" }`
  - Result: sets auth session cookie.
- `POST /api/logout`
  - Clears auth session cookie.
- `POST /api/change-password` (requires auth)
  - Body: `{ "oldPassword": "...", "newPassword": "..." }`
- `GET /api/auth/me`
  - Returns current auth status + username.


## TCP integration protocol (ASCII, v1)

A lightweight TCP server is available for external integrations.

- Fixed TCP port: `31415`.
- Transport: plain TCP, ASCII line protocol.
- Server line ending for responses/events: `\n\r`.
- Accepted client command line ending: `\n` or `\r\n`.
- Multiple clients can stay connected simultaneously.
- No authentication (intended for an isolated trusted network).

### Welcome line

On connect, the server sends:

- `RMS SYNOPTIC/<version>`

`<version>` is taken from app metadata (same version shown in About).

### Commands (client -> server)

- `SET MIC <micId> ON`
- `SET MIC <micId> OFF`
- `SET MIC <micId> TOGGLE`

Sets (or toggles) microphone runtime state and broadcasts event to all connected TCP clients.

### Events (server -> all connected clients)

- `EVENT MIC <micId> ON`
- `EVENT MIC <micId> OFF`
- `EVENT MIC <micId> NOT_FOUND`

Events are broadcast for any microphone toggle initiated from web UI API or TCP command path.

### Conference integration API (DCS100 / DCS150)

- `GET /api/conference/settings` — current persisted driver settings.
- `POST /api/conference/settings` — validate and hot-switch active driver (`enabled`, `type`, `deviceIp`, optional `bindIp`, `options`).
- `GET /api/conference/status` — active driver, health state, capabilities.
- `POST /api/microphones/:id/on` — set microphone state ON.
- `POST /api/microphones/:id/off` — set microphone state OFF.
- `POST /api/microphones/:id/toggle` — compatibility endpoint.

Notes:
- `micId` is normalized as a positive integer in project storage and API.
- TCP integration also accepts `SET MIC <micId> ON|OFF|TOGGLE`.

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
- MVP now supports optional integration with one active conference driver (`virtual` simulation, `dcs100` TCP, or `dcs150` UDP) configured via API or Settings UI.
- Hardware integration remains capability-driven and can be disabled (`conference.enabled=false`).
