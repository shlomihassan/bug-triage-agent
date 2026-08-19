import { defineAgent } from "eve";
import { anthropic } from "@ai-sdk/anthropic";

export default defineAgent({
  model: anthropic("claude-sonnet-5"),
});
