import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import { CONNECTION_STATUS, DCS150_PORT_RX, DCS150_PORT_TX, MIC_STATE, isValidIpv4, validateBindIp } from "./utils.js";

const STX = 0xee;
const ETX = 0xfe;
const FUNC_MIC_ON = 0x01;
const FUNC_MIC_OFF = 0x02;
const FUNC_NOTIFY = 0x87;
const FUNC_KEEPALIVE = 0x98;
const FUNC_SYNC = 0x0d;
const HEALTH_TIMEOUT_MS = 12000;
const RESTART_DELAY_MS = 1000;

const DCS150_CAPABILITIES = {
  micOnOff: true,
  micStateFeedback: true
};

export class Dcs150ConferenceDriver extends EventEmitter {
  constructor() {
    super();
    this.type = "dcs150";
    this.capabilities = DCS150_CAPABILITIES;
    this.socket = null;
    this.config = null;
    this.destroyed = false;
    this.listening = false;
    this.sendingQueue = [];
    this.openMics = new Set();
    this.healthTimer = null;
    this.restartTimer = null;
    this.status = {
      connectionStatus: CONNECTION_STATUS.OFFLINE,
      detail: "DCS150 driver is stopped"
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
      throw new Error("DCS150 requires a valid Device IP");
    }
    const bindValidation = validateBindIp(config.bindIp);
    if (!bindValidation.ok) {
      throw new Error(bindValidation.message);
    }

    this.config = {
      deviceIp: config.deviceIp,
      bindIp: config.bindIp,
      options: {
        debug: Boolean(config.options?.debug)
      }
    };
    this.destroyed = false;
    await this.#bindSocket();
  }

  async stop() {
    this.destroyed = true;
    this.listening = false;
    this.sendingQueue.length = 0;
    clearTimeout(this.healthTimer);
    clearTimeout(this.restartTimer);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    this.#setHealth(CONNECTION_STATUS.OFFLINE, "DCS150 driver stopped");
  }

  async setMicState(micId, state) {
    const func = state === MIC_STATE.ON ? FUNC_MIC_ON : FUNC_MIC_OFF;
    this.#send(micId, func, []);
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

  async #bindSocket() {
    if (this.destroyed) {
      return;
    }

    this.#setHealth(CONNECTION_STATUS.DEGRADED, `Binding UDP ${this.config.bindIp}:${DCS150_PORT_RX}`);

    await new Promise((resolve, reject) => {
      let settled = false;
      const socket = dgram.createSocket("udp4");
      this.socket = socket;

      socket.once("error", (error) => {
        if (settled) {
          this.#handleSocketError(error);
          return;
        }
        settled = true;
        try {
          socket.close();
        } catch {
          // ignore close failure
        }
        reject(error);
      });

      socket.once("listening", () => {
        settled = true;
        this.listening = true;
        this.#attachListeners(socket);
        this.#setHealth(CONNECTION_STATUS.DEGRADED, `Listening on ${this.config.bindIp}:${DCS150_PORT_RX}`);
        this.#sync();
        this.#flushQueue();
        this.#armHealthTimer();
        resolve();
      });

      socket.bind(DCS150_PORT_RX, this.config.bindIp);
    });
  }

  #attachListeners(socket) {
    socket.removeAllListeners("error");
    socket.removeAllListeners("listening");
    socket.on("message", (msg, rinfo) => {
      this.#onMessage(msg, rinfo);
    });
    socket.on("error", (error) => {
      this.#handleSocketError(error);
    });
    socket.on("close", () => {
      this.listening = false;
      if (!this.destroyed) {
        this.#setHealth(CONNECTION_STATUS.DEGRADED, "DCS150 socket closed");
        this.#scheduleRestart();
      }
    });
  }

  #handleSocketError(error) {
    this.emit("error", { message: error.message });
    if (this.destroyed) {
      return;
    }
    this.#setHealth(CONNECTION_STATUS.DEGRADED, `DCS150 socket error: ${error.message}`);
    try {
      this.socket?.close();
    } catch {
      // ignore close failure
    }
    this.#scheduleRestart();
  }

  #scheduleRestart() {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(async () => {
      try {
        await this.#bindSocket();
      } catch (error) {
        this.emit("error", { message: error.message });
        this.#scheduleRestart();
      }
    }, RESTART_DELAY_MS);
  }

  #armHealthTimer() {
    clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(() => {
      if (this.destroyed) {
        return;
      }
      this.#setHealth(CONNECTION_STATUS.DEGRADED, "No keepalive or notify packets from DCS150 recently");
    }, HEALTH_TIMEOUT_MS);
  }

  #onMessage(msg, rinfo) {
    this.#armHealthTimer();

    if (msg.length < 5 || msg[0] !== STX || msg[msg.length - 1] !== ETX) {
      this.emit("error", { message: "Bad DCS150 frame", raw: msg.toString("hex") });
      return;
    }

    const address = msg[1];
    const func = msg[2];
    const len = msg[3];
    if (msg.length !== 5 + len) {
      this.emit("error", { message: `DCS150 length mismatch from ${rinfo.address}:${rinfo.port}`, raw: msg.toString("hex") });
      return;
    }

    const data = msg.slice(4, 4 + len);

    if (func === FUNC_KEEPALIVE) {
      this.#setHealth(CONNECTION_STATUS.ONLINE, `Receiving keepalive from ${this.config.deviceIp}`);
      this.#send(0x00, FUNC_KEEPALIVE, []);
      return;
    }

    if (func === FUNC_NOTIFY && len === 1) {
      const state = data[0] === 0x01 ? MIC_STATE.ON : MIC_STATE.OFF;
      if (state === MIC_STATE.ON) {
        this.openMics.add(address);
      } else {
        this.openMics.delete(address);
      }
      this.#setHealth(CONNECTION_STATUS.ONLINE, `Receiving state notifications from ${this.config.deviceIp}`);
      this.emit("micState", { micId: address, state, source: "feedback" });
    }
  }

  #frame(address, func, payload = []) {
    return Buffer.from([STX, address & 0xff, func & 0xff, payload.length & 0xff, ...payload, ETX]);
  }

  #send(address, func, payload = []) {
    if (!this.socket || !this.listening) {
      this.sendingQueue.push([address, func, payload]);
      return;
    }
    const frame = this.#frame(address, func, payload);
    this.socket.send(frame, DCS150_PORT_TX, this.config.deviceIp, (error) => {
      if (error) {
        this.emit("error", { message: error.message });
      }
    });
  }

  #flushQueue() {
    if (!this.socket || !this.listening || this.sendingQueue.length === 0) {
      return;
    }
    const queue = [...this.sendingQueue];
    this.sendingQueue.length = 0;
    for (const [address, func, payload] of queue) {
      this.#send(address, func, payload);
    }
  }

  #sync() {
    const octets = String(this.config.bindIp)
      .split(".")
      .map((value) => Number.parseInt(value, 10) & 0xff)
      .slice(0, 4);
    while (octets.length < 4) {
      octets.push(0);
    }
    this.#send(0x00, FUNC_SYNC, octets);
  }
}
