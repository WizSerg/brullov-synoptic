import { EventEmitter } from "node:events";
import { CONNECTION_STATUS, MIC_STATE } from "./utils.js";

const VIRTUAL_CAPABILITIES = {
  micOnOff: true,
  micStateFeedback: true
};

export class VirtualConferenceDriver extends EventEmitter {
  constructor() {
    super();
    this.type = "virtual";
    this.capabilities = VIRTUAL_CAPABILITIES;
    this.status = {
      connectionStatus: CONNECTION_STATUS.ONLINE,
      detail: "Virtual controller"
    };
  }

  async start() {
    this.emit("health", this.status);
  }

  async stop() {}

  async setMicState(micId, state) {
    this.emit("micState", { micId, state: state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF, source: "virtual" });
  }

  async toggleMic(micId, currentState) {
    const nextState = currentState === MIC_STATE.ON ? MIC_STATE.OFF : MIC_STATE.ON;
    await this.setMicState(micId, nextState);
  }

  getStatus() {
    return {
      type: this.type,
      capabilities: this.capabilities,
      ...this.status
    };
  }
}
