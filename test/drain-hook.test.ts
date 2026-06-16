// `bch drain --hook` is installed globally as a UserPromptSubmit hook. In a
// repo/session with no configured identity it must exit 0 silently — there is
// nothing to drain — rather than erroring on every prompt. Interactive
// `bch drain` (no --hook) still surfaces the helpful "run `bch init`" message.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function runBch(args: string[], home: string) {
  const env = { ...process.env, BACKCHANNEL_HOME: home };
  delete env.BACKCHANNEL_AGENT; // ensure no identity
  return Bun.spawnSync(["bun", "run", CLI, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("drain --hook with no identity", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bch-drain-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("--hook exits 0 silently", () => {
    const r = runBch(["drain", "--hook"], home);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toBe("");
  });

  test("non-hook drain still errors with the init hint", () => {
    const r = runBch(["drain"], home);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("no agent identity");
  });
});
