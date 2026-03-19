import { EventEmitter } from "node:events";
import { Dcs100ConferenceDriver } from "./dcs100-driver.js";
import { Dcs150ConferenceDriver } from "./dcs150-driver.js";
import { VirtualConferenceDriver } from "./virtual-driver.js";
import { CONNECTION_STATUS, MIC_STATE, isValidIpv4, normalizeRuntimeMicState, parseMicId, validateBindIp } from "./utils.js";

const DRIVER_FACTORIES = {
  virtual: () => new VirtualConferenceDriver(),
  dcs100: () => new Dcs100ConferenceDriver(),
  dcs150: () => new Dcs150ConferenceDriver()
};

export const CONFERENCE_TYPES = new Set(Object.keys(DRIVER_FACTORIES));

const DEFAULT_OPTIONS = {
  debug: false,
  timeoutMs: 2500
};

export const defaultConferenceConfig = {
  type: "virtual",
  deviceIp: "",
  bindIp: "",
  options: { ...DEFAULT_OPTIONS }
};

const normalizeOptions = (options = {}) => ({
  debug: Boolean(options?.debug),
  timeoutMs: Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_OPTIONS.timeoutMs
});

export const normalizeConferenceConfig = (conference) => {
  const type =
    typeof conference?.type === "string" && CONFERENCE_TYPES.has(conference.type.trim().toLowerCase())
      ? conference.type.trim().toLowerCase()
      : defaultConferenceConfig.type;

  return {
    type,
    deviceIp: typeof conference?.deviceIp === "string" ? conference.deviceIp.trim() : "",
    bindIp: typeof conference?.bindIp === "string" ? conference.bindIp.trim() : "",
    options: normalizeOptions(conference?.options)
  };
};

export const validateConferenceConfig = (conference) => {
  const normalized = normalizeConferenceConfig(conference);

  if (!CONFERENCE_TYPES.has(normalized.type)) {
    return { ok: false, error: `Unsupported conference type: ${normalized.type}` };
  }

  if (normalized.type !== "virtual" && !isValidIpv4(normalized.deviceIp)) {
    return { ok: false, error: "Device IP must be a valid IPv4 address" };
  }

  if (normalized.type === "dcs150") {
    if (!normalized.bindIp) {
      return { ok: false, error: "Bind IP is required for DCS150" };
    }
    const bindValidation = validateBindIp(normalized.bindIp);
    if (!bindValidation.ok) {
      return { ok: false, error: bindValidation.message };
    }
  }

  return { ok: true, config: normalized };
};

export class ConferenceManager extends EventEmitter {
  constructor({ onMicState = () => {}, onHealth = () => {}, onDriverError = () => {} } = {}) {
    super();
    this.activeConfig = normalizeConferenceConfig();
    this.driver = null;
    this.driverStatus = {
      type: "virtual",
      capabilities: { micOnOff: true, micStateFeedback: true },
      connectionStatus: CONNECTION_STATUS.ONLINE,
      detail: "Virtual controller"
    };
    this.onMicState = onMicState;
    this.onHealth = onHealth;
    this.onDriverError = onDriverError;
  }

  async start(config) {
    await this.applyConfig(config);
  }

  async stop() {
    if (this.driver) {
      await this.driver.stop();
      this.driver.removeAllListeners();
      this.driver = null;
    }
  }

  async applyConfig(config) {
    const validation = validateConferenceConfig(config);
    if (!validation.ok) {
      throw new Error(validation.error);
    }

    const nextConfig = validation.config;
    const isSameConfig = JSON.stringify(nextConfig) === JSON.stringify(this.activeConfig) && this.driver;
    if (isSameConfig) {
      return this.getStatus();
    }

    const previousConfig = this.activeConfig;
    const previousDriver = this.driver;
    const previousStatus = this.driverStatus;

    if (previousDriver) {
      await previousDriver.stop();
      previousDriver.removeAllListeners();
      this.driver = null;
    }

    try {
      const driver = DRIVER_FACTORIES[nextConfig.type]();
      this.#wireDriver(driver);
      await driver.start(nextConfig);
      this.driver = driver;
      this.activeConfig = nextConfig;
      this.driverStatus = {
        ...driver.getStatus(),
        deviceIp: nextConfig.deviceIp,
        bindIp: nextConfig.bindIp
      };
      return this.getStatus();
    } catch (error) {
      if (previousDriver) {
        try {
          this.#wireDriver(previousDriver);
          await previousDriver.start(previousConfig);
          this.driver = previousDriver;
          this.activeConfig = previousConfig;
          this.driverStatus = previousStatus;
        } catch {
          this.driver = null;
          this.activeConfig = normalizeConferenceConfig();
          this.driverStatus = {
            type: this.activeConfig.type,
            capabilities: { micOnOff: true, micStateFeedback: true },
            connectionStatus: CONNECTION_STATUS.OFFLINE,
            detail: "No active conference driver"
          };
        }
      }
      throw error;
    }
  }

  #wireDriver(driver) {
    driver.removeAllListeners();
    driver.on("micState", (event) => {
      this.onMicState({ ...event, state: normalizeRuntimeMicState(event.state) });
    });
    driver.on("health", (health) => {
      this.driverStatus = {
        ...this.driverStatus,
        type: driver.type,
        capabilities: driver.capabilities,
        deviceIp: this.activeConfig.deviceIp,
        bindIp: this.activeConfig.bindIp,
        ...health
      };
      this.onHealth(this.driverStatus);
    });
    driver.on("error", (error) => {
      this.onDriverError({ type: driver.type, ...error });
    });
  }

  async setMicState(micId, state) {
    const normalizedMicId = parseMicId(micId);
    if (!normalizedMicId) {
      throw new Error("Microphone ID must be a positive integer");
    }
    if (!this.driver) {
      throw new Error("Conference driver is not initialized");
    }
    const normalizedState = state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF;
    await this.driver.setMicState(normalizedMicId, normalizedState);
    return { micId: normalizedMicId, state: normalizedState };
  }

  async toggleMic(micId, currentState = MIC_STATE.OFF) {
    const normalizedMicId = parseMicId(micId);
    if (!normalizedMicId) {
      throw new Error("Microphone ID must be a positive integer");
    }
    if (!this.driver) {
      throw new Error("Conference driver is not initialized");
    }

    if (typeof this.driver.toggleMic === "function") {
      await this.driver.toggleMic(normalizedMicId, currentState);
      return {
        micId: normalizedMicId,
        state: currentState === MIC_STATE.ON ? MIC_STATE.OFF : MIC_STATE.ON
      };
    }

    const nextState = currentState === MIC_STATE.ON ? MIC_STATE.OFF : MIC_STATE.ON;
    await this.driver.setMicState(normalizedMicId, nextState);
    return { micId: normalizedMicId, state: nextState };
  }

  getStatus() {
    return {
      ...this.activeConfig,
      ...this.driverStatus,
      activeDriver: this.driver?.type ?? null
    };
  }
}

export { MIC_STATE, parseMicId, normalizeRuntimeMicState };
