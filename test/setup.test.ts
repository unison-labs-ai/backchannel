import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeInvite, encodeInvite } from "../src/invite.ts";
import { installClaudeCode, installCodex, installGemini, installWakeDaemon } from "../src/setup.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bch-setup-"));
  process.env.BACKCHANNEL_SETUP_HOME = home;
});

afterEach(() => {
  delete process.env.BACKCHANNEL_SETUP_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("invite codec", () => {
  test("roundtrip", () => {
    const invite = { url: "https://relay.example.com", token: "room-secret", channels: ["#dev", "#ops"] };
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite);
  });

  test("rejects garbage", () => {
    expect(() => decodeInvite("not-an-invite")).toThrow("backchannel invite");
    expect(() => decodeInvite("bch1-zzzz")).toThrow("malformed");
  });
});

describe("harness installers", () => {
  test("claude-code: hook + skill + mcp, idempotent, preserves existing settings", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    await Bun.write(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }),
    );

    const first = await installClaudeCode(home);
    expect(first.map((r) => r.action).join(" ")).toContain("inbox hook added");

    const settings = await Bun.file(join(home, ".claude", "settings.json")).json();
    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(JSON.stringify(settings.hooks.UserPromptSubmit)).toContain("drain --hook");

    const mcp = await Bun.file(join(home, ".claude.json")).json();
    expect(mcp.mcpServers.backchannel.args).toContain("mcp");

    const second = await installClaudeCode(home);
    expect(second.map((r) => r.action).join(" ")).toContain("already installed");
    const after = await Bun.file(join(home, ".claude", "settings.json")).json();
    expect(after.hooks.UserPromptSubmit).toHaveLength(1);
  });

  test("codex: toml block + AGENTS.md section, idempotent, appends not clobbers", async () => {
    mkdirSync(join(home, ".codex"), { recursive: true });
    await Bun.write(join(home, ".codex", "config.toml"), 'model = "o4"\n');
    await Bun.write(join(home, ".codex", "AGENTS.md"), "# My rules\n");

    await installCodex(home);
    const toml = await Bun.file(join(home, ".codex", "config.toml")).text();
    expect(toml).toContain('model = "o4"');
    expect(toml).toContain("[mcp_servers.backchannel]");
    const agents = await Bun.file(join(home, ".codex", "AGENTS.md")).text();
    expect(agents).toContain("# My rules");
    expect(agents).toContain("bch_inbox");

    const second = await installCodex(home);
    expect(second.every((r) => r.action.includes("already"))).toBe(true);
    expect((await Bun.file(join(home, ".codex", "config.toml")).text()).split("[mcp_servers.backchannel]")).toHaveLength(2);
  });

  test("gemini: mcpServers merge, idempotent", async () => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    await Bun.write(join(home, ".gemini", "GEMINI.md"), "# My gemini rules\n");
    await installGemini(home);
    const settings = await Bun.file(join(home, ".gemini", "settings.json")).json();
    expect(settings.mcpServers.backchannel.args).toContain("mcp");
    const md = await Bun.file(join(home, ".gemini", "GEMINI.md")).text();
    expect(md).toContain("# My gemini rules");
    expect(md).toContain("bch_inbox");
    const second = await installGemini(home);
    expect(second.every((r) => r.action.includes("already"))).toBe(true);
  });

  test("wake daemon: writes service definition without loading under test home", async () => {
    const results = await installWakeDaemon("echo {{body}}", home);
    expect(results[0]!.action).toMatch(/daemon installed|written/);
    const plist = join(home, "Library", "LaunchAgents", "ai.unisonlabs.backchannel.wake.plist");
    const unit = join(home, ".config", "systemd", "user", "backchannel-wake.service");
    expect((await Bun.file(plist).exists()) || (await Bun.file(unit).exists())).toBe(true);
  });
});

describe("wake defaults", () => {
  test("the only wake behavior is a human notification", async () => {
    const setup = await import("../src/setup.ts");
    expect(setup.defaultWakeExec()).toMatch(/osascript|notify-send/);
    expect(setup.defaultWakeExec()).not.toMatch(/claude|codex|gemini/);
    expect("spawnWakeExec" in setup).toBe(false);
  });
});

describe("notification daemon is non-consuming", () => {
  test("daemon service definition uses watch --peek", async () => {
    const { installWakeDaemon } = await import("../src/setup.ts");
    await installWakeDaemon("echo {{body}}", home);
    const plist = Bun.file(join(home, "Library", "LaunchAgents", "ai.unisonlabs.backchannel.wake.plist"));
    const unit = Bun.file(join(home, ".config", "systemd", "user", "backchannel-wake.service"));
    const content = (await plist.exists()) ? await plist.text() : await unit.text();
    expect(content).toContain("--peek");
  });
});
