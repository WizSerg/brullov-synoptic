import EventEmitter from "node:events";
import dgram from "node:dgram";
import os from "node:os";
import { DRIVER_CAPABILITIES, HEALTH_STATUS, MIC_STATE } from "../constants.js";

const STX = 0xee;
const ETX = 0xfe;
const PORT_TX = 18092;
const PORT_RX = 18093;
const FUNC_MIC_ON = 0x01;
const FUNC_MIC_OFF = 0x02;
const FUNC_SYNC = 0x0d;
const FUNC_NOTIFY = 0x87;
const FUNC_KEEPALIVE = 0x98;

const ipToOctets = (ip) =>
  String(ip)
    .split(".")
    .map((part) => Number(part) & 0xff)
    .slice(0, 4);

const isLocalBindIp = (bindIp) => {
  if (!bindIp) {
    return false;
  }
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const addr of iface || []) {
      if (addr.family === "IPv4" && addr.address === bindIp) {
        return true;
      }
    }
  }
  return false;
};

export class Dcs150Driver extends EventEmitter {
  constructor() {
    super();
    this.type = "dcs150";
    this.capabilities = { ...DRIVER_CAPABILITIES };
    this.socket = null;
    this.config = {};
    this.connected = false;
    this.lastSeenAt = 0;
    this.healthTimer = null;
  }

  async start(config) {
    this.config = config;
    if (!isLocalBindIp(config.bindIp)) {
      throw new Error(`bindIp ${config.bindIp} does not exist on local interfaces`);
    }

    await new Promise((resolve, reject) => {
      this.socket = dgram.createSocket("udp4");

      this.socket.on("error", (error) => {
        this.emit("error", { message: error.message, raw: error });
      });

      this.socket.on("message", (msg) => {
        this.lastSeenAt = Date.now();
        this.handleMessage(msg);
      });

      this.socket.bind(PORT_RX, config.bindIp, () => {
        this.connected = true;
        this.emit("health", { status: HEALTH_STATUS.CONNECTED });
        this.sendFrame(0x00, FUNC_SYNC, ipToOctets(config.bindIp));
        resolve();
      });

      this.socket.once("error", reject);
    });

    const healthTimeoutMs = Number(config.options?.healthTimeoutMs) || 15000;
    this.healthTimer = setInterval(() => {
      if (!this.connected) {
        return;
      }
      if (!this.lastSeenAt || Date.now() - this.lastSeenAt > healthTimeoutMs) {
        this.emit("health", { status: HEALTH_STATUS.DEGRADED, reason: "No packets received" });
      }
    }, 2000);
  }

  async stop() {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    this.emit("health", { status: HEALTH_STATUS.DISCONNECTED });
  }

  async setMicState(micId, state) {
    const func = state === MIC_STATE.ON ? FUNC_MIC_ON : FUNC_MIC_OFF;
    this.sendFrame(micId, func, []);
  }

  sendFrame(address, func, payload = []) {
    if (!this.socket) {
      throw new Error("DCS150 socket is not ready");
    }
    const frame = Buffer.from([STX, address & 0xff, func & 0xff, payload.length & 0xff, ...payload, ETX]);
    this.socket.send(frame, PORT_TX, this.config.deviceIp);
  }

  handleMessage(msg) {
    if (msg.length === 5 && msg[0] === STX && msg[2] === FUNC_KEEPALIVE && msg[4] === ETX) {
      this.sendFrame(0x00, FUNC_KEEPALIVE, []);
      return;
    }

    if (msg.length < 5 || msg[0] !== STX || msg[msg.length - 1] !== ETX) {
      this.emit("error", { message: "Malformed DCS150 packet", raw: msg });
      return;
    }

    const micId = msg[1];
    const func = msg[2];
    const len = msg[3];
    const payload = msg.slice(4, 4 + len);

    if (func === FUNC_NOTIFY && payload.length === 1) {
      const state = payload[0] === 0x01 ? MIC_STATE.ON : MIC_STATE.OFF;
      this.emit("micState", { micId, state, raw: msg });
    }
  }
}
