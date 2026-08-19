import { anthropic } from "@ai-sdk/anthropic";

export const haikuModel = () => anthropic("claude-haiku-4-5-20251001");
export const sonnetModel = () => anthropic("claude-sonnet-5");
export const opusModel = () => anthropic("claude-opus-5");
