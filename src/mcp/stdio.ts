/** A disconnected MCP host is a normal end of a stdio session. */
export function handleMcpStdoutError(error: NodeJS.ErrnoException): void {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
}

const HARD_EXIT_MS = 2_000;
const WATCHDOG_MS = 1_000;

let ending = false;

/**
 * End the session once. Closing stdin is what a normal host disconnect does; the
 * hard-exit timer is the fallback, because a close that hangs (a tool call still
 * in flight) would otherwise keep the server alive with nobody to talk to.
 */
export function endMcpSession(): void {
  if (ending) return;
  ending = true;
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref();
  process.stdin.pause();
  process.stdin.destroy();
}

function parentAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Exit when the process that started this server goes away.
 *
 * stdin reaches EOF when the host closes the pipe, but nothing signals a dead
 * parent when a launcher or wrapper holds the pipe open: the server is reparented
 * to PID 1 and stays there until killed by hand. Comparing `process.ppid` against
 * the one seen at startup covers reparenting; the `kill(pid, 0)` probe covers a
 * parent that died while PID 1 keeps the number stable (containers, subreapers).
 */
export function installMcpParentWatchdog(intervalMs = WATCHDOG_MS): void {
  const parent = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid !== parent || process.ppid === 1 || !parentAlive(parent)) endMcpSession();
  }, intervalMs);
  timer.unref();
}
