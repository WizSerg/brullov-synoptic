import { DEFAULT_CONFERENCE_SETTINGS } from "./constants.js";

export const normalizeConferenceSettings = (settings = {}) => ({
  enabled: Boolean(settings.enabled),
  type: typeof settings.type === "string" ? settings.type : DEFAULT_CONFERENCE_SETTINGS.type,
  deviceIp: typeof settings.deviceIp === "string" ? settings.deviceIp.trim() : "",
  bindIp: typeof settings.bindIp === "string" ? settings.bindIp.trim() : "",
  options: {
    ...DEFAULT_CONFERENCE_SETTINGS.options,
    ...(settings.options || {})
  }
});

export const readConferenceSettings = async (fs, settingsPath) => {
  const settings = await fs.readJson(settingsPath);
  return normalizeConferenceSettings(settings);
};

export const saveConferenceSettings = async (fs, settingsPath, settings) => {
  await fs.writeJson(settingsPath, normalizeConferenceSettings(settings), { spaces: 2 });
};

export const isValidIpv4 = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
};

export const validateConferenceSettings = (settings, { hasDriverType, listDriverTypes }) => {
  if (!hasDriverType(settings.type)) {
    return `Unsupported conference type: ${settings.type}. Available: ${listDriverTypes().join(", ")}`;
  }

  if (!settings.enabled) {
    return null;
  }

  if (settings.type !== "virtual" && !isValidIpv4(settings.deviceIp)) {
    return "Invalid conference deviceIp";
  }

  if (settings.type === "dcs150" && !isValidIpv4(settings.bindIp)) {
    return "Invalid conference bindIp for dcs150";
  }

  return null;
};
