/**
 * The oldest Node trail runs on, checked by the bin before anything else loads.
 *
 * `process.getBuiltinModule`, which the hooks and the past-session look-back
 * use, arrived in Node 22.3 and was backported to 20.16; 21 never got it. On an
 * older Node most commands seem fine and `trail init` quietly reads no past
 * sessions ("process.getBuiltinModule is not a function"), so the check is up
 * front. npm only warns about `engines`, in a block most people scroll past.
 *
 * No imports, so an old Node gets this far whatever the rest of the code needs.
 */
export function nodeSupported(version: string = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 3) || (major === 20 && minor >= 16);
}

/** The plain message for an unsupported Node, or null when this one is fine. */
export function nodeTooOld(command: string, pkg: string, version: string = process.versions.node): string | null {
  if (nodeSupported(version)) return null;
  return (
    `✗ ${command} needs Node 22.3 or newer (20.16 works too); this is Node ${version}.\n` +
    `  Update Node (https://nodejs.org, or \`nvm install 22\` if you use nvm), then run \`npm i -g ${pkg}\` again.`
  );
}
