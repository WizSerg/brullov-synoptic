import EventEmitter from "node:events";
import { DRIVER_CAPABILITIES, HEALTH_STATUS, MIC_STATE } from "../constants.js";

export class NoopDriver extends EventEmitter {
  constructor() {
    super();
    this.type = "noop";
    this.capabilities = { ...DRIVER_CAPABILITIES, micStateFeedback: false };
    this.started = false;
  }

  async start() {
    this.started = true;
    this.emit("health", { status: HEALTH_STATUS.DISCONNECTED, reason: "Conference integration disabled" });
  }

  async stop() {
    this.started = false;
  }

  async setMicState(micId, state) {
    this.emit("micState", { micId, state: state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF, raw: { noop: true } });
  }
}
