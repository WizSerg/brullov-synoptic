import EventEmitter from "node:events";
import { DRIVER_CAPABILITIES, HEALTH_STATUS, MIC_STATE } from "../constants.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class VirtualDriver extends EventEmitter {
  constructor() {
    super();
    this.type = "virtual";
    this.capabilities = { ...DRIVER_CAPABILITIES, allMicsOff: true };
    this.latencyMs = 80;
    this.micStates = new Map();
    this.started = false;
  }

  async start(config = {}) {
    this.started = true;
    this.latencyMs = Number(config.options?.virtualLatencyMs) > 0 ? Number(config.options.virtualLatencyMs) : 80;
    this.emit("health", { status: HEALTH_STATUS.CONNECTED, reason: "Virtual simulation mode" });
  }

  async stop() {
    this.started = false;
    this.emit("health", { status: HEALTH_STATUS.DISCONNECTED, reason: "Virtual simulation stopped" });
  }

  async setMicState(micId, state) {
    if (!this.started) {
      throw new Error("Virtual driver is not started");
    }
    await delay(this.latencyMs);
    const nextState = state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF;
    this.micStates.set(micId, nextState);
    this.emit("micState", { micId, state: nextState, raw: { virtual: true } });
  }
}
