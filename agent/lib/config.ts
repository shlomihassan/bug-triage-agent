export interface AppConfig {
  readonly githubOwner: string;
  readonly githubRepo: string;
}

export function loadConfig(): AppConfig {
  const githubOwner = process.env.GITHUB_OWNER;
  const githubRepo = process.env.GITHUB_REPO;
  if (!githubOwner) throw new Error("GITHUB_OWNER is not set");
  if (!githubRepo) throw new Error("GITHUB_REPO is not set");
  return { githubOwner, githubRepo };
}
