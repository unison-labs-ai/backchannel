#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { loadConfig, openSpool, requireAgent, saveConfig } from "./config.ts";
import { startRelay } from "./relay.ts";
import { runMcpServer } from "./mcp.ts";
import type { Message, Priority } from "./types.ts";

const HELP = `bch — backchannel: async messaging for AI agents

Usage:
  bch init <name> [--url <relay-url>] [--token <token>]   create/claim this machine's agent identity
  bch send <@agent|#channel> <message> [--urgent] [--thread <id>] [--ref <path-or-url>]...
  bch inbox [--json] [--brief]                            list unread (does not ack)
  bch drain [--json] [--hook]                             print all unread and ack them
  bch read <id> [--keep]                                  print one message and ack it
  bch watch [--exec <cmd>] [--urgent-only]                stream messages; optionally run cmd per message
  bch sub <#channel> | bch unsub <#channel>               manage channel subscriptions
  bch agents | bch channels | bch whoami                  directory
  bch relay [--port 7117] [--token <token>]               run a relay for cross-machine messaging
  bch mcp                                                 run the MCP stdio server

Templates for --exec: {{body}} {{from}} {{to}} {{id}} {{priority}}
Identity/transport env overrides: BACKCHANNEL_AGENT, BACKCHANNEL_URL, BACKCHANNEL_TOKEN, BACKCHANNEL_HOME`;

function fmt(msg: Message, brief = false): string {
  const flag = msg.priority === "urgent" ? " [URGENT]" : "";
  const head = `${msg.from} -> ${msg.to}${flag} (${msg.ts}, id ${msg.id.slice(0, 8)})`;
  if (brief) {
    const oneLine = msg.body.replace(/\s+/g, " ");
    return `${head}: ${oneLine.length > 120 ? `${oneLine.slice(0, 120)}…` : oneLine}`;
  }
  const refs = msg.refs?.length ? `\n  refs: ${msg.refs.join(", ")}` : "";
  const thread = msg.thread ? `\n  thread: ${msg.thread}` : "";
  return `${head}${thread}${refs}\n${msg.body}`;
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
        options: { url: { type: "string" }, token: { type: "string" } },
      });
      const name = positionals[0];
      if (!name) throw new Error("usage: bch init <name> [--url <relay-url>] [--token <token>]");
      const next = { agent: name, url: values.url ?? config.url, token: values.token ?? config.token };
      await saveConfig(next);
      const record = await openSpool(next).register(name);
      console.log(`registered as "${record.name}" (${next.url ?? "local spool"})`);
      return;
    }

    case "send": {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          urgent: { type: "boolean", default: false },
          thread: { type: "string" },
          ref: { type: "string", multiple: true },
        },
      });
      const [to, ...words] = positionals;
      const body = words.join(" ");
      if (!to || !body) throw new Error("usage: bch send <@agent|#channel> <message>");
      const msg = await openSpool(config).send(requireAgent(config), to, body, {
        priority: (values.urgent ? "urgent" : "normal") as Priority,
        thread: values.thread,
        refs: values.ref,
      });
      console.log(`sent ${msg.id.slice(0, 8)} to ${to}`);
      return;
    }

    case "inbox": {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: "boolean", default: false }, brief: { type: "boolean", default: false } },
      });
      const messages = await openSpool(config).inbox(requireAgent(config));
      if (values.json) console.log(JSON.stringify(messages, null, 2));
      else if (messages.length === 0) console.log("inbox empty");
      else for (const m of messages) console.log(fmt(m, values.brief));
      return;
    }

    case "drain": {
      const { values } = parseArgs({
        args: rest,
        options: { json: { type: "boolean", default: false }, hook: { type: "boolean", default: false } },
      });
      const spool = openSpool(config);
      const agent = requireAgent(config);
      const messages = await spool.inbox(agent);
      if (messages.length === 0) {
        if (!values.hook) console.log("inbox empty");
        return;
      }
      if (values.json) console.log(JSON.stringify(messages, null, 2));
      else {
        if (values.hook) console.log(`[backchannel] ${messages.length} message(s) for ${agent}:`);
        for (const m of messages) console.log(fmt(m));
      }
      for (const m of messages) await spool.ack(agent, m.id);
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
      const msg = (await spool.inbox(agent)).find((m) => m.id.startsWith(prefix));
      if (!msg) throw new Error(`no unread message with id ${prefix}`);
      console.log(fmt(msg));
      await spool.ack(agent, msg.id, values.keep);
      return;
    }

    case "watch": {
      const { values } = parseArgs({
        args: rest,
        options: {
          exec: { type: "string" },
          "urgent-only": { type: "boolean", default: false },
        },
      });
      const spool = openSpool(config);
      const agent = requireAgent(config);
      console.error(`watching inbox for ${agent} (ctrl-c to stop)`);
      spool.watch(agent, (msg) => {
        void (async () => {
          if (values["urgent-only"] && msg.priority !== "urgent") return;
          console.log(fmt(msg, true));
          if (values.exec) {
            const proc = Bun.spawn(["sh", "-c", render(values.exec, msg)], {
              stdout: "inherit",
              stderr: "inherit",
            });
            await proc.exited;
          }
          await spool.ack(agent, msg.id);
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
      console.log(`${agent} via ${process.env.BACKCHANNEL_URL ?? config.url ?? "local spool"}`);
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
