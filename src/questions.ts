/**
 * Questions from agents to the human. pi's RPC mode turns `ctx.ui.confirm` and
 * friends into `extension_ui_request` events and blocks the agent until a matching
 * `extension_ui_response` arrives, so an unanswered question stops the agent forever.
 */

export interface Question {
  id: string;
  agent: string;
  method: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  /** pi gives up by itself after this long, if set. */
  timeout?: number;
}

/** The human's answer, in pi's terms. */
export type Answer = { value: string } | { confirmed: boolean } | { cancelled: true };

const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

/** The question in an RPC event, or null for the fire-and-forget ones (notify, setStatus...). */
export function questionFrom(agent: string, rec: Record<string, unknown>): Question | null {
  const method = String(rec.method);
  if (!DIALOGS.has(method)) return null;
  return {
    id: String(rec.id),
    agent,
    method: method as Question["method"],
    title: String(rec.title ?? "Question"),
    message: rec.message === undefined ? undefined : String(rec.message),
    options: Array.isArray(rec.options) ? rec.options.map(String) : undefined,
    placeholder: rec.placeholder === undefined ? undefined : String(rec.placeholder),
    prefill: rec.prefill === undefined ? undefined : String(rec.prefill),
    timeout: typeof rec.timeout === "number" ? rec.timeout : undefined,
  };
}

/** One line for the terminal and the bus. */
export function describeQuestion(q: Question): string {
  const choices = q.method === "confirm" ? " (yes/no)" : q.options ? ` (${q.options.join(" / ")})` : "";
  return `${q.title}${q.message ? `: ${q.message}` : ""}${choices}`;
}

/** Turn typed text into an answer. Throws, saying what is expected, if it does not fit. */
export function parseAnswer(q: Question, text: string): Answer {
  const typed = text.trim();
  if (q.method === "confirm") {
    if (/^(y|yes|ok|allow)$/i.test(typed)) return { confirmed: true };
    if (/^(n|no|deny)$/i.test(typed)) return { confirmed: false };
    throw new Error(`answer yes or no, got "${typed}"`);
  }
  if (q.method === "select") {
    const options = q.options ?? [];
    const match = options.find((o) => o.toLowerCase() === typed.toLowerCase()) ?? options[Number(typed) - 1];
    if (match === undefined) throw new Error(`pick one of: ${options.join(", ")}`);
    return { value: match };
  }
  return { value: text };
}
