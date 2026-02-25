import EventEmitter from "node:events";
import { createDriverByType } from "./registry.js";
import { HEALTH_STATUS, MIC_STATE } from "./constants.js";

export class ConferenceManager extends EventEmitter {
  constructor({ onMicStateChange = async () => {}, onHealth = async () => {} } = {}) {
    super();
    this.driver = createDriverByType("noop");
    this.config = null;
    this.health = { status: HEALTH_STATUS.DISCONNECTED, reason: "Not configured" };
    this.onMicStateChange = onMicStateChange;
    this.onHealth = onHealth;
    this.bindDriver(this.driver);
  }

  bindDriver(driver) {
    driver.on("micState", async (event) => {
      await this.onMicStateChange(event);
      this.emit("micState", event);
    });

    driver.on("health", async (event) => {
      this.health = event;
      await this.onHealth(event);
      this.emit("health", event);
    });

    driver.on("error", (event) => {
      this.emit("error", event);
    });
  }

  async switchConfig(config) {
    const nextDriver = !config?.enabled ? createDriverByType("noop") : createDriverByType(config.type);
    this.bindDriver(nextDriver);

    await nextDriver.start(config || {});

    const previousDriver = this.driver;
    this.driver = nextDriver;
    this.config = config;

    if (previousDriver) {
      await previousDriver.stop();
    }
  }

  getStatus() {
    return {
      activeDriver: this.driver.type,
      health: this.health,
      capabilities: this.driver.capabilities
    };
  }

  async setMicState(micId, state) {
    const normalizedState = state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF;
    await this.driver.setMicState(micId, normalizedState);
  }

  async toggleMic(micId, currentState) {
    const next = currentState === MIC_STATE.ON ? MIC_STATE.OFF : MIC_STATE.ON;
    await this.setMicState(micId, next);
    return next;
  }
}
