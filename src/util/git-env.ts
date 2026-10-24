/** Git probes with an explicit cwd must inspect that directory, even when an
 * agent host inherited repository overrides (for example from a Git hook). */
export function gitEnvForDirectory(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete env[key];
  }
  return env;
}
