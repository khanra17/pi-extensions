import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Maintainer tooling is plain JavaScript.
import { generatePackageRefs } from "../scripts/git-packages.mjs";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-git-packages-test-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git(["init", "-q", "--initial-branch=main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  const imports: Record<string, string> = {
    dictation: 'import "../../shared/codex.ts"; import "../../shared/microphone.ts";',
    live: 'import "../../shared/codex.ts"; import "../../shared/microphone.ts";',
    "read-aloud": 'import "../../shared/messages.ts";',
    "codex-fast": "export {};",
  };
  for (const [name, code] of Object.entries(imports)) {
    const path = join(cwd, "packages", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "index.ts"), code);
    writeFileSync(join(path, "README.md"), `# ${name}\n`);
    writeFileSync(join(path, "LICENSE"), `License ${name}\n`);
    writeFileSync(join(path, "package.json"), JSON.stringify({
      name: `@fixture/${name}`, version: "1.0.0", private: true, type: "module",
      peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
      optionalDependencies: { "@fixture/native": "1.0.0" },
      pi: { extensions: ["./index.ts"] },
    }));
  }
  mkdirSync(join(cwd, "shared"));
  writeFileSync(join(cwd, "shared", "codex.ts"), 'export * from "./messages.ts";');
  writeFileSync(join(cwd, "shared", "messages.ts"), "export {};\n");
  writeFileSync(join(cwd, "shared", "microphone.ts"), "export {};\n");
  writeFileSync(join(cwd, "shared", "unused.ts"), "export {};\n");
  git(["add", "."]);
  git(["commit", "-qm", "Fixture source"]);
  return { cwd, git, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

for (const name of ["dictation", "live", "read-aloud", "codex-fast"]) {
  test(`Git package ref ${name} contains only its extension and required shared source`, () => {
    const f = fixture();
    try {
      const refs = generatePackageRefs({ cwd: f.cwd });
      const files = f.git(["ls-tree", "-r", "--name-only", name]).split("\n");
      const manifest = JSON.parse(f.git(["show", `${name}:package.json`]));
      assert.deepEqual(manifest.pi.extensions, [`./packages/${name}/index.ts`]);
      assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
      assert.equal(manifest.optionalDependencies["@fixture/native"], "1.0.0");
      assert.ok(files.includes(`packages/${name}/index.ts`));
      assert.ok(!files.some((path: string) => path.startsWith("packages/") && !path.startsWith(`packages/${name}/`)));
      assert.ok(!files.includes("shared/unused.ts"));
      assert.ok(!files.includes(`packages/${name}/package.json`));
      const shared = files.filter((path: string) => path.startsWith("shared/"));
      assert.deepEqual(shared, name === "codex-fast" ? [] : name === "read-aloud"
        ? ["shared/messages.ts"] : ["shared/codex.ts", "shared/messages.ts", "shared/microphone.ts"]);
      assert.equal(f.git(["rev-list", "--count", name]), "1");
      assert.deepEqual(generatePackageRefs({ cwd: f.cwd }), refs);
      const commit = f.git(["rev-parse", name]);
      f.git(["update-ref", `refs/remotes/origin/${name}`, commit]);
      f.git(["update-ref", "-d", `refs/heads/${name}`]);
      assert.deepEqual(generatePackageRefs({ cwd: f.cwd }), refs);
      assert.equal(f.git(["rev-parse", name]), commit);
      assert.equal(f.git(["status", "--porcelain"]), "");
    } finally {
      f.cleanup();
    }
  });
}
