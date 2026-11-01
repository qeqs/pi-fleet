/**
 * pi's own model files, so a provider added here also works in plain pi, and the other
 * way round. Keys go in, but never come back out: the GUI only learns whether one is set.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ProviderInput {
  name: string;
  baseUrl: string;
  /** Empty keeps the key already saved, or sets a placeholder for a local server. */
  apiKey?: string;
  models: string[];
}

export interface ProviderView {
  name: string;
  baseUrl?: string;
  models: string[];
  hasKey: boolean;
}

interface ModelsFile {
  providers?: Record<string, { baseUrl?: string; apiKey?: string; api?: string; models?: { id: string }[] }>;
}

const agentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const modelsFile = (): string => path.join(agentDir(), "models.json");
const authFile = (): string => path.join(agentDir(), "auth.json");

/** A broken file is refused, not replaced: it holds keys that may exist nowhere else. */
function readJson<T>(file: string): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${file} is not valid JSON: fix it first, so nothing in it is lost`);
  }
}

function writePrivate(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.tmp`;
  fs.writeFileSync(next, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(next, file);
}

export function listProviders(): ProviderView[] {
  const { providers = {} } = readJson<ModelsFile>(modelsFile());
  return Object.entries(providers).map(([name, p]) => ({ name, baseUrl: p.baseUrl, models: (p.models ?? []).map((m) => m.id), hasKey: !!p.apiKey }));
}

/** Add a server that speaks the OpenAI API, or update the one with this name. */
export function saveProvider(input: ProviderInput): void {
  if (!/^[A-Za-z0-9_-]+$/.test(input.name)) throw new Error("a provider name can use letters, digits, \"_\" and \"-\"");
  if (!/^https?:\/\/\S+$/.test(input.baseUrl)) throw new Error("the address must start with http:// or https://");
  const ids = input.models.map((m) => m.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("name at least one model");
  const file = readJson<ModelsFile>(modelsFile());
  const providers = file.providers ?? {};
  const known = providers[input.name];
  providers[input.name] = {
    ...known,
    baseUrl: input.baseUrl,
    api: known?.api ?? "openai-completions",
    apiKey: input.apiKey || known?.apiKey || "none", // pi hides a provider with no key at all
    models: ids.map((id) => known?.models?.find((m) => m.id === id) ?? { id }),
  };
  writePrivate(modelsFile(), { ...file, providers });
}

/** Save a key for a provider pi already knows, such as anthropic or openai. */
export function saveApiKey(provider: string, key: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) throw new Error("that does not look like a provider name");
  if (!key.trim()) throw new Error("the key is empty");
  writePrivate(authFile(), { ...readJson<Record<string, unknown>>(authFile()), [provider]: { type: "api_key", key: key.trim() } });
}
