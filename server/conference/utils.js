import os from "node:os";

export const MIC_STATE = {
  ON: "ON",
  OFF: "OFF"
};

export const CONNECTION_STATUS = {
  ONLINE: "online",
  OFFLINE: "offline",
  DEGRADED: "degraded"
};

export const DCS100_PORT = 8088;
export const DCS150_PORT_TX = 18092;
export const DCS150_PORT_RX = 18093;

export const normalizeRuntimeMicState = (state) => (state === MIC_STATE.ON ? MIC_STATE.ON : MIC_STATE.OFF);

export const parseMicId = (value) => {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const isValidIpv4 = (value) => {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  const parts = trimmed.split(".");
  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
};

export const localIpv4Addresses = () => {
  const interfaces = os.networkInterfaces();
  const addresses = new Set(["127.0.0.1"]);

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry?.family === "IPv4" && typeof entry.address === "string") {
        addresses.add(entry.address);
      }
    }
  }

  return addresses;
};

export const validateBindIp = (value) => {
  if (!value) {
    return { ok: true };
  }

  if (!isValidIpv4(value)) {
    return { ok: false, message: "Bind IP must be a valid IPv4 address" };
  }

  if (!localIpv4Addresses().has(value)) {
    return { ok: false, message: `Bind IP ${value} is not assigned to a local interface` };
  }

  return { ok: true };
};

