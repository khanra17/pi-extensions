import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { applyAdapter, adaptSources, hostFiles } from "../integration/pi-web/adapter.mjs";
const kit = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(kit, ".cache");
const repository = join(cache, "pi-web-upstream");
const statePath = join(cache, "pi-web-build.json");
const pin = JSON.parse(readFileSync(join(kit, "integration/pi-web/upstream.json"), "utf8"));
const mode = process.argv[2] ?? "build";
const flags = process.argv.slice(3);
if (!["build", "check", "start"].includes(mode)) throw new Error("Expected build, check or start.");
function run(program, args, cwd = kit, options = {}) {
  if (program === "npm" && process.platform === "win32") return execFileSync("cmd.exe", ["/d", "/s", "/c", "npm " + args.join(" ")], { cwd, stdio: "inherit", ...options });
  return execFileSync(program, args, { cwd, stdio: "inherit", ...options });
}
const git = args => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
function hashFiles(path, hash) {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) hashFiles(file, hash);
    else if (!entry.name.endsWith(".md")) { hash.update(file.slice(kit.length)); hash.update(readFileSync(file)); }
  }
}
mkdirSync(cache, { recursive: true });
if (mode === "start") {
  if (!existsSync(statePath)) throw new Error("Build first: npm run web:build");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (!existsSync(join(state.directory, ".voice-build-ready.json"))) throw new Error("The integration build is incomplete. Rebuild it.");
  const portIndex = flags.indexOf("--port");
  const port = portIndex < 0 ? 30141 : Number(flags[portIndex + 1]);
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is occupied. Stop the existing server normally at an idle point; no extensions were changed.`)));
    const hostnameIndex = flags.indexOf("--hostname");
    const host = hostnameIndex < 0 ? "0.0.0.0" : flags[hostnameIndex + 1];
    probe.listen({ port, host, exclusive: true }, () => probe.close(resolve));
  });
  if (flags.includes("--update-extensions")) {
    const cli = join(kit, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    for (const [name, ref] of [["pi-dictation", "dictation"], ["pi-live-voice", "live"], ["pi-read-aloud", "read-aloud"]]) {
      run(process.execPath, [cli, "install", `npm:@khanra17/${name}@github:khanra17/pi-extensions#${ref}`]);
    }
  }
  const child = spawn(process.execPath, [join(state.directory, "bin/pi-web.js"), ...flags.filter(value => value !== "--update-extensions")], {
    cwd: process.cwd(), stdio: "inherit", env: { ...process.env, PI_WEB_SKIP_VERSION_CHECK: "1" },
  });
  child.on("exit", code => { process.exitCode = code ?? 1; });
  child.on("error", error => { console.error(error.message); process.exitCode = 1; });
} else {
  const refAt = flags.indexOf("--ref");
  const ref = refAt >= 0 ? flags[refAt + 1] : pin.commit;
  if (!ref || !/^[a-zA-Z0-9._/-]+$/.test(ref)) throw new Error("Invalid upstream ref.");
  if (!existsSync(join(repository, ".git"))) run("git", ["clone", "--no-checkout", pin.repository, repository]);
  if (git(["remote", "get-url", "origin"]) !== pin.repository) throw new Error("The cached upstream remote does not match the pinned repository.");
  try { git(["rev-parse", "--verify", ref]); } catch { run("git", ["fetch", "--depth", "1", "origin", ref], repository); }
  let commit;
  try { commit = git(["rev-parse", `${ref}^{commit}`]); } catch { commit = git(["rev-parse", "FETCH_HEAD"]); }
  const source = Object.fromEntries(hostFiles.map(path => [path, git(["show", `${commit}:${path}`]) + "\n"]));
  adaptSources(source); // Fail before installing dependencies or touching an active build.
  const hash = createHash("sha256").update(commit).update(process.platform + process.arch + process.versions.modules);
  hashFiles(join(kit, "integration/pi-web"), hash);
  for (const file of ["shared/browser.ts", "shared/messages.ts", "packages/dictation/composer.ts"]) hash.update(readFileSync(join(kit, file)));
  const directory = join(cache, "pi-web-builds", commit.slice(0, 12) + "-" + hash.digest("hex").slice(0, 12));
  if (mode === "check") {
    console.log("Pi Web adapter anchors passed for", commit, "; build/typecheck/browser tests are still required.");
    process.exit(0);
  }
  if (!existsSync(join(directory, ".voice-build-ready.json"))) {
    if (existsSync(directory)) throw new Error("An unfinished staging directory already exists: " + directory + ". Remove only that inactive staging directory and rebuild.");
    mkdirSync(directory, { recursive: true });
    const archive = execFileSync("git", ["archive", commit], { cwd: repository, maxBuffer: 32 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-", "-C", directory], { input: archive, stdio: ["pipe", "inherit", "inherit"] });
    applyAdapter(directory, kit);
    const dependencies = join(cache, "pi-web-dependencies", commit + "-" + process.platform + "-" + process.arch + "-" + process.versions.modules);
    mkdirSync(dependencies, { recursive: true });
    if (!existsSync(join(dependencies, "ready.json"))) {
      run("npm", ["ci"], directory);
      renameSync(join(directory, "node_modules"), join(dependencies, "node_modules"));
      writeFileSync(join(dependencies, "ready.json"), JSON.stringify({ commit, nodeABI: process.versions.modules }) + "\n");
    }
    symlinkSync(join(dependencies, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    run(process.execPath, ["bin/prepare-terminal.js"], directory);
    run(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit"], directory);
    run("npm", ["run", "build"], directory, { env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", PI_WEB_SKIP_VERSION_CHECK: "1" } });
    writeFileSync(join(directory, ".voice-build-ready.json"), JSON.stringify({ commit, bridgeVersion: pin.bridgeVersion, nodeABI: process.versions.modules }) + "\n");
  }
  writeFileSync(statePath + ".new", JSON.stringify({ directory, upstream: commit, bridgeVersion: pin.bridgeVersion }, null, 2) + "\n");
  renameSync(statePath + ".new", statePath);
  console.log("Integration built:", directory);
  console.log("Installed Pi/Pi Web and the running server were not changed.");
  console.log("At an idle point, stop the stock server normally, then: npm run web:start -- --update-extensions --hostname 0.0.0.0");
}
