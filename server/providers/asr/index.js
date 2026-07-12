import { VolcengineAsrProvider } from "./volcengine.js";

export function createAsrProvider(config, logger) {
  if (config.provider === "volcengine") return new VolcengineAsrProvider(config, logger);
  throw new Error(`Unsupported ASR provider: ${config.provider}`);
}
