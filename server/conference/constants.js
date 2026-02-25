export const MIC_STATE = {
  ON: "ON",
  OFF: "OFF",
  UNKNOWN: "UNKNOWN"
};

export const HEALTH_STATUS = {
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  DEGRADED: "degraded"
};

export const DEFAULT_CONFERENCE_SETTINGS = {
  enabled: false,
  type: "dcs100",
  deviceIp: "",
  bindIp: "",
  options: {
    debug: false,
    timeoutMs: 1500
  }
};

export const DRIVER_CAPABILITIES = {
  micOnOff: true,
  micStateFeedback: true
};
