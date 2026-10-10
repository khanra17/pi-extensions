import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const packageRefs = ["dictation", "live", "read-aloud", "codex-fast"];

// Publish normal Git package roots, using the canonical source blobs.
// This is maintainer tooling; clients install directly with npm's Git resolver.
export function generatePackageRefs({ cwd = process.cwd(), ref = "HEAD" } = {}) {
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd, encoding: "utf8", ...options,
  }).trim();
  const source = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const files = new Map(git(["ls-tree", "-rz", source]).split("\0").filter(Boolean).map(line => {
    const tab = line.indexOf("\t");
    const [mode, type, hash] = line.slice(0, tab).split(" ");
    if (type !== "blob") throw new Error("Package exports must contain regular source files");
    return [line.slice(tab + 1), { mode, hash }];
  }));
  const read = path => git(["show", `${source}:${path}`]);
  const results = [];
  const temporary = mkdtempSync(join(tmpdir(), "pi-package-index-"));
  try {
    for (const name of packageRefs) {
      const prefix = `packages/${name}/`;
      const manifest = JSON.parse(read(prefix + "package.json"));
      const selected = new Map([...files].filter(([path]) => path.startsWith(prefix) && path.endsWith(".ts")));
      const pending = [...selected.keys()];
      while (pending.length) {
        const path = pending.pop();
        for (const match of read(path).matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
          const spec = match[1];
          if (!spec.startsWith(".")) continue;
          const dependency = posix.normalize(posix.join(posix.dirname(path), spec));
          if (!dependency.startsWith("shared/") || selected.has(dependency)) continue;
          const entry = files.get(dependency);
          if (!entry) throw new Error(`Missing shared source: ${dependency}`);
          selected.set(dependency, entry);
          pending.push(dependency);
        }
      }
      for (const path of ["LICENSE", "README.md", "THIRD_PARTY_NOTICES.md"]) {
        const entry = files.get(prefix + path);
        if (entry) selected.set(path, entry);
      }
      if (files.has(".gitleaks.toml")) selected.set(".gitleaks.toml", files.get(".gitleaks.toml"));
      manifest.pi = { ...manifest.pi, extensions: [`./${prefix}index.ts`] };
      manifest.files = [`${prefix}*.ts`, "shared/*.ts", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", ".gitleaks.toml"];
      manifest.repository = { type: "git", url: "git+https://github.com/khanra17/pi-extensions.git", directory: `packages/${name}` };
      const hash = git(["hash-object", "-w", "--stdin"], { input: JSON.stringify(manifest, null, 2) + "\n" });
      selected.set("package.json", { mode: "100644", hash });
      const env = { ...process.env, GIT_INDEX_FILE: join(temporary, name) };
      git(["read-tree", "--empty"], { env });
      git(["update-index", "-z", "--index-info"], {
        env, input: [...selected].map(([path, entry]) => `${entry.mode} ${entry.hash}\t${path}\0`).join(""),
      });
      const tree = git(["write-tree"], { env });
      const branch = `refs/heads/${name}`;
      let localPrevious;
      let previous;
      try { localPrevious = git(["rev-parse", "--verify", "--quiet", branch]); } catch {}
      previous = localPrevious;
      if (!previous) {
        try { previous = git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]); } catch {}
      }
      // Package history never refers to the monorepo's source history.
      if (previous && git(["rev-parse", `${previous}^{tree}`]) === tree) {
        if (!localPrevious) git(["update-ref", branch, previous, ""]);
        results.push({ name, commit: previous, source });
        continue;
      }
      const parents = previous ? ["-p", previous] : [];
      const commit = git(["commit-tree", tree, ...parents, "-m", `Package ${manifest.name} from ${source}`]);
      git(["update-ref", branch, commit, localPrevious || ""]);
      results.push({ name, commit, source });
    }
    return results;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const result of generatePackageRefs()) console.log(`${result.name}: ${result.commit}`);
}
