import EventEmitter from "node:events";
import net from "node:net";
import { DRIVER_CAPABILITIES, HEALTH_STATUS, MIC_STATE } from "../constants.js";

const STX = 0xee;
const ETX = 0xfe;
const PORT = 8088;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toByte = (value) => Number(value) & 0xff;

export class Dcs100Driver extends EventEmitter {
  constructor() {
    super();
    this.type = "dcs100";
    this.capabilities = { ...DRIVER_CAPABILITIES, allMicsOff: true, speechMode: true, maxOpenMics: true };
    this.socket = null;
    this.queue = [];
    this.isConnected = false;
    this.isStopped = false;
    this.connectingPromise = null;
    this.openMics = new Set();
    this.config = {};
  }

  async start(config) {
    this.config = config;
    this.isStopped = false;
    await this.connect();
    this.send(0x00, 0x3d, [0x00]); // sync
    this.send(0x00, 0x3f, [0x00]); // scan
  }

  async stop() {
    this.isStopped = true;
    this.queue = [];
    this.connectingPromise = null;
    if (this.socket) {
      this.socket.destroy();
      this.socket.removeAllListeners();
      this.socket = null;
    }
    this.isConnected = false;
  }

  async setMicState(micId, state) {
    if (!this.isConnected) {
      throw new Error("DCS100 driver is disconnected");
    }
    const addr = toByte(micId);
    const func = state === MIC_STATE.ON ? 0x31 : 0x32;
    this.send(addr, func, [0x00]);
  }

  async connect() {
    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.deviceIp, port: PORT });
      let settled = false;

      const timeoutMs = Number(this.config.options?.timeoutMs) || 1500;
      socket.setTimeout(timeoutMs, () => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error("DCS100 connect timeout"));
        }
      });

      socket.on("connect", () => {
        this.socket = socket;
        this.isConnected = true;
        this.emit("health", { status: HEALTH_STATUS.CONNECTED });
        settled = true;
        resolve();
        this.flushQueue();
      });

      socket.on("data", (buffer) => {
        this.handlePacket(buffer);
      });

      socket.on("error", (error) => {
        this.emit("error", { message: error.message, raw: error });
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      socket.on("close", async () => {
        this.isConnected = false;
        this.emit("health", { status: HEALTH_STATUS.DISCONNECTED, reason: "socket closed" });
        if (!this.isStopped) {
          await delay(timeoutMs);
          this.connect().catch(() => {});
        }
      });
    });

    try {
      await this.connectingPromise;
    } finally {
      this.connectingPromise = null;
    }
  }

  send(addr, func, data = []) {
    const payload = Array.isArray(data) ? data : [];
    const length = payload.length & 0xff;
    let crc = toByte(addr) + toByte(func) + length;
    for (const byte of payload) {
      crc += toByte(byte);
    }

    const frame = Buffer.from([STX, toByte(addr), toByte(func), length, ...payload.map(toByte), crc & 0xff, ETX]);
    this.queue.push(frame);
    this.flushQueue();
  }

  flushQueue() {
    if (!this.isConnected || !this.socket || this.socket.destroyed) {
      return;
    }
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      this.socket.write(frame);
    }
  }

  handlePacket(packet) {
    if (!Buffer.isBuffer(packet) || packet.length < 7) {
      return;
    }

    const stx = packet[0];
    const addr = packet[1];
    const func = packet[2];
    const len = packet[3];
    const data = packet.slice(4, 4 + len);
    const crc = packet[4 + len];
    const etx = packet[5 + len];

    if (stx !== STX || etx !== ETX) {
      this.emit("error", { message: "DCS100 malformed frame boundaries", raw: packet });
      return;
    }

    let expectedCrc = addr + func + len;
    for (const byte of data) {
      expectedCrc += byte;
    }
    if ((expectedCrc & 0xff) !== crc) {
      this.emit("error", { message: "DCS100 CRC mismatch", raw: packet });
      return;
    }

    if (func !== 0x21 || data.length < 32) {
      return;
    }

    const stateBytes = data.slice(16, 32);
    const currentlyOn = new Set();

    for (let byteIndex = 0; byteIndex < stateBytes.length; byteIndex += 1) {
      const byte = stateBytes[byteIndex];
      for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
        const micId = byteIndex * 8 + bitIndex + 1;
        const isOn = ((byte >> bitIndex) & 0x01) === 1;
        if (isOn) {
          currentlyOn.add(micId);
          if (!this.openMics.has(micId)) {
            this.emit("micState", { micId, state: MIC_STATE.ON, raw: packet });
          }
        }
      }
    }

    for (const previousMic of this.openMics) {
      if (!currentlyOn.has(previousMic)) {
        this.emit("micState", { micId: previousMic, state: MIC_STATE.OFF, raw: packet });
      }
    }

    this.openMics = currentlyOn;
  }
}
