import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { isMainModule } from "../src/entrypoint.js";

describe("CLI entrypoint", () => {
  it("recognizes an npm-style executable symlink", async () => {
    const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const directory = await mkdtemp(path.join(tmpdir(), "rootly-cli-"));
    const executablePath = path.join(directory, "rootly-migrator");
    await symlink(cliPath, executablePath);

    expect(
      isMainModule(
        new URL("../src/cli.ts", import.meta.url).href,
        executablePath,
      ),
    ).toBe(true);
  });

  it("rejects a missing executable path", () => {
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
    expect(isMainModule(import.meta.url, "/does/not/exist")).toBe(false);
  });
});
