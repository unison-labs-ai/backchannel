#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  DEFAULT_RELAY_URL,
  loadConfig,
  openSpool,
  optionalAgent,
  requireAgent,
  saveConfig,
} from "./config.ts";
import { HttpSpool } from "./http-spool.ts";
import { startRelay } from "./relay.ts";
import { runMcpServer } from "./mcp.ts";
import type { Message, Priority } from "./types.ts";
import { matchesScope } from "./types.ts";
import { decodeInvite, encodeInvite, shareInstructions } from "./invite.ts";
import { runSetup } from "./setup.ts";

const HELP = `bch — backchannel: async messaging for AI agents

Usage:
  bch room new [#channel]... [--url <relay-url>]   create a room; prints the join command to send a teammate
  bch init <name> [--url <relay-url>] [--token <token>]   create/claim this machine's agent identity
        [--brain] [--brain-token <usk_...>] [--brain-room <slug>] [--brain-url <url>]
  bch invite [--url <relay-url>] --token <room-token> [--channel <#name>]...   print a join command for a self-hosted single-room relay
  bch join <invite> --as <name> [--no-hooks] [--wake]   accept invite + auto-setup harness hooks (--wake adds the notification daemon)
  bch setup [--no-hooks] [--wake]   (re)install harness hooks & MCP config (--wake adds the notification daemon)
  bch send <@agent|#channel> <message> [--urgent] [--scope <repo-or-topic>] [--thread <id>] [--ref <path-or-url>]...
  bch inbox [--json] [--brief] [--match <scope>]          list unread (does not claim)
  bch drain [--json] [--hook] [--match <scope>]           atomically claim and print matching unread
  bch read <id> [--keep]                                  print one message and claim it
  bch watch [--exec <cmd>] [--urgent-only] [--match <scope>] [--peek]  stream messages; --peek observes without claiming

Scopes: a message sent with --scope is only claimed by readers whose --match
contains it (e.g. --scope myrepo matches --match github.com/org/myrepo).
Unscoped messages match every reader; first claim wins.
  bch sub <#channel> | bch unsub <#channel>               manage channel subscriptions
  bch agents | bch channels | bch whoami                  directory
  bch relay [--port 7117] [--token <token>]               run a relay for cross-machine messaging
  bch mcp                                                 run the MCP stdio server

Backends (default: local spool in ~/.backchannel):
  local   zero-config, single machine                   (default)
  relay   hosted or self-hosted HTTP relay              bch room new / --url / BACKCHANNEL_URL
  brain   hosted Unison brain, messages become memory   --brain / BACKCHANNEL_BACKEND=brain

The hosted relay (${DEFAULT_RELAY_URL}) backs \`bch room new\` by default.
Self-host: run \`bch relay\`, then \`bch room new --url https://your-relay\` or set
BACKCHANNEL_DEFAULT_RELAY to point every \`room new\` at your own instance.

Templates for --exec: {{body}} {{from}} {{to}} {{id}} {{priority}}
Identity/transport env overrides: BACKCHANNEL_AGENT, BACKCHANNEL_URL, BACKCHANNEL_TOKEN, BACKCHANNEL_HOME
Brain backend env: BACKCHANNEL_BACKEND=brain, UNISON_TOKEN, BACKCHANNEL_ROOM, UNISON_API_URL`;

function fmt(msg: Message, brief = false): string {
  const flag = msg.priority === "urgent" ? " [URGENT]" : "";
  const head = `${msg.from} -> ${msg.to}${flag} (${msg.ts}, id ${msg.id.slice(0, 8)})`;
  if (brief) {
    const oneLine = msg.body.replace(/\s+/g, " ");
    return `${head}: ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`;
  }
  const scope = msg.scope ? `\n  scope: ${msg.scope}` : "";
  const refs = msg.refs?.length ? `\n  refs: ${msg.refs.join(", ")}` : "";
  const thread = msg.thread ? `\n  thread: ${msg.thread}` : "";
  return `${head}${scope}${thread}${refs}\n${msg.body}`;
}

function render(template: string, msg: Message): string {
  return template
    .replaceAll("{{body}}", msg.body)
    .replaceAll("{{from}}", msg.from)
    .replaceAll("{{to}}", msg.to)
    .replaceAll("{{id}}", msg.id)
    .replaceAll("{{priority}}", msg.priority);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const config = await loadConfig();

  switch (command) {
    case "init": {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          url: { type: "string" },
          token: { type: "string" },
          brain: { type: "boolean", default: false },
          "brain-token": { type: "string" },
          "brain-room": { type: "string" },
          "brain-url": { type: "string" },
        },
      });
      const name = positionals[0];
      if (!name) throw new Error("usage: bch init <name> [--url <relay-url>] [--token <token>]");
      const useBrain =
        values.brain ||
        values["brain-token"] !== undefined ||
        values["brain-room"] !== undefined ||
        process.env.BACKCHANNEL_BACKEND === "brain" ||
        config.backend === "brain";
      const next: import("./config.ts").Config = {
        agent: name,
        url: values.url ?? config.url,
        token: values.token ?? config.token,
        ...(useBrain
          ? {
              backend: "brain" as const,
              brainToken: values["brain-token"] ?? config.brainToken,
              brainRoom: values["brain-room"] ?? config.brainRoom,
              brainUrl: values["brain-url"] ?? config.brainUrl,
            }
          : {}),
      };
      const record = await openSpool(next).register(name);
      if (record.token) next.token = record.token;
      await saveConfig(next);
      const transport = useBrain
        ? `brain (room: ${next.brainRoom ?? process.env.BACKCHANNEL_ROOM ?? "default"})`
        : (next.url ?? "local spool");
      console.log(`registered as "${record.name}" (${transport})`);
      if (record.token) console.log("agent token issued and saved to config — the room token is no longer needed here");
      return;
    }

    case "invite": {
      const { values } = parseArgs({
        args: rest,
        options: {
          url: { type: "string" },
          token: { type: "string" },
          channel: { type: "string", multiple: true },
          out: { type: "string" },
        },
      });
      const url = values.url ?? process.env.BACKCHANNEL_URL ?? config.url;
      if (!url) throw new Error("usage: bch invite --url <relay-url> --token <room-token> [--channel <#name>]...");
      if (!values.token) throw new Error("--token <room-token> required (the relay's --token; personal tokens can't admit others)");
      const invite = encodeInvite({ url, token: values.token, channels: values.channel });
      console.log(shareInstructions(invite, "invite created"));
      return;
    }

    case "room": {
      const sub = rest[0];
      if (sub !== "new") throw new Error("usage: bch room new [#channel]... [--url <relay>]");
      const { positionals, values } = parseArgs({
        args: rest.slice(1),
        allowPositionals: true,
        options: {
          url: { type: "string" },
          channel: { type: "string", multiple: true },
        },
      });
      const url = values.url ?? process.env.BACKCHANNEL_URL ?? config.url ?? DEFAULT_RELAY_URL;
      const channels = [...positionals, ...(values.channel ?? [])].map((c) => (c.startsWith("#") ? c : `#${c}`));
      const { roomId, roomToken } = await new HttpSpool(url).createRoom();
      const invite = encodeInvite({ url, token: roomToken, room: roomId, channels: channels.length ? channels : undefined });
      console.log(shareInstructions(invite, `room "${roomId}" created`));
      return;
    }

    case "join": {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          as: { type: "string" },
          "no-hooks": { type: "boolean", default: false },
          wake: { type: "boolean", default: false },
        },
      });
      const inviteStr = positionals[0];
      if (!inviteStr || !values.as) throw new Error("usage: bch join <invite> --as <agent-name>");
      const invite = decodeInvite(inviteStr);

      const next: import("./config.ts").Config = { agent: values.as, url: invite.url, token: invite.token, room: invite.room };
      const spool = openSpool(next);
      const record = await spool.register(values.as);
      if (record.token) next.token = record.token;
      await saveConfig(next);
      console.log(`joined ${invite.url}${invite.room ? ` (room ${invite.room})` : ""} as "${values.as}"${record.token ? " (personal token saved)" : ""}`);

      for (const channel of invite.channels ?? []) {
        await openSpool(next).subscribe(values.as, channel);
        console.log(`subscribed to ${channel}`);
      }

      const results = await runSetup({
        hooks: !values["no-hooks"],
        wake: values.wake,
      });
      for (const r of results) console.log(`[${r.harness}] ${r.action}`);
      console.log(`\nready — try: bch send @<someone> "hello from ${values.as}"`);
      return;
    }

    case "setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "no-hooks": { type: "boolean", default: false },
          wake: { type: "boolean", default: false },
        },
      });
      requireAgent(config);
      const results = await runSetup({
        hooks: !values["no-hooks"],
        wake: values.wake,
      });
      for (const r of results) console.log(`[${r.harness}] ${r.action}`);
      return;
    }

    case "send": {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          urgent: { type: "boolean", default: false },
          scope: { type: "string" },
          thread: { type: "string" },
          ref: { type: "string", multiple: true },
        },
      });
      const [to, ...words] = positionals;
      const body = words.join(" ");
      if (!to || !body) throw new Error("usage: bch send <@agent|#channel> <message>");
      const msg = await openSpool(config).send(requireAgent(config), to, body, {
        priority: (values.urgent ? "urgent" : "normal") as Priority,
        scope: values.scope,
        thread: values.thread,
        refs: values.ref,
      });
      console.log(`sent ${msg.id.slice(0, 8)} to ${to}`);
      return;
    }

    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: {
          json: { type: "boolean", default: false },
          brief: { type: "boolean", default: false },
          match: { type: "string" },
        },
      });
      const all = await openSpool(config).inbox(requireAgent(config));
      const messages = values.match ? all.filter((m) => matchesScope(m, values.match)) : all;
      if (values.json) console.log(JSON.stringify(messages, null, 2));
      else if (messages.length === 0) console.log("inbox empty");
      else for (const m of messages) console.log(fmt(m, values.brief));
      return;
    }

    case "drain": {
      const { values } = parseArgs({
        args: rest,
        options: {
          json: { type: "boolean", default: false },
          hook: { type: "boolean", default: false },
          match: { type: "string" },
        },
      });
      // Hook mode is a silent background drain installed globally; when this
      // repo/session has no identity there is simply nothing to drain, so exit
      // 0 quietly instead of erroring on every prompt. Interactive use still
      // gets the helpful "run `bch init`" message.
      const agent = values.hook ? optionalAgent(config) : requireAgent(config);
      if (!agent) return;
      const spool = openSpool(config);
      const claimed: Message[] = [];
      for (const m of await spool.inbox(agent)) {
        if (!matchesScope(m, values.match)) continue;
        const taken = await spool.take(agent, m.id);
        if (taken) claimed.push(taken);
      }
      if (claimed.length === 0) {
        if (values.json) console.log("[]");
        else if (!values.hook) console.log("inbox empty");
        return;
      }
      if (values.json) console.log(JSON.stringify(claimed, null, 2));
      else {
        if (values.hook) console.log(`[backchannel] ${claimed.length} message(s) for ${agent}:`);
        for (const m of claimed) console.log(fmt(m));
      }
      return;
    }

    case "read": {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { keep: { type: "boolean", default: false } },
      });
      const prefix = positionals[0];
      if (!prefix) throw new Error("usage: bch read <id> [--keep]");
      const spool = openSpool(config);
      const agent = requireAgent(config);
      const found = (await spool.inbox(agent)).find((m) => m.id.startsWith(prefix));
      if (!found) throw new Error(`no unread message with id ${prefix}`);
      const msg = await spool.take(agent, found.id, values.keep);
      if (!msg) throw new Error(`message ${prefix} was claimed by another session`);
      console.log(fmt(msg));
      return;
    }

    case "watch": {
      const { values } = parseArgs({
        args: rest,
        options: {
          exec: { type: "string" },
          "urgent-only": { type: "boolean", default: false },
          match: { type: "string" },
          peek: { type: "boolean", default: false },
        },
      });
      const spool = openSpool(config);
      const agent = requireAgent(config);
      console.error(`watching inbox for ${agent}${values.peek ? " (peek: messages stay queued)" : ""} (ctrl-c to stop)`);
      spool.watch(agent, (msg) => {
        void (async () => {
          if (values["urgent-only"] && msg.priority !== "urgent") return;
          if (values.peek) {
            if (values.match && !matchesScope(msg, values.match)) return;
          } else {
            if (!matchesScope(msg, values.match)) return;
          }
          let delivered = msg;
          if (!values.peek) {
            const taken = await spool.take(agent, msg.id);
            if (!taken) return;
            delivered = taken;
          }
          console.log(fmt(delivered, true));
          if (values.exec) {
            const proc = Bun.spawn(["sh", "-c", render(values.exec, delivered)], {
              stdout: "inherit",
              stderr: "inherit",
            });
            await proc.exited;
          }
        })();
      });
      await new Promise(() => {});
      return;
    }

    case "sub":
    case "unsub": {
      const channel = rest[0];
      if (!channel) throw new Error(`usage: bch ${command} <#channel>`);
      const spool = openSpool(config);
      const agent = requireAgent(config);
      if (command === "sub") await spool.subscribe(agent, channel);
      else await spool.unsubscribe(agent, channel);
      console.log(`${command === "sub" ? "subscribed to" : "unsubscribed from"} ${channel}`);
      return;
    }

    case "agents": {
      for (const a of await openSpool(config).agents()) {
        const subs = a.subscriptions.length ? ` (${a.subscriptions.join(", ")})` : "";
        console.log(`${a.name}${subs} — last seen ${a.lastSeen}`);
      }
      return;
    }

    case "channels": {
      const channels = await openSpool(config).channels();
      console.log(channels.length ? channels.join("\n") : "no channels yet — `bch sub #general` to create one");
      return;
    }

    case "whoami": {
      const agent = requireAgent(config);
      const backend = process.env.BACKCHANNEL_BACKEND ?? config.backend;
      let transport: string;
      if (backend === "brain") {
        const room = process.env.BACKCHANNEL_ROOM ?? config.brainRoom ?? "default";
        transport = `brain (room: ${room}, ${process.env.UNISON_API_URL ?? config.brainUrl ?? "https://brain.unisonlabs.ai"})`;
      } else {
        transport = process.env.BACKCHANNEL_URL ?? config.url ?? "local spool";
      }
      console.log(`${agent} via ${transport}`);
      return;
    }

    case "relay": {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string", default: "7117" }, token: { type: "string" } },
      });
      const server = startRelay({ port: Number(values.port), token: values.token });
      console.log(`backchannel relay listening on ${server.url}`);
      await new Promise(() => {});
      return;
    }

    case "mcp": {
      await runMcpServer();
      return;
    }

    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;

    default:
      throw new Error(`unknown command "${command}" — run \`bch help\``);
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
