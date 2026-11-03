import { describe, expect, it } from "vitest";
import { answerText, askInDialogs, declinedAll, OWN_ANSWER, questionsIn, type AskedQuestion } from "../src/extension/ask-user.ts";

const direction: AskedQuestion = {
  question: "Which direction?",
  header: "Next work",
  options: [
    { label: "Prompt caching", description: "Most tokens are context sent again." },
    { label: "Marketplace", description: "Install pi extensions from the GUI." },
  ],
};
const parts: AskedQuestion = { question: "Which parts?", options: [{ label: "GUI" }, { label: "CLI" }, { label: "Docs" }], multiSelect: true };

/** Dialogs that give these replies in order, and keep what they were asked. */
function person(...replies: (string | undefined)[]) {
  const asked: { method: string; title: string; options?: string[] }[] = [];
  const reply = async () => replies.shift();
  return {
    asked,
    select: (title: string, options: string[]) => (asked.push({ method: "select", title, options }), reply()),
    input: (title: string) => (asked.push({ method: "input", title }), reply()),
  };
}

describe("ask_user questions", () => {
  it("reads the questions only in the shape pix-ask takes", () => {
    expect(questionsIn({ questions: [direction] })).toEqual([direction]);
    for (const input of [undefined, {}, { questions: [] }, { questions: [{ question: "Why?" }] }, { questions: [{ question: "Why?", options: [{ text: "x" }] }] }]) {
      expect(questionsIn(input)).toBeUndefined();
    }
  });

  it("knows a result where every question was turned down", () => {
    expect(declinedAll({ answers: [], cancelled: true })).toBe(true);
    expect(declinedAll({ answers: [{ questionIndex: 0 }], cancelled: true })).toBe(false);
    expect(declinedAll({ answers: [], cancelled: false })).toBe(false);
    expect(declinedAll(undefined)).toBe(false);
  });

  it("offers each choice with what it means, and the person's own words", async () => {
    const ui = person("Marketplace — Install pi extensions from the GUI.");
    const result = await askInDialogs(ui, [direction]);
    expect(ui.asked[0]).toEqual({
      method: "select",
      title: "Next work: Which direction?",
      options: ["Prompt caching — Most tokens are context sent again.", "Marketplace — Install pi extensions from the GUI.", OWN_ANSWER],
    });
    expect(result).toEqual({ answers: [{ questionIndex: 0, question: "Which direction?", kind: "option", answer: "Marketplace" }], cancelled: false });
    expect(answerText(result, [direction])).toBe('User answered: "Which direction?"="Marketplace".');
  });

  it("takes an answer in the person's own words", async () => {
    const ui = person(OWN_ANSWER, "Both, caching first");
    const result = await askInDialogs(ui, [direction]);
    expect(ui.asked[1]).toEqual({ method: "input", title: "Which direction?" });
    expect(answerText(result, [direction])).toBe('User answered: "Which direction?"="Both, caching first".');
  });

  it("takes several choices by number or name", async () => {
    const ui = person(" 3, gui,1, 9");
    const result = await askInDialogs(ui, [parts]);
    expect(ui.asked[0].title).toContain("1. GUI\n2. CLI\n3. Docs");
    expect(answerText(result, [parts])).toBe('User answered: "Which parts?"="Docs, GUI".');
  });

  it("keeps the answers given before the person dismissed the rest", async () => {
    const result = await askInDialogs(person("Prompt caching — Most tokens are context sent again.", undefined), [direction, parts]);
    expect(result.cancelled).toBe(true);
    expect(answerText(result, [direction, parts])).toBe('User answered: "Which direction?"="Prompt caching". Unanswered: "Which parts?".');
  });

  it("says so when the person answers nothing", async () => {
    for (const reply of [undefined, "none of these"]) {
      const result = await askInDialogs(person(reply), [parts]);
      expect(answerText(result, [parts])).toBe("User cancelled the questionnaire");
    }
  });
});
