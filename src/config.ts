import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { defaultRoot, FsSpool } from "./fs-spool.ts";
import { HttpSpool } from "./http-spool.ts";
import { BrainSpool } from "./brain-spool.ts";
import type { Spool } from "./types.ts";

export interface Config {
  agent?: string;
  url?: string;
  token?: string;
  backend?: "fs" | "relay" | "brain";
  brainToken?: string;
  brainUrl?: string;
  brainRoom?: string;
}

function configPath(): string {
  return join(defaultRoot(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return {};
  return (await file.json()) as Config;
}

export async function saveConfig(config: Config): Promise<void> {
  mkdirSync(defaultRoot(), { recursive: true });
  await Bun.write(configPath(), JSON.stringify(config, null, 2));
}

export function openSpool(config: Config): Spool {
  const backend = process.env.BACKCHANNEL_BACKEND ?? config.backend;

  if (backend === "brain") {
    const token = process.env.UNISON_TOKEN ?? config.brainToken;
    if (!token) throw new Error("brain backend requires UNISON_TOKEN (or brainToken in config)");
    const room = process.env.BACKCHANNEL_ROOM ?? config.brainRoom ?? "default";
    return new BrainSpool({
      token,
      baseUrl: process.env.UNISON_API_URL ?? config.brainUrl,
      room,
    });
  }

  const url = process.env.BACKCHANNEL_URL ?? config.url;
  const token = process.env.BACKCHANNEL_TOKEN ?? config.token;
  if (url) return new HttpSpool(url, token);
  return new FsSpool();
}

export function requireAgent(config: Config): string {
  const agent = process.env.BACKCHANNEL_AGENT ?? config.agent;
  if (!agent) {
    throw new Error("no agent identity — run `bch init <name>` first (or set BACKCHANNEL_AGENT)");
  }
  return agent;
}
