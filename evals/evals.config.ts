import { defineEvalConfig } from "eve/evals";
import { haikuModel } from "../agent/lib/anthropic";

export default defineEvalConfig({
  judge: { model: haikuModel() },
});
