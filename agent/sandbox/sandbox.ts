import { defineSandbox } from "eve/sandbox";
import { loadConfig } from "../lib/config";

export default defineSandbox({
  revalidationKey: () => "vikunja-bootstrap-v1",
  async bootstrap({ use }) {
    const sandbox = await use();
    const { githubOwner, githubRepo } = loadConfig();
    await sandbox.run({
      command: `git clone --depth 1 https://github.com/${githubOwner}/${githubRepo}.git /workspace/repo`,
    });
  },
});
