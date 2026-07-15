import { OpenAiCompatibleLlmProvider } from "./openai-compatible.js";

export function createLlmProvider(config) {
  if (config.provider === "openai-compatible") return new OpenAiCompatibleLlmProvider(config);
  throw new Error(`Unsupported LLM provider: ${config.provider}`);
}
