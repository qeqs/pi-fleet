/**
 * `ask_user` from the pix-ask package draws its questionnaire with `ctx.ui.custom`, which
 * pi's RPC mode answers at once with nothing. In a fleet every question came back
 * "User cancelled the questionnaire" a millisecond later, and the person never saw it.
 * These ask the same questions as plain dialogs, which reach the person in the GUI and
 * the terminal, and answer the model in the words pix-ask uses.
 */

export interface AskedQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface AskAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "multi";
  answer: string | null;
  selected?: string[];
}

export interface Questionnaire {
  answers: AskAnswer[];
  cancelled: boolean;
}

interface Dialogs {
  select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/** The last choice of every single-choice question. */
export const OWN_ANSWER = "Answer in my own words";

/** The questions of an `ask_user` call, or undefined if they are not in the shape pix-ask takes. */
export function questionsIn(input: unknown): AskedQuestion[] | undefined {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const fits = questions.every(
    (q) =>
      typeof q?.question === "string" &&
      Array.isArray(q.options) &&
      q.options.length > 0 &&
      q.options.every((o: { label?: unknown }) => typeof o?.label === "string"),
  );
  return fits ? (questions as AskedQuestion[]) : undefined;
}

/** A result that says the person turned every question down. */
export function declinedAll(details: unknown): boolean {
  const d = details as { answers?: unknown[]; cancelled?: unknown } | undefined;
  return d?.cancelled === true && (d.answers?.length ?? 0) === 0;
}

/** Ask each question in turn. Dismissing one keeps the answers so far and asks nothing more. */
export async function askInDialogs(ui: Dialogs, questions: AskedQuestion[], signal?: AbortSignal): Promise<Questionnaire> {
  const answers: AskAnswer[] = [];
  for (const [i, q] of questions.entries()) {
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    const choices = q.options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));
    if (q.multiSelect) {
      const list = choices.map((c, n) => `${n + 1}. ${c}`).join("\n");
      const typed = await ui.input(`${title}\n\n${list}\n\nType the numbers or names of your choices, separated by commas.`, "e.g. 1,3", { signal });
      const picked = (typed ?? "").split(",").map((s) => s.trim().toLowerCase()).map((s) => q.options.find((o, n) => s === String(n + 1) || s === o.label.toLowerCase())?.label);
      const selected = [...new Set(picked)].filter((label) => label !== undefined);
      if (selected.length === 0) return { answers, cancelled: true };
      answers.push({ questionIndex: i, question: q.question, kind: "multi", answer: null, selected });
      continue;
    }
    const chosen = await ui.select(title, [...choices, OWN_ANSWER], { signal });
    if (chosen === undefined) return { answers, cancelled: true };
    if (chosen !== OWN_ANSWER) {
      answers.push({ questionIndex: i, question: q.question, kind: "option", answer: q.options[choices.indexOf(chosen)]?.label ?? chosen });
      continue;
    }
    const own = await ui.input(q.question, "Your answer", { signal });
    if (own === undefined) return { answers, cancelled: true };
    answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: own });
  }
  return { answers, cancelled: false };
}

/** What the model reads, as pix-ask words it. */
export function answerText(result: Questionnaire, questions: AskedQuestion[]): string {
  if (result.answers.length === 0) return "User cancelled the questionnaire";
  const said = result.answers.map((a) => `"${a.question}"="${a.kind === "multi" ? (a.selected ?? []).join(", ") : a.answer}"`);
  const answered = new Set(result.answers.map((a) => a.questionIndex));
  const left = questions.flatMap((q, i) => (answered.has(i) ? [] : [`"${q.question}"`]));
  return `User answered: ${said.join(". ")}.${left.length ? ` Unanswered: ${left.join(", ")}.` : ""}`;
}
