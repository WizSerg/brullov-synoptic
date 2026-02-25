import { Dcs100Driver } from "./drivers/dcs100-driver.js";
import { Dcs150Driver } from "./drivers/dcs150-driver.js";
import { NoopDriver } from "./drivers/noop-driver.js";
import { VirtualDriver } from "./drivers/virtual-driver.js";

const registry = {
  dcs100: () => new Dcs100Driver(),
  dcs150: () => new Dcs150Driver(),
  virtual: () => new VirtualDriver(),
  noop: () => new NoopDriver()
};

export const hasDriverType = (type) => Boolean(registry[type]);
export const listDriverTypes = () => Object.keys(registry).filter((type) => type !== "noop");
export const createDriverByType = (type) => {
  const factory = registry[type];
  if (!factory) {
    throw new Error(`Unknown conference driver type: ${type}`);
  }
  return factory();
};
