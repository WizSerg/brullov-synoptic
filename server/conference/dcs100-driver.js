import { EventEmitter } from "node:events";
import net from "node:net";
import { CONNECTION_STATUS, DCS100_PORT, MIC_STATE, isValidIpv4 } from "./utils.js";

const STX = 0xee;
const ETX = 0xfe;
const FUNC_MIC_ON = 0x31;
const FUNC_MIC_OFF = 0x32;
const FUNC_SYNC = 0x3d;
const FUNC_SCAN = 0x3f;
const FUNC_NOTIFY_STATE = 0x21;
const MAX_QUEUE_LENGTH = 256;
const RECONNECT_DELAY_MS = 1500;
const DEFAULT_CONNECT_TIMEOUT_MS = 2500;

const DCS100_CAPABILITIES = {
  micOnOff: true,
  micStateFeedback: true,
  allMicsOff: true,
  speechMode: true,
  maxOpenMics: true,
  centralEq: true
};

const bitsToFlags = (bitArray) => {
  const flags = [];
  for (let i = 0; i < bitArray.length; i += 1) {
    for (let bit = 0; bit < 8; bit += 1) {
      flags.push((bitArray[i] >>> bit) & 0x01);
    }
  }
  return flags;
};

export class Dcs100ConferenceDriver extends EventEmitter {
  constructor() {
    super();
    this.type = "dcs100";
    this.capabilities = DCS100_CAPABILITIES;
    this.socket = null;
    this.config = null;
    this.queue = [];
    this.receiveBuffer = Buffer.alloc(0);
    this.busy = false;
    this.destroyed = false;
    this.connected = false;
    this.watchdog = null;
    this.reconnectTimer = null;
    this.openMics = new Set();
    this.status = {
      connectionStatus: CONNECTION_STATUS.OFFLINE,
      detail: "DCS100 driver is stopped"
    };
  }

  getStatus() {
    return {
      type: this.type,
      capabilities: this.capabilities,
      ...this.status
    };
  }

  async start(config = {}) {
    if (!isValidIpv4(config.deviceIp)) {
      throw new Error("DCS100 requires a valid Device IP");
    }

    this.config = {
      deviceIp: config.deviceIp,
      options: {
        debug: Boolean(config.options?.debug),
        timeoutMs: Number(config.options?.timeoutMs) > 0 ? Number(config.options.timeoutMs) : DEFAULT_CONNECT_TIMEOUT_MS
      }
    };
    this.destroyed = false;
    await this.#connect();
  }

  async stop() {
    this.destroyed = true;
    this.connected = false;
    this.queue.length = 0;
    clearTimeout(this.watchdog);
    clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.#setHealth(CONNECTION_STATUS.OFFLINE, "DCS100 driver stopped");
  }

  async setMicState(micId, state) {
    const func = state === MIC_STATE.ON ? FUNC_MIC_ON : FUNC_MIC_OFF;
    this.#send(micId, func, [0x00]);
  }

  async toggleMic(micId) {
    if (this.openMics.has(micId)) {
      await this.setMicState(micId, MIC_STATE.OFF);
      return;
    }
    await this.setMicState(micId, MIC_STATE.ON);
  }

  #setHealth(connectionStatus, detail) {
    this.status = { connectionStatus, detail };
    this.emit("health", this.status);
  }

  async #connect() {
    if (this.destroyed) {
      return;
    }

    this.#setHealth(CONNECTION_STATUS.DEGRADED, `Connecting to ${this.config.deviceIp}:${DCS100_PORT}`);

    await new Promise((resolve, reject) => {
      let settled = false;
      const onError = (error) => {
        if (settled) {
          this.#handleDisconnect(`Connection error: ${error.message}`);
          return;
        }
        settled = true;
        this.socket?.removeAllListeners();
        this.socket?.destroy();
        reject(error);
      };

      const socket = net.createConnection({ host: this.config.deviceIp, port: DCS100_PORT });
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setTimeout(this.config.options.timeoutMs, () => {
        onError(new Error("Connection timeout"));
      });

      socket.on("connect", () => {
        this.connected = true;
        this.receiveBuffer = Buffer.alloc(0);
        this.busy = false;
        this.#attachSocketListeners(socket);
        this.#setHealth(CONNECTION_STATUS.ONLINE, `Connected to ${this.config.deviceIp}:${DCS100_PORT}`);
        this.#send(0x00, FUNC_SYNC, [0x00]);
        this.#send(0x00, FUNC_SCAN, [0x00]);
        settled = true;
        resolve();
      });

      socket.once("error", onError);
    });
  }

  #attachSocketListeners(socket) {
    socket.removeAllListeners("error");
    socket.setTimeout(0);
    socket.on("data", (chunk) => {
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
      this.#drainFrames();
      this.#sendNext();
    });
    socket.on("end", () => {
      this.#handleDisconnect("Socket ended by remote host");
    });
    socket.on("close", () => {
      this.#handleDisconnect("Socket closed");
    });
    socket.on("error", (error) => {
      this.emit("error", { message: error.message });
      this.#handleDisconnect(`Socket error: ${error.message}`);
    });
  }

  #handleDisconnect(reason) {
    if (this.destroyed) {
      return;
    }
    this.connected = false;
    this.busy = false;
    clearTimeout(this.watchdog);
    this.#setHealth(CONNECTION_STATUS.DEGRADED, reason);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.#connect();
      } catch (error) {
        this.emit("error", { message: error.message });
        this.#handleDisconnect(`Reconnect failed: ${error.message}`);
      }
    }, RECONNECT_DELAY_MS);
  }

  #frame(addr, func, data = []) {
    let crc = addr + func + data.length;
    for (const byte of data) {
      crc += byte;
    }
    return Buffer.from([STX, addr & 0xff, func & 0xff, data.length & 0xff, ...data, crc & 0xff, ETX]);
  }

  #send(addr, func, data = []) {
    if (this.queue.length >= MAX_QUEUE_LENGTH) {
      this.queue.shift();
    }
    this.queue.push(this.#frame(addr, func, data));
    this.#flushQueue();
  }

  #flushQueue() {
    if (!this.socket || this.busy || this.queue.length === 0 || !this.connected) {
      return;
    }
    const frame = this.queue.shift();
    this.busy = true;
    this.socket.write(frame, (error) => {
      if (error) {
        this.emit("error", { message: error.message });
        this.#handleDisconnect(`Write error: ${error.message}`);
        return;
      }
      clearTimeout(this.watchdog);
      this.watchdog = setTimeout(() => {
        if (this.busy) {
          this.busy = false;
          this.#setHealth(CONNECTION_STATUS.DEGRADED, "DCS100 response watchdog timeout");
          this.#flushQueue();
        }
      }, 2000);
    });
  }

  #sendNext() {
    clearTimeout(this.watchdog);
    this.busy = false;
    this.#flushQueue();
  }

  #drainFrames() {
    while (this.receiveBuffer.length >= 6) {
      const stxIndex = this.receiveBuffer.indexOf(STX);
      if (stxIndex === -1) {
        this.receiveBuffer = Buffer.alloc(0);
        return;
      }
      if (stxIndex > 0) {
        this.receiveBuffer = this.receiveBuffer.slice(stxIndex);
      }
      if (this.receiveBuffer.length < 6) {
        return;
      }
      const len = this.receiveBuffer[3];
      const frameLength = 6 + len;
      if (this.receiveBuffer.length < frameLength) {
        return;
      }
      const frame = this.receiveBuffer.slice(0, frameLength);
      this.receiveBuffer = this.receiveBuffer.slice(frameLength);
      this.#parseFrame(frame);
    }
  }

  #parseFrame(frame) {
    if (frame[0] !== STX || frame[frame.length - 1] !== ETX) {
      this.emit("error", { message: "Invalid DCS100 packet framing", raw: frame.toString("hex") });
      return;
    }

    const addr = frame[1];
    const func = frame[2];
    const len = frame[3];
    const data = frame.slice(4, 4 + len);
    const crc = frame[frame.length - 2];
    const expectedCrc = (addr + func + len + [...data].reduce((sum, byte) => sum + byte, 0)) & 0xff;

    if (crc !== expectedCrc) {
      this.emit("error", { message: "Invalid DCS100 CRC", raw: frame.toString("hex") });
      return;
    }

    if (func === FUNC_NOTIFY_STATE) {
      this.#parseMicState(data);
    }
  }

  #parseMicState(data) {
    if (data.length < 32) {
      this.emit("error", { message: "DCS100 state payload is too short", raw: data.toString("hex") });
      return;
    }

    const onOffFlags = bitsToFlags(data.slice(16, 32));
    const nextOpen = new Set();

    onOffFlags.forEach((flag, index) => {
      const micId = index + 1;
      if (flag) {
        nextOpen.add(micId);
      }
    });

    for (const micId of this.openMics) {
      if (!nextOpen.has(micId)) {
        this.emit("micState", { micId, state: MIC_STATE.OFF, source: "feedback" });
      }
    }

    for (const micId of nextOpen) {
      if (!this.openMics.has(micId)) {
        this.emit("micState", { micId, state: MIC_STATE.ON, source: "feedback" });
      }
    }

    this.openMics = nextOpen;
    this.#setHealth(CONNECTION_STATUS.ONLINE, `Connected to ${this.config.deviceIp}:${DCS100_PORT}`);
  }
}
