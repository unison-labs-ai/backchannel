import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, openSpool, requireAgent } from "./config.ts";
import { matchesScope } from "./types.ts";

export async function runMcpServer(): Promise<void> {
  const config = await loadConfig();
  const spool = openSpool(config);
  const agent = requireAgent(config);

  const server = new McpServer({ name: "backchannel", version: "0.1.0" });

  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });

  server.tool(
    "bch_send",
    "Send a message to another agent (@name) or a channel (#name). Use priority 'urgent' only when the recipient should be woken immediately.",
    {
      target: z.string().describe("@agent or #channel"),
      body: z.string().describe("message body (markdown)"),
      priority: z.enum(["normal", "urgent"]).optional(),
      scope: z.string().optional().describe("route to sessions in this context only, e.g. a repo URL or project name"),
      thread: z.string().optional().describe("message id this replies to"),
      refs: z.array(z.string()).optional().describe("file paths or URLs the message refers to"),
    },
    async ({ target, body, priority, scope, thread, refs }) => {
      const msg = await spool.send(agent, target, body, { priority, scope, thread, refs });
      return text(`sent ${msg.id} to ${target}`);
    },
  );

  server.tool(
    "bch_inbox",
    "Claim and read unread messages for this agent. Claimed messages will not appear again — act on them or persist them. Pass match (e.g. the repo you are working in) to only claim messages scoped to your current context plus unscoped ones; other sessions' scoped messages stay queued for them.",
    { match: z.string().optional().describe("current work context, e.g. git remote URL or repo path") },
    async ({ match }) => {
      const claimed = [];
      for (const m of await spool.inbox(agent)) {
        if (!matchesScope(m, match)) continue;
        const taken = await spool.take(agent, m.id);
        if (taken) claimed.push(taken);
      }
      return text(claimed.length ? claimed : "inbox empty");
    },
  );

  server.tool(
    "bch_agents",
    "List known agents, their channel subscriptions, and when they were last seen.",
    {},
    async () => text(await spool.agents()),
  );

  server.tool(
    "bch_subscribe",
    "Subscribe this agent to a channel so it receives messages sent there.",
    { channel: z.string().describe("#channel name") },
    async ({ channel }) => {
      await spool.subscribe(agent, channel);
      return text(`subscribed to ${channel}`);
    },
  );

  await server.connect(new StdioServerTransport());
}
