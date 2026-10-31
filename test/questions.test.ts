import { describe, it, expect } from "vitest";
import { describeQuestion, parseAnswer, questionFrom, type Question } from "../src/questions.ts";

const confirm: Question = { id: "1", agent: "a", method: "confirm", title: "Delete?", message: "all of it" };
const select: Question = { id: "2", agent: "a", method: "select", title: "Pick", options: ["Red", "Green"] };
const input: Question = { id: "3", agent: "a", method: "input", title: "Name" };

describe("questionFrom", () => {
  it("reads a dialog request", () => {
    const q = questionFrom("alice", { type: "extension_ui_request", id: "9", method: "select", title: "Pick", options: ["a", "b"], timeout: 500 });
    expect(q).toEqual({ id: "9", agent: "alice", method: "select", title: "Pick", options: ["a", "b"], timeout: 500 });
  });

  it("ignores fire-and-forget requests, which need no answer", () => {
    for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) {
      expect(questionFrom("alice", { id: "9", method })).toBeNull();
    }
  });
});

describe("describeQuestion", () => {
  it("says what kind of answer is expected", () => {
    expect(describeQuestion(confirm)).toBe("Delete?: all of it (yes/no)");
    expect(describeQuestion(select)).toBe("Pick (Red / Green)");
    expect(describeQuestion(input)).toBe("Name");
  });
});

describe("parseAnswer", () => {
  it("reads yes and no", () => {
    for (const yes of ["y", "YES", "ok", "allow"]) expect(parseAnswer(confirm, yes)).toEqual({ confirmed: true });
    for (const no of ["n", "No", "deny"]) expect(parseAnswer(confirm, no)).toEqual({ confirmed: false });
  });

  it("refuses anything else for a yes/no question", () => {
    expect(() => parseAnswer(confirm, "maybe")).toThrow('answer yes or no, got "maybe"');
  });

  it("matches a choice by name, ignoring case, or by number", () => {
    expect(parseAnswer(select, "green")).toEqual({ value: "Green" });
    expect(parseAnswer(select, "1")).toEqual({ value: "Red" });
  });

  it("refuses a choice that is not on the list, listing what is", () => {
    expect(() => parseAnswer(select, "blue")).toThrow("pick one of: Red, Green");
  });

  it("takes free text as it is", () => {
    expect(parseAnswer(input, "any text at all")).toEqual({ value: "any text at all" });
  });
});
