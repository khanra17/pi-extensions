import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = JSON.parse(readFileSync(join(root, ".cache/pi-web-build.json"), "utf8")).directory;
const agent = mkdtempSync(join(root, ".cache/browser-smoke-"));
process.env.PI_CODING_AGENT_DIR = agent;
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const cwd = join(agent, "workspace"); mkdirSync(cwd, { recursive: true });
const session = SessionManager.create(cwd);
session.appendMessage({ role: "user", content: [{ type: "text", text: "Read this reply." }], timestamp: Date.now() });
session.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "DO-NOT-SPEAK" }, { type: "text", text: "**Browser** voice test.\n\n" + "Another sentence for buffered playback. ".repeat(500) + "\n```ts\nconsole.log('code');\n```" }], api: "openai-completions", provider: "openai", model: "gpt-4o-mini", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
session.appendSessionInfo("Voice bridge smoke");
writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], extensions: [join(root, "test/browser-fixture.ts")], defaultProvider: "openai", defaultModel: "gpt-4o-mini" }));
const mp3 = join(root, ".cache/browser-test.mp3");
if (!existsSync(mp3)) execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'import {synthesizeChunks} from "./packages/read-aloud/edge-read-aloud.ts";import {writeFileSync} from "node:fs";await synthesizeChunks({text:"Browser voice test.",voice:"en-US, AvaNeural",signal:AbortSignal.timeout(20000),onChunk:async c=>writeFileSync(".cache/browser-test.mp3",c.audio)})'], { cwd: root, stdio: "inherit" });
const output = join(agent, "server.log");
const child = spawn(process.execPath, [join(build, "bin/pi-web.js"), "--hostname", "127.0.0.1", "--port", "30146"], { cwd: build, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_WEB_PASSWORD: "", PI_WEB_SKIP_VERSION_CHECK: "1", PI_VOICE_TEST_MP3: mp3 }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", value => { log += value; writeFileSync(output, log); }); child.stderr.on("data", value => { log += value; writeFileSync(output, log); });
const base = "http://localhost:30146";
let browser;
try {
  let ready = false;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base)).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 250)); }
  if (!ready) throw new Error("Isolated server did not start. " + log.slice(-4000));
  const { chromium } = await import(pathToFileURL(join(build, "node_modules/playwright/index.mjs")).href);
  browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  for (const [name, viewport] of [["desktop", { width: 1280, height: 850 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, isMobile: name === "mobile", hasTouch: name === "mobile" });
    const page = await context.newPage(); const errors = []; const prompts = []; const speechRequests = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      const url = new URL(request.url());
      if (request.method() !== "POST") return;
      if (url.pathname === `/api/agent/${session.getSessionId()}`) { try { if (request.postDataJSON().type === "prompt") prompts.push(request.url()); } catch {} }
      if (url.pathname === `/api/pi-voice/v1/${session.getSessionId()}` && url.searchParams.get("feature") === "tts" && url.searchParams.get("action") === "speak") speechRequests.push(request.url());
    });
    await page.addInitScript(() => {
      window.__voiceTracks = []; const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => { const stream = await get(constraints); window.__voiceTracks.push(...stream.getTracks()); return stream; };
    });
    await page.goto(`${base}/?session=${session.getSessionId()}`);
    await page.getByRole("button", { name: "Start dictation", exact: true }).waitFor({ timeout: 30_000 });
    const input = page.locator("textarea").first();
    await input.fill("Existing draft."); await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    try { await page.waitForFunction(() => /spoken (preview|final)/.test(document.querySelector("textarea")?.value ?? ""), null, { timeout: 15_000 }); }
    catch (error) { await page.screenshot({ path: join(agent, `${name}-capture-error.png`), fullPage: true }); console.log(await page.locator(".pi-voice-controls").innerText(), await page.locator(".pi-voice-indicator").getAttribute("title"), await page.evaluate(() => ({ secure: isSecureContext, media: typeof navigator.mediaDevices, get: typeof navigator.mediaDevices?.getUserMedia })), errors); throw error; }
    await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("textarea")?.value === "Existing draft. spoken final", { timeout: 15_000 });
    assert.equal(prompts.length, 0, "Dictation must never send a prompt");
    await input.fill("Keep my edit."); await page.getByRole("button", { name: "Start dictation", exact: true }).click();
    await page.waitForFunction(() => /spoken (preview|final)/.test(document.querySelector("textarea")?.value ?? ""));
    await input.fill("My deliberate edit."); await page.getByRole("button", { name: "Stop dictation", exact: true }).click();
    await page.getByRole("button", { name: "Start dictation", exact: true }).waitFor();
    assert.equal(await input.inputValue(), "My deliberate edit.");
    const blocked = "**/api/pi-voice/v1/*?feature=dictation&action=*";
    await page.route(blocked, async route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      if (["preview", "finish"].includes(action)) await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture transcription endpoint challenge.", retryable: false, code: "transcription_blocked" }) });
      else await route.continue();
    });
    await input.fill("Preserve on failure."); await page.keyboard.press("Control+Alt+m");
    await page.getByRole("alert").filter({ hasText: "Fixture transcription" }).waitFor();
    await page.getByRole("button", { name: "Close voice controls", exact: true }).click();
    assert.ok(await page.getByRole("alert").filter({ hasText: "Fixture transcription" }).isVisible(), "Errors remain visible outside a closed panel on mobile and desktop");
    await page.keyboard.press("Control+Alt+m");
    await page.getByRole("button", { name: "Start dictation", exact: true }).waitFor();
    assert.equal(await input.inputValue(), "Preserve on failure."); assert.equal(prompts.length, 0);
    await page.unroute(blocked);
    await page.getByRole("button", { name: "Dismiss voice error", exact: true }).click();
    assert.equal(await page.getByRole("combobox", { name: "Dictation backend", exact: true }).count(), 0);
    const tracksBefore = await page.evaluate(() => window.__voiceTracks.length);
    await page.keyboard.press("Control+Shift+l"); await page.keyboard.press("Control+Space");
    assert.equal(await page.evaluate(() => window.__voiceTracks.length), tracksBefore, "Old browser/IME shortcuts do not activate voice");
    assert.equal(await page.locator(".pi-voice-controls > button").count(), 3, "Full voice toolbar has only microphone, Live and one panel launcher");
    assert.equal(await page.getByRole("button", { name: "Voice controls", exact: true }).count(), 0, "No duplicate settings launcher");
    await page.getByRole("button", { name: "Read aloud", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
    await page.getByRole("region", { name: "Read-aloud controls", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Cancel dictation", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "End Live", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Read aloud", exact: true }).getAttribute("aria-expanded"), "true");
    await page.waitForTimeout(250);
    assert.equal(speechRequests.length, 0, "Opening playback/settings must not start speech");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.waitForFunction(() => CSS.highlights?.has("pi-voice-word"));
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await page.screenshot({ path: join(agent, `${name}-before-picker.png`), fullPage: true });
    if (!await page.locator(".pi-voice-panel").count()) await page.getByRole("button", { name: "Read aloud", exact: true }).click();
    await page.getByRole("button", { name: "Browse voices", exact: true }).click();
    await page.getByRole("textbox", { name: "Search voices" }).fill("Ava");
    await page.getByRole("button", { name: /^Ava\b/ }).waitFor();
    await page.screenshot({ path: join(agent, `${name}.png`), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Mobile page must not overflow horizontally");
    await page.getByRole("button", { name: "Close voice controls", exact: true }).click();
    await page.route("**/api/pi-voice/v1/*?feature=live&action=start", async route => {
      const offer = route.request().postDataJSON().offer;
      const answer = await page.evaluate(async offer => { const peer = new RTCPeerConnection(); window.__fixturePeer = peer; await peer.setRemoteDescription({ type: "offer", sdp: offer }); await peer.setLocalDescription(await peer.createAnswer()); await new Promise(resolve => { if (peer.iceGatheringState === "complete") resolve(); else peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") resolve(); }); }); return peer.localDescription.sdp; }, offer);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ run: route.request().headers()["x-pi-voice-run"], answer }) });
    });
    await page.keyboard.press("Control+Alt+l");
    await page.waitForFunction(() => document.querySelector(".pi-voice-indicator")?.textContent === "listening");
    await page.waitForFunction(() => window.__fixturePeer.connectionState === "connected");
    await page.getByRole("button", { name: "Stop Live voice", exact: true }).click();
    assert.ok(await page.evaluate(() => window.__voiceTracks.every(track => track.readyState === "ended")), "Viewing-device microphone tracks must all stop");
    await page.evaluate(() => window.__fixturePeer?.close());
    await page.unroute("**/api/pi-voice/v1/*?feature=live&action=start");
    await page.route("**/api/pi-voice/v1/*?feature=live&action=start", route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Fixture Live signaling failed (403)." }) }));
    await page.getByRole("button", { name: "Start Live voice", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Fixture Live signaling" }).waitFor();
    assert.ok(await page.evaluate(() => window.__voiceTracks.every(track => track.readyState === "ended")), "Failed Live setup releases microphone tracks");
    let advertised = ["dictation", "live"];
    await page.route("**/api/pi-voice/v1/*", async route => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET" && !url.search) {
        const response = await route.fetch(); const info = await response.json();
        await route.fulfill({ response, json: { ...info, features: advertised } });
      } else await route.continue();
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".pi-voice-controls > button").length === 2);
    assert.equal(await page.locator(".pi-voice-controls > button").count(), 2, "Dictation and Live do not inherit a read-aloud/settings launcher");
    assert.equal(await page.getByRole("button", { name: "Read aloud", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Voice controls", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Play", exact: true }).count(), 0);
    advertised = ["tts"]; await page.reload();
    await page.waitForFunction(() => document.querySelectorAll(".pi-voice-controls > button").length === 1);
    await page.getByRole("button", { name: "Read aloud", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Voice controls", exact: true }).count(), 0, "TTS alone needs only its speaker launcher");

    assert.deepEqual(errors, [], "No browser runtime errors");
    await context.close(); console.log(`Chromium ${name}: visible dictation/Live failures, consistent shortcuts, three-button toolbar, explicit playback, draft preservation, progressive dictation, no auto-send, user edits, MP3 playback, highlighting, picker, WebRTC and microphone cleanup passed`);
  }
  const entries = readFileSync(session.getSessionFile(), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(entries.filter(entry => entry.type === "message").length, 2, "Dictation must not append any conversation messages");
  const response = await fetch(`${base}/api/pi-voice/v1/${session.getSessionId()}`, { headers: { Origin: "https://evil.invalid", "Sec-Fetch-Site": "cross-site" } });
  assert.ok(response.status >= 400, "Cross-site requests must fail");
  console.log("Isolated results:", agent);
} finally {
  await browser?.close();
  if (child.exitCode === null && child.pid) {
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
    else child.kill("SIGTERM");
  }
}
