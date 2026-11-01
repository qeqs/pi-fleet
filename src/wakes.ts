/**
 * Who a batch of new bus messages wakes, and with what text. The supervisor pushes
 * the result over RPC; keeping the decision here makes it testable without agents.
 */
import type { FleetMessage, Hub } from "./hub.ts";
import { admitMessage, formatInbox, mentionedAgents, routingPrompt, wakeDecision } from "./extension/index.ts";

/**
 * Applies the fleet's brake and the channel rules, and returns each woken agent's
 * accumulated wake text. A message for the dedicated router goes to `onRouting`
 * and wakes nobody. Without `onRouting`, channels fall back to agent routing.
 */
export function computeWakes(messages: FleetMessage[], hub: Hub, lookup: Map<string, FleetMessage>, maxHops: number, onRouting?: (m: FleetMessage) => void): Map<string, string> {
  const wakes = new Map<string, string>();
  if (messages.length === 0) return wakes;
  const channels = hub.readChannels();
  const agents = Object.values(hub.readAgents());
  for (const m of messages) {
    if (!admitMessage(m, hub, maxHops) || m.kind !== "chat") continue;
    const channel = channels.find((c) => c.name === m.to);
    if (channel) {
      if (mentionedAgents(m.text).some((a) => channel.members.includes(a))) {
        hub.noteInSummary(channel.name, `${m.from}: ${m.text}`); // goes straight to them, past the router
      } else if (onRouting && !channel.supervisor) {
        onRouting(m);
        continue;
      }
    }
    for (const { name } of agents) {
      if (m.from === name) continue; // never wake self
      const d = wakeDecision(m, name, lookup, channels);
      if (!d.wake) continue;
      const text = d.mode === "route" && d.channel ? routingPrompt(d.channel, m, agents) : formatInbox([m], lookup, channels);
      wakes.set(name, wakes.has(name) ? `${wakes.get(name)}\n\n${text}` : text);
    }
  }
  return wakes;
}
