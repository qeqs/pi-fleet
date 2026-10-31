/**
 * Fleet templates — named presets that expand to a set of agents.
 *
 * `fleet up --template sdlc` is sugar for a set of `--agent` flags, so you can
 * spin up a common crew in one word. Templates are defined here; each is a list
 * of agent configs (same shape as fleet.json agents). A per-agent `model` is
 * optional — when omitted the fleet's default model is used.
 */
import type { FleetAgentConfig } from "./config.ts";

export interface FleetTemplate {
  description: string;
  agents: FleetAgentConfig[];
}

export const TEMPLATES: Record<string, FleetTemplate> = {
  sdlc: {
    description: "Full SDLC crew: planner + implementer + reviewer",
    agents: [
      { name: "planner", role: "planner" },
      { name: "implementer", role: "implementer" },
      { name: "reviewer", role: "reviewer" },
    ],
  },
  pair: {
    description: "Implementer + reviewer (no planner)",
    agents: [
      { name: "implementer", role: "implementer" },
      { name: "reviewer", role: "reviewer" },
    ],
  },
  solo: {
    description: "A single general implementer",
    agents: [{ name: "worker", role: "implementer" }],
  },
};

/** Expand a template name to its agents, or null if unknown. */
export function expandTemplate(name: string): FleetAgentConfig[] | null {
  return TEMPLATES[name]?.agents ?? null;
}

export function templateNames(): string[] {
  return Object.keys(TEMPLATES);
}

export function templateDescription(name: string): string {
  return TEMPLATES[name]?.description ?? "";
}