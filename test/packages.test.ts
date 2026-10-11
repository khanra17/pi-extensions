import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

process.env.PI_OFFLINE = "1";
const root = fileURLToPath(new URL("..", import.meta.url));
const commands = { dictation: "voice", live: "live", "read-aloud": "tts" };

for (const [name, command] of Object.entries(commands)) test(`${name} loads independently through Pi's public resource loader`, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-kit-package-"));
	try {
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [resolve(root, "packages", name)] });
		await loader.reload();
		const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []); assert.deepEqual(loaded.warnings ?? [], []);
		assert.equal(loaded.extensions.length, 1); assert.deepEqual([...loaded.extensions[0]!.commands.keys()], [command]);
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test("the monorepo loads one owner per command with no conflicts or browser patch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-kit-all-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
	try {
		const settings = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [root] });
		await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 3);
		assert.deepEqual(loaded.extensions.flatMap((extension) => [...extension.commands.keys()]).sort(), ["live", "tts", "voice"]);
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager: settings, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory) });
		try {
			await session.bindExtensions({ mode: "rpc" });
			assert.deepEqual(session.extensionRunner.getCommandDiagnostics(), []);
			await session.prompt("/voice start"); // RPC guard: no microphone or upload.
			await session.prompt("/tts play"); // RPC guard: no audio backend.
		} finally { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(directory, { recursive: true, force: true });
	}
});

test("package manifests have explicit, non-overlapping entry points and host peer dependencies", async () => {
	for (const name of Object.keys(commands)) {
		const manifest = JSON.parse(await readFile(resolve(root, "packages", name, "package.json"), "utf8"));
		assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
		assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
		assert.equal(manifest.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
		if (name === "dictation") { assert.equal(manifest.dependencies, undefined); assert.equal(manifest.optionalDependencies, undefined); }
	}
});
