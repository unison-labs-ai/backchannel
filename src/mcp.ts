import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, openSpool, requireAgent } from "./config.ts";

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
      thread: z.string().optional().describe("message id this replies to"),
      refs: z.array(z.string()).optional().describe("file paths or URLs the message refers to"),
    },
    async ({ target, body, priority, thread, refs }) => {
      const msg = await spool.send(agent, target, body, { priority, thread, refs });
      return text(`sent ${msg.id} to ${target}`);
    },
  );

  server.tool(
    "bch_inbox",
    "Read all unread messages addressed to this agent and acknowledge them (they will not appear again). Call this at the start of a task and before finishing.",
    {},
    async () => {
      const messages = await spool.inbox(agent);
      for (const m of messages) await spool.ack(agent, m.id);
      return text(messages.length ? messages : "inbox empty");
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
