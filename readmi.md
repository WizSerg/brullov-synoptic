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
- TCP integration server: `localhost:15000`

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
- Each microphone has external integration fields:
  - `micId` (unique integer)
  - virtual state `isOn` (`ON` / `OFF`)
- In **Run mode**, clicking a microphone toggles its virtual ON/OFF state.
- In **Edit mode**, clicking selects microphone properties and does not toggle ON/OFF.
- Save/load the project locally (filesystem JSON + assets).
- Export the project as a zip (`project.json` + assets) and import it back.

## TCP protocol: `SYNOPTIC/1.0`

Transport:

- TCP server on fixed port `15000`
- Line-based ASCII protocol
- Accepts both `\n` and `\r\n`
- No authentication (trusted isolated network)

On connect, server sends exactly one line:

```text
SYNOPTIC/1.0
```

### Server -> client events (broadcast to all clients)

```text
EVENT MIC <id> ON
EVENT MIC <id> OFF
EVENT MIC <id> NOT_FOUND
EVENT CONNECTED
EVENT DISCONNECTED
EVENT NOT_CONNECTED
```

`seatText` and `label` are UI-only and are never used by TCP protocol. TCP always uses `micId`.

### Client -> server command (v1)

```text
SET MIC <id> TOGGLE
```

Behavior:

- Existing `micId`: toggles state and broadcasts `EVENT MIC <id> ON|OFF`
- Unknown `micId`: broadcasts `EVENT MIC <id> NOT_FOUND`
- No `OK/ERR` responses are sent

## PuTTY manual test

1. Start app (`npm run dev` or production mode).
2. Open PuTTY, choose **Raw** TCP, host `127.0.0.1`, port `15000`.
3. On connect, expect:

   ```text
   SYNOPTIC/1.0
   ```

4. Send:

   ```text
   SET MIC 1 TOGGLE
   ```

5. Expect one of:

   ```text
   EVENT MIC 1 ON
   EVENT MIC 1 OFF
   ```

6. Send unknown id, for example:

   ```text
   SET MIC 999 TOGGLE
   ```

7. Expect:

   ```text
   EVENT MIC 999 NOT_FOUND
   ```

Also note: clicking microphones in **Run mode** produces the same ON/OFF events.

## Project structure

```text
.
├── client/          # React + Vite frontend
├── server/          # Node.js + Express backend
├── readmi.md        # This README
```

## Notes

- Stored project data lives in `server/data/` (created on first run).
- This MVP does **not** control hardware; it only provides UI, storage, and integration protocol.
