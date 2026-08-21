import { disableTool } from "eve/tools";

// eve exposes `load_skill` as a framework-default tool even though this project defines zero
// skills (`eve info` reports "Skills 0 skills"; there is no agent/skills/ directory). With
// nothing it could ever load, the tool is a structural dead end the model can still discover
// and try — which is exactly what happened on issue #7's first attempt: the agent, mid-triage,
// called `load_skill("crudable")` (a name it invented, not one defined anywhere in this repo)
// and got back "No skill named \"crudable\".". The run then went silent, because nothing in
// this codebase marks a run failed except reaching open_pr or report_could_not_reproduce — a
// real, named, logged error with no path to surface anywhere the run ever completes.
//
// Disabling the tool removes the dead end at its source: the model can no longer see or call
// a capability that can't succeed in this deployment. If this project ever gains real skills
// (agent/skills/), delete this file to restore the framework default.
export default disableTool();
