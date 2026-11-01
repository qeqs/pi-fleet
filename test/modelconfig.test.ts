import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listProviders, saveApiKey, saveProvider } from "../src/modelconfig.ts";
import { isLoopback } from "../src/gui.ts";

let dir: string;
const previous = process.env.PI_CODING_AGENT_DIR;
const models = () => JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
const local = { name: "ollama", baseUrl: "http://localhost:11434/v1", models: ["qwen3:8b"] };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-models-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("saveProvider", () => {
  it("writes what pi needs to use a local server", () => {
    saveProvider(local);
    expect(models().providers.ollama).toMatchObject({ baseUrl: local.baseUrl, api: "openai-completions", apiKey: "none", models: [{ id: "qwen3:8b" }] });
  });

  it("leaves other providers and settings alone", () => {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ $schema: "x", providers: { mine: { baseUrl: "http://a", models: [{ id: "m" }] } } }));
    saveProvider(local);
    expect(models().$schema).toBe("x");
    expect(models().providers.mine.models).toEqual([{ id: "m" }]);
  });

  it("keeps the saved key and a model's settings when a provider is updated", () => {
    fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ providers: { ollama: { apiKey: "secret", api: "openai-responses", models: [{ id: "qwen3:8b", contextWindow: 4096 }] } } }));
    saveProvider({ ...local, models: ["qwen3:8b", "other"] });
    expect(models().providers.ollama).toMatchObject({ apiKey: "secret", api: "openai-responses", models: [{ id: "qwen3:8b", contextWindow: 4096 }, { id: "other" }] });
  });

  it("refuses a broken file instead of replacing it", () => {
    fs.writeFileSync(path.join(dir, "models.json"), "{ broken");
    expect(() => saveProvider(local)).toThrow("is not valid JSON");
    expect(fs.readFileSync(path.join(dir, "models.json"), "utf8")).toBe("{ broken");
  });

  it.each([
    ["a bad name", { ...local, name: "no spaces" }, "provider name"],
    ["a bad address", { ...local, baseUrl: "localhost:11434" }, "http://"],
    ["no models", { ...local, models: [" "] }, "at least one model"],
  ])("refuses %s", (_label, input, message) => {
    expect(() => saveProvider(input)).toThrow(message);
  });
});

describe("listProviders", () => {
  it("says whether a key is set, and never what it is", () => {
    saveProvider({ ...local, apiKey: "secret" });
    expect(listProviders()).toEqual([{ name: "ollama", baseUrl: local.baseUrl, models: ["qwen3:8b"], hasKey: true }]);
    expect(JSON.stringify(listProviders())).not.toContain("secret");
  });

  it("is empty before anything is set up", () => {
    expect(listProviders()).toEqual([]);
  });
});

describe("saveApiKey", () => {
  const auth = () => JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));

  it("adds a key next to any there already", () => {
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ openai: { type: "oauth", refresh: "r" } }));
    saveApiKey("anthropic", " sk-1 ");
    expect(auth()).toEqual({ openai: { type: "oauth", refresh: "r" }, anthropic: { type: "api_key", key: "sk-1" } });
  });

  it("refuses an empty key", () => {
    expect(() => saveApiKey("anthropic", "  ")).toThrow("the key is empty");
  });

  it.skipIf(process.platform === "win32")("keeps keys private to their owner", () => {
    saveApiKey("anthropic", "sk-1");
    expect(fs.statSync(path.join(dir, "auth.json")).mode & 0o777).toBe(0o600);
  });
});

describe("isLoopback", () => {
  it("knows this machine from any other", () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopback(address)).toBe(true);
    for (const address of ["192.168.1.5", undefined]) expect(isLoopback(address)).toBe(false);
  });
});
