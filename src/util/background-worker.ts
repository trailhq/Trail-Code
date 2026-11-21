import { spawn } from 'node:child_process';

/** Attempt an optional Node worker without waiting or surfacing launch failures. */
export function startBackgroundWorker(args: string[]): boolean {
  try {
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    // OS launch failures arrive as an event after spawn returns.
    child.once('error', () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}
