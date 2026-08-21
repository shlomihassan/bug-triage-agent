import { anthropic } from "@ai-sdk/anthropic";

export const HAIKU_MODEL_ID = "claude-haiku-4-5-20251001";
export const SONNET_MODEL_ID = "claude-sonnet-5";
export const OPUS_MODEL_ID = "claude-opus-5";

export const haikuModel = () => anthropic(HAIKU_MODEL_ID);
export const sonnetModel = () => anthropic(SONNET_MODEL_ID);
export const opusModel = () => anthropic(OPUS_MODEL_ID);
