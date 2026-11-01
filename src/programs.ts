/**
 * Starting other programs. On Windows a bare program name also finds a file of that
 * name in the working folder, ahead of PATH, so a repository could replace git with a
 * program of its own. Everything here runs programs by full path, and never in a shell.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Windows' own programs, wherever Windows is installed. */
const system32 = (program: string): string => path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", program);

/** A program's full path from PATH, or null. Relative PATH entries could point anywhere. */
export function onPath(name: string): string | null {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (path.isAbsolute(dir) && fs.existsSync(path.join(dir, file))) return path.join(dir, file);
  }
  return null;
}

/** Kill a process and everything it started. A pid comes from a file, so it is checked first. */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === "win32") execFileSync(system32("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

/** Open a link in the default browser. A failure only costs the convenience. */
export function openInBrowser(url: string): void {
  const [program, args] =
    process.platform === "win32" ? [system32("rundll32.exe"), ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["/usr/bin/open", [url]] : [onPath("xdg-open"), [url]];
  if (program) execFile(program, args as string[], () => {});
}
