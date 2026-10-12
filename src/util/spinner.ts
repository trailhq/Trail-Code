/**
 * One line that redraws in place while something runs, and is erased when it
 * stops — so nothing interactive is left in the scrollback.
 *
 * Only on a TTY. Anywhere else every method is a no-op, and the caller prints
 * whatever finished lines it wants a log to keep.
 */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  /** Change the text after the frame. */
  update(text: string): void;
  /** Print a finished line above the spinner, which keeps spinning below it. */
  print(line: string): void;
  /** Erase the line and stop. Safe to call more than once. */
  stop(): void;
  readonly active: boolean;
}

export function startSpinner(
  text: string,
  opts: { stream?: NodeJS.WriteStream; enabled?: boolean; intervalMs?: number } = {},
): Spinner {
  const out = opts.stream ?? process.stderr;
  const enabled = opts.enabled ?? Boolean(out.isTTY);
  if (!enabled) {
    return { update() {}, print: (line) => out.write(`${line}\n`), stop() {}, active: false };
  }
  let current = text;
  let frame = 0;
  let stopped = false;
  const width = () => Math.max(20, (out.columns || 100) - 1);
  const draw = () => {
    if (stopped) return;
    const line = `${FRAMES[frame % FRAMES.length]} ${current}`;
    out.write(`\r\x1b[2K${line.length > width() ? line.slice(0, width()) : line}`);
    frame++;
  };
  const clear = () => out.write("\r\x1b[2K");
  draw();
  const timer = setInterval(draw, opts.intervalMs ?? 80);
  timer.unref?.();
  return {
    get active() {
      return !stopped;
    },
    update(next: string) {
      current = next;
      draw();
    },
    print(line: string) {
      clear();
      out.write(`${line}\n`);
      draw();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      clear();
    },
  };
}
