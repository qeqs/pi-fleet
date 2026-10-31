/**
 * Pi resource helpers for the GUI — discover pi extensions (plugins) and manage
 * the user-level MCP server config (~/.pi/agent/mcp.json).
 *
 * - Extensions: pi loads TypeScript/JS modules from `~/.pi/agent/extensions/`
 *   (user) and `<cwd>/.pi/extensions/` (project). A "plugin" is one such file or
 *   a directory with an index.ts / index.js. The GUI lists them and lets the user
 *   toggle which load per agent (passed as --extension on spawn).
 * - MCP: pi auto-reads `~/.pi/agent/mcp.json` (user) and `.pi/mcp.json` (project).
 *   The GUI edits the user-level file (a central registry for the whole fleet).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ExtensionInfo {
  /** Absolute path to load with --extension. */
  path: string;
  /** Display name (file/dir basename). */
  name: string;
  /** "user" (global) or "project" (per-cwd). */
  scope: "user" | "project";
}

export interface McpServerEntry {
  // stdio server
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http / streamable-http server
  url?: string;
  headers?: Record<string, string>;
  // shared
  enabled?: boolean;
  description?: string;
  [k: string]: unknown;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

/** The user-level pi agent dir (~/.pi/agent). */
export function userPiAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

/** Path to the user-level MCP config. */
export function userMcpPath(): string {
  return path.join(userPiAgentDir(), "mcp.json");
}

/**
 * Discover pi extensions in the user dir and (optionally) a project cwd.
 * Returns de-duplicated absolute paths (a project entry with the same basename
 * as a user one is reported separately, since --extension takes explicit paths).
 */
export function discoverExtensions(cwd?: string): ExtensionInfo[] {
  const out: ExtensionInfo[] = [];
  const scan = (dir: string, scope: "user" | "project") => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // a directory is an extension if it has an index.ts / index.js
        if (fs.existsSync(path.join(full, "index.ts")) || fs.existsSync(path.join(full, "index.js"))) {
          out.push({ path: full, name: entry.name, scope });
        }
      } else if (/\.(ts|js|mjs|cjs)$/.test(entry.name)) {
        out.push({ path: full, name: entry.name, scope });
      }
    }
  };
  scan(path.join(userPiAgentDir(), "extensions"), "user");
  if (cwd) scan(path.join(cwd, ".pi", "extensions"), "project");
  return out;
}

/** Read the user-level MCP config (empty servers object if absent/invalid). */
export function readMcpConfig(): McpConfig {
  const p = userMcpPath();
  if (!fs.existsSync(p)) return { mcpServers: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<McpConfig>;
    return { mcpServers: raw.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : {} };
  } catch {
    return { mcpServers: {} };
  }
}

/** Write the user-level MCP config (creating the dir if needed). */
export function writeMcpConfig(cfg: McpConfig): void {
  const p = userMcpPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
}