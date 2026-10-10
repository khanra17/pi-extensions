"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ComposerDraft, joinAtCursor, type ComposerPort } from "@/lib/pi-voice-composer";
import { assistantText, textContent, messagePhase, isRecord } from "@/lib/pi-voice-messages";
import { PcmCapture, SpeechPlayer, speechChunks, markWord, clearWord } from "./media";
import "./voice.css";

export interface VoiceHost {
  version: 1; key: string; isNew: boolean; sessionId: string | null;
  ensureSession(): Promise<string | null>;
  messages: unknown[]; entryIds: Array<string | undefined>;
  textElements(id: string): HTMLElement[];
}
interface Settings { voice: string; speed: number; volume: number; muted: boolean; autoPlay: boolean; readCode: boolean; highlightEnabled: boolean }
interface Voice { code: string; locale: string; name: string; friendlyName: string; gender?: string }
interface Item { id: string; text: string; role: "user" | "assistant"; phase?: string }
interface Run { kind: "dictation" | "live"; sid: string; id?: string; abort: AbortController; capture?: PcmCapture; stream?: MediaStream; peer?: RTCPeerConnection; audio?: HTMLAudioElement; timer?: ReturnType<typeof setTimeout>; maximum?: ReturnType<typeof setTimeout>; preview?: Promise<void>; draft?: ComposerDraft; recording?: boolean }
const defaultSettings: Settings = { voice: "en-US, AvaNeural", speed: 1, volume: 100, muted: false, autoPlay: false, readCode: false, highlightEnabled: true };
function visibleItems(host: VoiceHost): Item[] {
  return host.messages.flatMap((message, index) => {
    if (!isRecord(message) || !["user", "assistant"].includes(String(message.role))) return [];
    const id = host.entryIds[index]; if (!id) return [];
    const text = message.role === "assistant" ? assistantText(message) : textContent(message.content);
    return text ? [{ id, text, role: message.role as Item["role"], phase: messagePhase(message) }] : [];
  });
}
export function VoiceControls({ host, composer, setBusy }: { host?: VoiceHost; composer: ComposerPort; setBusy(value: boolean): void }) {
  const hostRef = useRef(host); hostRef.current = host;
  const composerRef = useRef(composer); composerRef.current = composer;
  const client = useRef<string | undefined>(undefined);
  const sid = useRef<string | undefined>(undefined);
  const initTask = useRef<Promise<string> | undefined>(undefined);
  const events = useRef<EventSource | undefined>(undefined);
  const run = useRef<Run | undefined>(undefined);
  const generation = useRef(0);
  const player = useRef<SpeechPlayer | undefined>(undefined);
  const speechAbort = useRef<AbortController | undefined>(undefined);
  const speechRun = useRef<string | undefined>(undefined);
  const queue = useRef<Item[]>([]), pumping = useRef(false);
  const settingsRef = useRef(defaultSettings);
  const itemsRef = useRef<Item[]>([]);
  const selected = useRef<string | undefined>(undefined);
  const autoSeen = useRef(new Set<string>()), autoReady = useRef(false);
  const mounted = useRef(true);
  const [features, setFeatures] = useState<string[] | null>(null);
  const [phase, setPhase] = useState("idle"), [message, setMessage] = useState("");
  const [panel, setPanel] = useState(false), [playing, setPlaying] = useState(false), [paused, setPaused] = useState(false);
  const [muted, setMuted] = useState(false), [settings, setSettings] = useState(defaultSettings);
  const [voices, setVoices] = useState<Voice[]>([]), [search, setSearch] = useState(""), [language, setLanguage] = useState("");
  const [word, setWord] = useState("");
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), held = useRef(false);
  const eventHandler = useRef<(event: { feature: string; type: string; data: Record<string, unknown>; run?: string }) => void>(() => {});
  const fail = useCallback((error: unknown) => { if (mounted.current) setMessage(error instanceof Error ? error.message : String(error)); }, []);
  const raw = useCallback(async (session: string, feature: string, action: string, body: unknown = {}, signal?: AbortSignal, owned?: string, keepalive = false): Promise<Response> => {
    client.current ??= crypto.randomUUID();
    const wav = body instanceof Uint8Array;
    const response = await fetch(`/api/pi-voice/v1/${encodeURIComponent(session)}?feature=${feature}&action=${action}`, {
      method: "POST", credentials: "same-origin", keepalive, signal,
      headers: { "Content-Type": wav ? "audio/wav" : "application/json", "x-pi-voice-client": client.current, ...(owned ? { "x-pi-voice-run": owned } : {}) },
      body: wav ? new Blob([new Uint8Array(body)]) : JSON.stringify(body),
    });
    if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || `Voice bridge HTTP ${response.status}`); }
    return response;
  }, []);
  const initialize = useCallback(async (): Promise<string> => {
    if (sid.current) return sid.current;
    if (initTask.current) return initTask.current;
    const token = generation.current;
    const task = (async () => {
      const current = hostRef.current;
      if (!current || current.version !== 1) throw new Error("Incompatible Pi Web voice host. Update the integration.");
      const session = await current.ensureSession();
      if (!session || token !== generation.current) throw new Error("Voice session changed.");
      const response = await fetch(`/api/pi-voice/v1/${encodeURIComponent(session)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("The Pi Web voice bridge is unavailable. Use the integration build and reload extensions.");
      const info = await response.json() as { version: number; features: string[] };
      if (info.version !== 1 || token !== generation.current) throw new Error("Voice bridge version mismatch or changed session.");
      sid.current = session; setFeatures(info.features);
      client.current ??= crypto.randomUUID();
      const stream = events.current = new EventSource(`/api/pi-voice/v1/${encodeURIComponent(session)}?events=1&client=${client.current}`);
      stream.onmessage = event => { try { eventHandler.current(JSON.parse(event.data)); } catch {} };
      if (info.features.includes("tts")) {
        const value = await (await raw(session, "tts", "settings")).json() as Settings;
        if (token === generation.current) { settingsRef.current = value; setSettings(value); }
      }
      return session;
    })();
    initTask.current = task;
    try { return await task; } finally { if (initTask.current === task) initTask.current = undefined; }
  }, [raw]);
  const stopSpeech = useCallback(() => {
    queue.current = []; speechAbort.current?.abort(); speechAbort.current = undefined; player.current?.stop(); clearWord();
    const owned = speechRun.current; speechRun.current = undefined;
    if (sid.current && owned) void raw(sid.current, "tts", "stop", {}, undefined, owned, true).catch(() => {});
    if (mounted.current) { setPlaying(false); setPaused(false); setWord(""); }
  }, [raw]);
  const cancelRun = useCallback(() => {
    const current = run.current; run.current = undefined;
    current?.abort.abort(); clearTimeout(current?.timer); clearTimeout(current?.maximum); clearTimeout(hold.current);
    current?.capture?.stop(); current?.stream?.getTracks().forEach(track => track.stop()); current?.peer?.close(); current?.audio?.pause();
    current?.draft?.cancel();
    if (current?.id && current.sid) void raw(current.sid, current.kind, current.kind === "dictation" ? "cancel" : "stop", {}, undefined, current.id, true).catch(() => {});
    setBusy(false); if (mounted.current) { setPhase("idle"); setMuted(false); }
  }, [raw, setBusy]);
  const stopDictation = useCallback(async () => {
    const current = run.current;
    if (current?.kind !== "dictation" || !current.id || !current.capture) { cancelRun(); return; }
    current.recording = false; clearTimeout(current.timer); clearTimeout(current.maximum);
    setPhase("transcribing");
    const audio = await current.capture.finish();
    if (run.current !== current) return;
    try {
      await current.preview;
      if (run.current !== current) return;
      const result = await (await raw(current.sid, "dictation", "finish", audio, current.abort.signal, current.id)).json() as { text: string };
      if (run.current !== current || current.abort.signal.aborted) return;
      current.draft?.finish(result.text); current.draft = undefined; run.current = undefined; setBusy(false); setPhase("idle"); setMessage("Transcript ready to edit. Nothing was sent.");
    } catch (error) { if (run.current === current) { cancelRun(); fail(error); } }
  }, [raw, cancelRun, fail, setBusy]);
  const dictate = useCallback(async () => {
    if (run.current?.kind === "dictation") { await stopDictation(); return; }
    if (run.current) { fail(new Error("Stop Live before starting dictation.")); return; }
    stopSpeech(); setMessage(""); setPhase("starting"); setBusy(true);
    const capture = new PcmCapture(), abort = new AbortController();
    const current: Run = { kind: "dictation", sid: "", id: crypto.randomUUID(), abort, capture };
    current.maximum = setTimeout(() => { if (run.current !== current) return; if (current.recording) void stopDictation(); else { cancelRun(); fail(new Error("Microphone setup timed out.")); } }, 120_000);
    current.draft = new ComposerDraft({ getText: () => composerRef.current.getText(), setText: text => composerRef.current.setText(text), getCursorOffset: () => composerRef.current.getCursorOffset(), insertText: text => composerRef.current.insertText(text) });
    current.draft.begin(); run.current = current;
    try {
      // Permission prompt is caused by the user's click, not a server event.
      await capture.start();
      if (run.current !== current) { capture.stop(); return; }
      current.sid = await initialize();
      if (run.current !== current) return;
      const result = await (await raw(current.sid, "dictation", "start", {}, abort.signal, current.id)).json() as { run: string };
      if (run.current !== current) return;
      current.id = result.run; current.recording = true; setPhase("recording");
      const preview = async () => {
        if (run.current !== current || !current.recording) return;
        const audio = capture.wav();
        if (audio.length >= 48_044) {
          try {
            const result = await (await raw(current.sid, "dictation", "preview", audio, abort.signal, current.id)).json() as { text: string };
            if (run.current === current && current.recording) current.draft?.preview(result.text);
          } catch { if (run.current === current && current.recording) setMessage("Preview delayed; recording continues."); }
        }
        if (run.current === current && current.recording) current.timer = setTimeout(() => { current.preview = preview(); }, 2_000);
      };
      current.timer = setTimeout(() => { current.preview = preview(); }, 2_000);
      abort.signal.addEventListener("abort", () => clearTimeout(current.maximum), { once: true });
    } catch (error) { if (run.current === current) { cancelRun(); fail(error); } }
  }, [stopDictation, stopSpeech, initialize, raw, cancelRun, fail, setBusy]);
  const live = useCallback(async () => {
    if (run.current?.kind === "live") { cancelRun(); return; }
    if (run.current) { fail(new Error("Stop dictation before starting Live.")); return; }
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) { fail(new Error("Live microphone access requires HTTPS (or localhost).")); return; }
    stopSpeech(); setMessage(""); setPhase("connecting");
    const current: Run = { kind: "live", sid: "", id: crypto.randomUUID(), abort: new AbortController() }; run.current = current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (run.current !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      const output = current.audio = new Audio(); output.autoplay = true;
      const peer = current.peer = new RTCPeerConnection();
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      peer.ontrack = event => { output.srcObject = event.streams[0] ?? new MediaStream([event.track]); void output.play().catch(() => setMessage("Tap Resume audio to allow Live playback.")); };
      peer.onconnectionstatechange = () => { if (["failed", "closed"].includes(peer.connectionState) && run.current === current) { cancelRun(); setMessage("Live connection ended."); } };
      const channel = peer.createDataChannel("oai-events"); channel.onmessage = () => {}; // Server sideband is authoritative.
      await peer.setLocalDescription(await peer.createOffer());
      await Promise.race([new Promise<void>(resolve => { if (peer.iceGatheringState === "complete") resolve(); else peer.addEventListener("icegatheringstatechange", () => { if (peer.iceGatheringState === "complete") resolve(); }); }), new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
      if (run.current !== current) return;
      current.sid = await initialize();
      if (run.current !== current) return;
      const result = await (await raw(current.sid, "live", "start", { offer: peer.localDescription?.sdp }, current.abort.signal, current.id)).json() as { run: string; answer: string };
      if (run.current !== current) return;
      current.id = result.run; await peer.setRemoteDescription({ type: "answer", sdp: result.answer }); setPhase("listening");
    } catch (error) { if (run.current === current) { cancelRun(); fail(error); } }
  }, [stopSpeech, initialize, raw, cancelRun, fail]);
  const pump = useCallback(async () => {
    if (pumping.current) return;
    pumping.current = true;
    try {
      while (queue.current.length) {
        const item = queue.current.shift()!; selected.current = item.id;
        const abort = speechAbort.current = new AbortController();
        const owned = speechRun.current = crypto.randomUUID();
        player.current ??= new SpeechPlayer();
        const audio = player.current.audio;
        audio.playbackRate = settingsRef.current.speed; audio.volume = settingsRef.current.volume / 100; audio.muted = settingsRef.current.muted;
        setPlaying(true); setPaused(player.current.paused);
        const cursor = { offset: 0 };
        try {
          const session = await initialize();
          audio.playbackRate = settingsRef.current.speed; audio.volume = settingsRef.current.volume / 100; audio.muted = settingsRef.current.muted;
          const response = await raw(session, "tts", "speak", { text: item.text }, abort.signal, owned);
          for await (const chunk of speechChunks(response, abort.signal)) {
            await player.current.play(chunk, abort.signal, word => { setWord(word); if (settingsRef.current.highlightEnabled) markWord(hostRef.current?.textElements(item.id) ?? [], word, cursor); });
          }
        } catch (error) { if (!abort.signal.aborted) { fail(error); queue.current = []; } }
        finally { clearWord(); if (speechAbort.current === abort) speechAbort.current = undefined;
          if (sid.current) void raw(sid.current, "tts", "stop", {}, undefined, owned).catch(() => {});
          if (speechRun.current === owned) speechRun.current = undefined; }
      }
    } finally { pumping.current = false; if (mounted.current) { setPlaying(false); setWord(""); } /* Each playback run releases only its own server-side lease. */ }
  }, [initialize, raw, fail]);
  const speak = useCallback((offset = 0) => {
    stopSpeech();
    player.current ??= new SpeechPlayer(); player.current.prime();
    const list = itemsRef.current;
    let index = list.findIndex(item => item.id === selected.current);
    if (index < 0) index = list.length - 1;
    index = Math.max(0, Math.min(list.length - 1, index + offset));
    const item = list[index]; if (!item) { setMessage("No readable message yet."); return; }
    queue.current.push(item); void pump();
  }, [stopSpeech, pump]);
  const configure = useCallback(async (patch: Partial<Settings>) => {
    try {
      const session = await initialize();
      const next = await (await raw(session, "tts", "configure", patch)).json() as Settings;
      settingsRef.current = next; setSettings(next);
      if (player.current) { player.current.audio.playbackRate = next.speed; player.current.audio.volume = next.volume / 100; player.current.audio.muted = next.muted; }
    } catch (error) { fail(error); }
  }, [initialize, raw, fail]);
  eventHandler.current = event => {
    if (event.run && event.run !== (event.feature === "tts" ? speechRun.current : run.current?.id)) return;
    if (event.feature === "live" && event.type === "phase") setPhase(String(event.data.phase));
    if (event.feature === "live" && event.type === "transcript" && event.data) setMessage(String(event.data.text ?? ""));
    if (event.type === "closed") {
      if (run.current?.kind === event.feature) cancelRun();
      if (event.feature === "tts") stopSpeech();
      if (event.data?.error) fail(new Error(String(event.data.error)));
    }
    if (event.type === "request") {
      const action = String(event.data.action).toLowerCase(), args = String(event.data.args ?? "").trim(); setPanel(true);
      if (event.feature === "dictation" && action === "stop" && run.current?.kind === "dictation") { void stopDictation(); return; }
      if (["stop", "cancel"].includes(action)) { if (event.feature === "tts") stopSpeech(); else cancelRun(); return; }
      if (event.feature === "tts") {
        if (action === "pause") { player.current?.pause(); setPaused(true); return; }
        if (action === "resume") { void player.current?.resume().catch(fail); setPaused(false); return; }
        if (["speed", "volume"].includes(action) && args && Number.isFinite(Number(args))) { void configure({ [action]: Number(args) }); return; }
        if (["auto", "code", "highlight", "mute"].includes(action)) {
          const key = ({ auto: "autoPlay", code: "readCode", highlight: "highlightEnabled", mute: "muted" } as const)[action as "auto" | "code" | "highlight" | "mute"];
          if (!["", "toggle", "on", "off"].includes(args)) { setMessage("Choose on, off or toggle."); return; }
          void configure({ [key]: args === "on" ? true : args === "off" ? false : !settingsRef.current[key] }); return;
        }
        if (action === "voice") {
          if (args) void configure({ voice: args });
          else void initialize().then(session => raw(session, "tts", "voices")).then(response => response.json()).then(setVoices).catch(fail);
          return;
        }
        if (["play", "replay", "previous", "next"].includes(action) && player.current) { speak(action === "previous" ? -1 : action === "next" ? 1 : 0); return; }
      }
      setMessage("Use the voice buttons to grant microphone/audio permission on this device.");
    }
  };
  useEffect(() => {
    if (!host) return;
    const list = visibleItems(host), previous = itemsRef.current;
    const historyChanged = previous.some((item, index) => list[index]?.id !== item.id);
    itemsRef.current = list;
    if (historyChanged) { stopSpeech(); list.forEach(item => autoSeen.current.add(item.id)); return; }
    if (!autoReady.current) { list.forEach(item => autoSeen.current.add(item.id)); autoReady.current = true; return; }
    for (const item of list) {
      if (autoSeen.current.has(item.id)) continue;
      autoSeen.current.add(item.id);
      if (settingsRef.current.autoPlay && item.role === "assistant" && !run.current && !document.hidden) { if (queue.current.length < 100) queue.current.push(item); void pump(); }
    }
  }, [host?.messages, host?.entryIds, pump, stopSpeech, host]);
  const previousHost = useRef(host);
  useEffect(() => {
    const previous = previousHost.current; previousHost.current = host;
    if (!host) return;
    if (previous && previous.key !== host.key && !(previous.isNew && !host.isNew && host.sessionId === sid.current)) {
      ++generation.current; cancelRun(); stopSpeech(); events.current?.close(); events.current = undefined; sid.current = undefined; initTask.current = undefined;
      autoSeen.current.clear(); autoReady.current = false; setFeatures(null); setMessage("");
    }
    if (host.sessionId) void initialize().catch(fail);
  }, [host?.key, host?.sessionId, initialize, cancelRun, stopSpeech, fail, host]);
  useEffect(() => {
    mounted.current = true;
    const hide = () => { if (document.hidden) { cancelRun(); stopSpeech(); } };
    const key = (event: KeyboardEvent) => {
      if (event.repeat || event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if ((event.altKey && event.code === "KeyM") || (event.ctrlKey && event.code === "Space")) { event.preventDefault(); void dictate(); }
      if (event.ctrlKey && event.shiftKey && event.code === "KeyL") { event.preventDefault(); void live(); }
      if (event.ctrlKey && event.altKey && event.code === "KeyV") { event.preventDefault(); setPanel(value => !value); }
      if (event.key === "Escape") setPanel(false);
      if (event.key === "Escape" && run.current) { event.preventDefault(); cancelRun(); }
    };
    document.addEventListener("visibilitychange", hide); document.addEventListener("keydown", key);
    return () => { mounted.current = false; ++generation.current; cancelRun(); stopSpeech(); events.current?.close(); document.removeEventListener("visibilitychange", hide); document.removeEventListener("keydown", key); };
  }, [cancelRun, stopSpeech, dictate, live]);
  if (!host) return null;
  const enabled = (feature: string) => features === null || features.includes(feature);
  const busy = phase !== "idle";
  const available = features === null || features.length > 0;
  if (!available) return null;
  const icon = (kind: string) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{kind === "mic" ? <><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8"/></> : kind === "live" ? <><path d="M3 10v4M7 6v12M12 2v20M17 6v12M21 10v4"/></> : kind === "speaker" ? <><path d="m11 4-6 5H2v6h3l6 5zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/></> : <><circle cx="12" cy="12" r="3"/><path d="m12 2 2 4 4 1 1 4 3 1-3 2-1 4-4 1-2 3-2-3-4-1-1-4-3-2 3-1 1-4 4-1z"/></>}</svg>;
  return <div className="pi-voice-controls" data-voice-version="1">
    {enabled("dictation") && <button type="button" className={run.current?.kind === "dictation" ? "active recording" : ""} aria-label={run.current?.kind === "dictation" ? "Stop dictation" : "Start dictation"} title="Dictation · tap to toggle, hold to talk · Alt+M" onPointerDown={() => { held.current = false; hold.current = setTimeout(() => { held.current = true; if (!run.current) void dictate(); }, 300); }} onPointerUp={() => { clearTimeout(hold.current); if (held.current) void stopDictation(); }} onPointerCancel={() => { clearTimeout(hold.current); if (held.current) cancelRun(); }} onKeyDown={event => { if (event.code === "Space" && !event.ctrlKey && !event.altKey) { event.preventDefault(); if (!event.repeat) { held.current = true; if (!run.current) void dictate(); } } }} onKeyUp={event => { if (event.code === "Space" && held.current) { event.preventDefault(); void stopDictation(); } }} onContextMenu={event => event.preventDefault()} onClick={() => { if (!held.current) void dictate(); }} disabled={phase === "transcribing"}>{icon("mic")}</button>}
    {enabled("live") && <button type="button" className={run.current?.kind === "live" ? "active" : ""} aria-label={run.current?.kind === "live" ? "Stop Live voice" : "Start Live voice"} title="Live conversation · Ctrl+Shift+L" onClick={() => void live()}>{icon("live")}</button>}
    {enabled("tts") && <button type="button" className={playing ? "active" : ""} aria-label="Read aloud" title="Read aloud · Ctrl+Alt+V" onClick={() => { setPanel(value => !value); if (!playing) speak(); }}>{icon("speaker")}</button>}
    <button type="button" aria-label="Voice controls" title="Voice controls" onClick={() => { setPanel(value => !value); void initialize().catch(fail); }}>{icon("settings")}</button>
    {(busy || message) && <span className="pi-voice-indicator" title={message || phase}>{busy ? phase : ""}</span>}
    {panel && <section className="pi-voice-panel" role="region" aria-label="Voice controls panel">
      <header><strong>Voice</strong><button type="button" aria-label="Close voice controls" onClick={() => setPanel(false)}>×</button></header>
      <p role="status">{message || (phase === "idle" ? "Audio uses this device." : phase)}</p>
      {busy && <div className="pi-voice-actions"><button type="button" onClick={cancelRun}>Cancel / End</button>{run.current?.kind === "live" && <><button type="button" onClick={() => { const current = run.current!; current.stream?.getAudioTracks().forEach(track => { track.enabled = muted; }); setMuted(!muted); if (current.id) void raw(current.sid, "live", "mute", {}, undefined, current.id).catch(fail); }}>{muted ? "Unmute" : "Mute"}</button><button type="button" onClick={() => { void run.current?.audio?.play().catch(fail); }}>Resume audio</button></>}</div>}
      {enabled("tts") && <>
        <div className="pi-voice-actions"><button type="button" onClick={() => speak(-1)}>Previous</button><button type="button" onClick={() => { if (playing) { if (paused) { void player.current?.resume().catch(fail); setPaused(false); } else { player.current?.pause(); setPaused(true); } } else speak(); }}>{playing ? paused ? "Resume" : "Pause" : "Play"}</button><button type="button" onClick={stopSpeech}>Stop</button><button type="button" onClick={() => speak(1)}>Next</button></div>
        {word && <p className="pi-voice-word" aria-live="off">{word}</p>}
        <label>Voice <button type="button" aria-label="Browse voices" onClick={async () => { try { setVoices(await (await raw(await initialize(), "tts", "voices")).json()); } catch (error) { fail(error); } }}>Browse voices</button></label>
        {voices.length > 0 && <><input aria-label="Search voices" placeholder="Search name, language, region or gender" value={search} onChange={event => setSearch(event.target.value)}/><select aria-label="Filter voice language" value={language} onChange={event => setLanguage(event.target.value)}><option value="">All languages / regions</option>{[...new Set(voices.map(voice => voice.locale))].sort().map(locale => <option key={locale}>{locale}</option>)}</select><div className="pi-voice-picker">{voices.filter(voice => (!language || voice.locale === language) && `${voice.friendlyName} ${voice.locale} ${voice.gender ?? ""} ${voice.name}`.toLowerCase().includes(search.toLowerCase())).slice(0, 80).map(voice => <button type="button" key={voice.code} aria-pressed={settings.voice === voice.code} onClick={() => { void configure({ voice: voice.code }); }}>{voice.friendlyName}<small>{voice.locale} · {voice.gender}</small></button>)}</div></>}
        <label>Speed <input aria-label="Speech speed" type="range" min="0.5" max="2" step="0.05" value={settings.speed} onChange={event => void configure({ speed: Number(event.target.value) })}/><span>{settings.speed}×</span></label>
        <label>Volume <input aria-label="Speech volume" type="range" min="0" max="100" value={settings.volume} onChange={event => void configure({ volume: Number(event.target.value) })}/></label>
        <label><input type="checkbox" checked={settings.autoPlay} onChange={event => { player.current ??= new SpeechPlayer(); player.current.prime(); void configure({ autoPlay: event.target.checked }); }}/>Auto-read updates and final replies</label>
        <label><input type="checkbox" checked={settings.muted} onChange={event => void configure({ muted: event.target.checked })}/>Mute speech</label>
        <label><input type="checkbox" checked={settings.readCode} onChange={event => void configure({ readCode: event.target.checked })}/>Read code</label>
        <label><input type="checkbox" checked={settings.highlightEnabled} onChange={event => void configure({ highlightEnabled: event.target.checked })}/>Highlight spoken prose</label>
      </>}
    </section>}
  </div>;
}
