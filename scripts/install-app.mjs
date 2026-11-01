// Installs the desktop app built into dist/ the way a person would, and prints the path of
// the installed program, so the desktop tests can run against it.
// Run with: node scripts/install-app.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dist = path.resolve("dist");
const built = (ext) => {
  const name = fs.readdirSync(dist).find((f) => f.endsWith(ext));
  if (!name) throw new Error(`no ${ext} in ${dist}`);
  return path.join(dist, name);
};
const run = (cmd, args, options) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "inherit"], ...options });

function install() {
  if (process.platform === "win32") {
    run(built(".exe"), ["/S"]); // the installer's silent mode
    return path.join(process.env.LOCALAPPDATA, "Programs", "pi-fleet", "pi-fleet.exe");
  }
  if (process.platform === "darwin") {
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-dmg-"));
    run("hdiutil", ["attach", built(".dmg"), "-mountpoint", mount, "-nobrowse", "-quiet"]);
    run("cp", ["-R", path.join(mount, "pi-fleet.app"), "/Applications/"]);
    run("hdiutil", ["detach", mount, "-quiet"]);
    return "/Applications/pi-fleet.app/Contents/MacOS/pi-fleet";
  }
  // an AppImage mounts itself with FUSE, which CI runners lack: unpack it instead
  const image = built(".AppImage");
  fs.chmodSync(image, 0o755);
  const into = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fleet-appimage-"));
  run(image, ["--appimage-extract"], { cwd: into });
  return path.join(into, "squashfs-root", "pi-fleet");
}

const program = install();
if (!fs.existsSync(program)) throw new Error(`${program} was not installed`);
console.log(program);
