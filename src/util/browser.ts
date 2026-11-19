import { spawn } from "node:child_process";

/** Open `url` in the default browser. Best-effort: the printed URL is the fallback. */
export function openBrowser(url: string): void {
  if (process.env.GRAFT_NO_BROWSER) return;
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" });
    // A missing opener (no xdg-open on WSL or a minimal Linux) fails later, as an
    // 'error' event: unheard, it would end this process, the viz server with it.
    child.on("error", () => {
      /* the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* the printed URL is the fallback */
  }
}
