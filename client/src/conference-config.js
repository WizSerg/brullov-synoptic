export const CONFERENCE_TYPE_OPTIONS = [
  { value: "virtual", labelKey: "conference.type.virtual" },
  { value: "dcs100", labelKey: "conference.type.dcs100" },
  { value: "dcs150", labelKey: "conference.type.dcs150" }
];

export const DEFAULT_CONFERENCE_SETTINGS = {
  enabled: false,
  type: "virtual",
  deviceIp: "",
  bindIp: "",
  options: {
    debug: false,
    timeoutMs: 1500,
    healthTimeoutMs: 15000,
    virtualLatencyMs: 80
  }
};
