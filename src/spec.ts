/**
 * Agent-spec parsing for `fleet up --agent name[:cwd][:model][:role]`.
 *
 * Isolated from fleet.ts (which runs `main()` on import) so the pure parsing
 * logic can be unit-tested without side effects.
 */
import path from "node:path";

export interface ParsedAgentSpec {
  name: string;
  cwd?: string;
  model?: string;
  role?: string;
}

/**
 * Parse an agent spec `name[:cwd][:model][:role]`. The cwd segment may be a Windows
 * absolute path (e.g. `C:\Users\...`) whose drive-letter `:` would otherwise be
 * mistaken for a field separator, so we detect a bare drive letter and rejoin it with
 * the following path segment. Only cwd can contain `:`; name/model/role never do.
 */
export function parseAgentSpec(spec: string): ParsedAgentSpec {
  const parts = spec.split(":");
  const name = parts[0];
  let cwd: string | undefined;
  let idx = 1;
  if (parts.length > 1) {
    if (/^[A-Za-z]$/.test(parts[1]) && parts.length > 2 && /^[\\/]/.test(parts[2])) {
      // "C" + "\Users\..." → "C:\Users\..." (Windows drive-letter path)
      cwd = parts[1] + ":" + parts[2];
      idx = 3;
    } else {
      cwd = parts[1];
      idx = 2;
    }
  }
  const model = idx < parts.length ? parts[idx] : undefined;
  const role = idx + 1 < parts.length ? parts[idx + 1] : undefined;
  return { name, cwd: cwd || undefined, model: model || undefined, role: role || undefined };
}

/** Names the bus keeps for itself: an agent may not pose as the user or shadow the default channel. */
const RESERVED_NAMES = new Set(["group", "user", "system", "router"]);

/** Names that mean something else as an object key, or as a Windows file name. */
const UNSAFE_NAME = /^(__proto__|constructor|prototype|con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * Agent names end up in file paths, pipe names and @mentions, so they are limited
 * to the characters a mention can carry.
 */
export function isValidAgentName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name) && !RESERVED_NAMES.has(name) && !UNSAFE_NAME.test(name);
}

export function agentNameFromSpec(spec: string): string {
  return parseAgentSpec(spec).name;
}

export function agentCwdFromSpec(spec: string, fallback: string): string {
  const cwd = parseAgentSpec(spec).cwd;
  return cwd ? path.resolve(cwd) : fallback;
}

/** The model segment overrides the global `--model` for this agent (heterogeneous fleets). */
export function agentModelFromSpec(spec: string): string | undefined {
  return parseAgentSpec(spec).model;
}

/** Role preset (planner/implementer/reviewer/supervisor) — injects a role-specific prompt. */
export function agentRoleFromSpec(spec: string): string | undefined {
  return parseAgentSpec(spec).role;
}