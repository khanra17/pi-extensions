import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pcmToWav } from "./audio.ts";
export { pcmToWav } from "./audio.ts";

export interface AudioRecorder {
	stop(): Promise<Uint8Array>;
	cancel(): Promise<void>;
	onPcmChunk?(listener: (chunk: Uint8Array) => void): () => void;
}

export interface AudioRecorderOptions {
	streamPcm?: boolean;
}

const START_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 10_000;
const TARGET_SAMPLE_RATE = 24_000;
const MAX_DIAGNOSTIC_BYTES = 16_384;

export function recorderDescription(): string {
	if (process.platform === "win32" && process.env.PI_CODEX_VOICE_RECORDER !== "ffmpeg") {
		return "Windows native microphone (WinMM)";
	}
	const device = process.env.PI_CODEX_VOICE_DEVICE;
	return `ffmpeg${device ? ` · ${device}` : " · default input"}`;
}

/** Windows uses built-in WinMM; other platforms use an existing ffmpeg install. */
export async function createAudioRecorder(options: AudioRecorderOptions = {}): Promise<AudioRecorder> {
	if (process.platform === "win32" && process.env.PI_CODEX_VOICE_RECORDER !== "ffmpeg") {
		if (options.streamPcm) {
			try {
				return await WindowsWaveInRecorder.start();
			} catch (error) {
				if (process.env.PI_CODEX_VOICE_DEBUG === "1") {
					console.warn(`Live WinMM capture unavailable; using MCI fallback: ${error instanceof Error ? error.message : String(error)}`);
				}
				// Keep the reliable MCI file recorder as the Windows fallback when live capture is unavailable.
			}
		}
		return WindowsMciRecorder.start();
	}
	return FfmpegRecorder.start(options.streamPcm === true);
}

interface ProcessExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

class ProcessMonitor {
	readonly exit: Promise<ProcessExit>;
	private stderrText = "";

	constructor(readonly child: ChildProcessWithoutNullStreams) {
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.stderrText = `${this.stderrText}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
		});
		child.stdin.on("error", () => {
			// A useful process-exit error is reported by callers instead.
		});
		this.exit = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code, signal) => resolve({ code, signal }));
		});
		// A recorder can exit before stop() is called; keep that rejection handled.
		void this.exit.catch(() => undefined);
	}

	stderr(): string {
		return compact(this.stderrText);
	}
}

class WindowsWaveInRecorder implements AudioRecorder {
	private finalized = false;
	private readonly pcmChunks: Uint8Array[] = [];
	private readonly pcmListeners = new Set<(chunk: Uint8Array) => void>();

	private constructor(
		private readonly directory: string,
		private readonly stopPath: string,
		private readonly monitor: ProcessMonitor,
		initialPcm: Uint8Array,
	) {
		if (initialPcm.byteLength) this.emitPcm(initialPcm);
		this.monitor.child.stdout.on("data", (chunk: Buffer | string) => this.emitPcm(Buffer.from(chunk)));
	}

	static async start(): Promise<WindowsWaveInRecorder> {
		const directory = await mkdtemp(join(tmpdir(), "pi-codex-voice-"));
		const stopPath = join(directory, "control");
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				makeWindowsWaveInScript(stopPath),
			],
			{ windowsHide: true, stdio: "pipe" },
		);
		const monitor = new ProcessMonitor(child);
		try {
			const initialPcm = await waitForWaveInReady(monitor);
			return new WindowsWaveInRecorder(directory, stopPath, monitor, initialPcm);
		} catch (error) {
			await terminate(monitor);
			await cleanup(directory);
			throw error;
		}
	}

	async stop(): Promise<Uint8Array> {
		if (this.finalized) throw new Error("Microphone recording has already ended.");
		this.finalized = true;
		try {
			await writeControlFile(this.stopPath, "save");
			const result = await waitForExitOrTerminate(this.monitor, STOP_TIMEOUT_MS, "Timed out stopping microphone capture");
			assertSuccessfulExit(result, this.monitor, "Windows microphone capture failed");
			const pcm = concatBytes(this.pcmChunks);
			if (pcm.byteLength < 2) throw new Error("Microphone recording was empty.");
			return pcmToWav(pcm, TARGET_SAMPLE_RATE);
		} catch (error) {
			await terminate(this.monitor);
			throw error;
		} finally {
			await cleanup(this.directory);
		}
	}

	async cancel(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		try {
			await writeControlFile(this.stopPath, "cancel").catch(() => undefined);
			await waitForExitOrTerminate(this.monitor, STOP_TIMEOUT_MS, "Timed out cancelling microphone capture").catch(
				() => undefined,
			);
		} finally {
			await cleanup(this.directory);
		}
	}

	onPcmChunk(listener: (chunk: Uint8Array) => void): () => void {
		this.pcmListeners.add(listener);
		for (const chunk of this.pcmChunks) listener(chunk);
		return () => this.pcmListeners.delete(listener);
	}

	private emitPcm(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		const copy = new Uint8Array(chunk);
		this.pcmChunks.push(copy);
		for (const listener of this.pcmListeners) {
			try {
				listener(copy);
			} catch {
				// A transcription observer must not stop microphone capture.
			}
		}
	}
}

class WindowsMciRecorder implements AudioRecorder {
	private finalized = false;

	private constructor(
		private readonly directory: string,
		private readonly outputPath: string,
		private readonly stopPath: string,
		private readonly monitor: ProcessMonitor,
	) {}

	static async start(): Promise<WindowsMciRecorder> {
		const directory = await mkdtemp(join(tmpdir(), "pi-codex-voice-"));
		const outputPath = join(directory, "recording.wav");
		const stopPath = join(directory, "control");
		const child = spawn(
			"powershell.exe",
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				makeWindowsRecorderScript(outputPath, stopPath),
			],
			{ windowsHide: true, stdio: "pipe" },
		);
		const monitor = new ProcessMonitor(child);

		try {
			await waitForWindowsReady(monitor);
			return new WindowsMciRecorder(directory, outputPath, stopPath, monitor);
		} catch (error) {
			await terminate(monitor);
			await cleanup(directory);
			throw error;
		}
	}

	async stop(): Promise<Uint8Array> {
		if (this.finalized) throw new Error("Microphone recording has already ended.");
		this.finalized = true;
		try {
			await writeControlFile(this.stopPath, "save");
			const result = await waitForExitOrTerminate(this.monitor, STOP_TIMEOUT_MS, "Timed out stopping microphone capture");
			assertSuccessfulExit(result, this.monitor, "Windows microphone capture failed");
			const audio = await readFile(this.outputPath);
			if (audio.byteLength < 64) throw new Error("Microphone recording was empty.");
			return audio;
		} catch (error) {
			await terminate(this.monitor);
			throw error;
		} finally {
			await cleanup(this.directory);
		}
	}

	async cancel(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		try {
			await writeControlFile(this.stopPath, "cancel").catch(() => undefined);
			await waitForExitOrTerminate(this.monitor, STOP_TIMEOUT_MS, "Timed out cancelling microphone capture").catch(
				() => undefined,
			);
		} finally {
			await cleanup(this.directory);
		}
	}
}

class FfmpegRecorder implements AudioRecorder {
	private finalized = false;
	private readonly pcmChunks: Uint8Array[] = [];
	private readonly pcmListeners = new Set<(chunk: Uint8Array) => void>();

	private constructor(
		private readonly directory: string,
		private readonly outputPath: string,
		private readonly monitor: ProcessMonitor,
		streamPcm: boolean,
	) {
		if (streamPcm) {
			this.monitor.child.stdout.on("data", (chunk: Buffer | string) => this.emitPcm(Buffer.from(chunk)));
		}
	}

	static async start(streamPcm: boolean): Promise<FfmpegRecorder> {
		const executable = process.env.PI_CODEX_VOICE_FFMPEG || "ffmpeg";
		await probeExecutable(executable);
		const directory = await mkdtemp(join(tmpdir(), "pi-codex-voice-"));
		let monitor: ProcessMonitor | undefined;
		try {
			const outputPath = join(directory, "recording.wav");
			const args = await ffmpegArguments(executable, outputPath, streamPcm);
			monitor = new ProcessMonitor(spawn(executable, args, { stdio: "pipe", windowsHide: true }));
			const recorder = new FfmpegRecorder(directory, outputPath, monitor, streamPcm);
			await waitForSpawn(monitor);
			await ensureStillRunning(monitor, 250);
			return recorder;
		} catch (error) {
			if (monitor) await terminate(monitor);
			await cleanup(directory);
			throw error;
		}
	}

	async stop(): Promise<Uint8Array> {
		if (this.finalized) throw new Error("Microphone recording has already ended.");
		this.finalized = true;
		try {
			this.monitor.child.stdin.write("q\n");
			const result = await waitForExitOrTerminate(
				this.monitor,
				STOP_TIMEOUT_MS,
				"Timed out stopping ffmpeg microphone capture",
			);
			assertSuccessfulExit(result, this.monitor, "ffmpeg microphone capture failed");
			const audio = await readFile(this.outputPath);
			if (audio.byteLength < 64) throw new Error("Microphone recording was empty.");
			return audio;
		} catch (error) {
			await terminate(this.monitor);
			throw error;
		} finally {
			await cleanup(this.directory);
		}
	}

	onPcmChunk(listener: (chunk: Uint8Array) => void): () => void {
		this.pcmListeners.add(listener);
		for (const chunk of this.pcmChunks) listener(chunk);
		return () => this.pcmListeners.delete(listener);
	}

	private emitPcm(chunk: Uint8Array): void {
		if (chunk.byteLength === 0) return;
		const copy = new Uint8Array(chunk);
		this.pcmChunks.push(copy);
		for (const listener of this.pcmListeners) {
			try {
				listener(copy);
			} catch {
				// A transcription observer must not stop microphone capture.
			}
		}
	}

	async cancel(): Promise<void> {
		if (this.finalized) return;
		this.finalized = true;
		try {
			await terminate(this.monitor);
		} finally {
			await cleanup(this.directory);
		}
	}
}

function makeWindowsWaveInScript(stopPath: string): string {
	return `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class PiCodexVoiceWaveIn {
    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEFORMATEX {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct WAVEHDR {
        public IntPtr lpData;
        public uint dwBufferLength;
        public uint dwBytesRecorded;
        public IntPtr dwUser;
        public uint dwFlags;
        public uint dwLoops;
        public IntPtr lpNext;
        public IntPtr reserved;
    }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate void WaveInProc(IntPtr hwi, uint message, IntPtr instance, IntPtr header, IntPtr reserved);
    [DllImport("winmm.dll")] private static extern uint waveInOpen(out IntPtr handle, uint device, ref WAVEFORMATEX format, WaveInProc callback, IntPtr instance, uint flags);
    [DllImport("winmm.dll")] private static extern uint waveInPrepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInUnprepareHeader(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInAddBuffer(IntPtr handle, IntPtr header, uint size);
    [DllImport("winmm.dll")] private static extern uint waveInStart(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveInStop(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveInReset(IntPtr handle);
    [DllImport("winmm.dll")] private static extern uint waveInClose(IntPtr handle);
    private const uint CALLBACK_FUNCTION = 0x00030000;
    private const uint WIM_DATA = 0x03C0;
    private const int BUFFER_COUNT = 4;
    private const int BUFFER_BYTES = 9600;
    private static readonly object Gate = new object();
    private static readonly WaveInProc Callback = OnWaveIn;
    private static IntPtr Handle;
    private static IntPtr[] Headers;
    private static IntPtr[] Buffers;
    private static Stream Output;
    private static bool Opened;
    public static string Error(uint code) { return "WinMM error " + code; }
    public static void Open(Stream output) {
        Output = output;
        var format = new WAVEFORMATEX {
            wFormatTag = 1, nChannels = 1, nSamplesPerSec = 24000,
            nAvgBytesPerSec = 48000, nBlockAlign = 2, wBitsPerSample = 16, cbSize = 0
        };
        var result = waveInOpen(out Handle, 0xFFFFFFFF, ref format, Callback, IntPtr.Zero, CALLBACK_FUNCTION);
        if (result != 0) throw new InvalidOperationException(Error(result));
        Headers = new IntPtr[BUFFER_COUNT];
        Buffers = new IntPtr[BUFFER_COUNT];
        var size = (uint)Marshal.SizeOf(typeof(WAVEHDR));
        try {
            for (var index = 0; index < BUFFER_COUNT; index++) {
                Buffers[index] = Marshal.AllocHGlobal(BUFFER_BYTES);
                Headers[index] = Marshal.AllocHGlobal((int)size);
                var header = new WAVEHDR { lpData = Buffers[index], dwBufferLength = BUFFER_BYTES };
                Marshal.StructureToPtr(header, Headers[index], false);
                result = waveInPrepareHeader(Handle, Headers[index], size);
                if (result != 0) throw new InvalidOperationException(Error(result));
                result = waveInAddBuffer(Handle, Headers[index], size);
                if (result != 0) throw new InvalidOperationException(Error(result));
            }
            Opened = true;
        } catch {
            Close();
            throw;
        }
    }
    public static void Begin() {
        var result = waveInStart(Handle);
        if (result != 0) throw new InvalidOperationException(Error(result));
    }
    private static void OnWaveIn(IntPtr handle, uint message, IntPtr instance, IntPtr headerPointer, IntPtr reserved) {
        if (message != WIM_DATA || headerPointer == IntPtr.Zero || Output == null) return;
        var header = Marshal.PtrToStructure<WAVEHDR>(headerPointer);
        if (header.dwBytesRecorded > 0) {
            var bytes = new byte[header.dwBytesRecorded];
            Marshal.Copy(header.lpData, bytes, 0, bytes.Length);
            lock (Gate) { Output.Write(bytes, 0, bytes.Length); Output.Flush(); }
        }
        if (Opened) waveInAddBuffer(handle, headerPointer, (uint)Marshal.SizeOf(typeof(WAVEHDR)));
    }
    public static void Close() {
        Opened = false;
        try { if (Handle != IntPtr.Zero) { waveInStop(Handle); waveInReset(Handle); } } catch { }
        var size = (uint)Marshal.SizeOf(typeof(WAVEHDR));
        if (Headers != null) for (var index = 0; index < Headers.Length; index++) {
            try { if (Handle != IntPtr.Zero && Headers[index] != IntPtr.Zero) waveInUnprepareHeader(Handle, Headers[index], size); } catch { }
            try { if (Headers[index] != IntPtr.Zero) Marshal.FreeHGlobal(Headers[index]); } catch { }
            try { if (Buffers[index] != IntPtr.Zero) Marshal.FreeHGlobal(Buffers[index]); } catch { }
        }
        try { if (Handle != IntPtr.Zero) waveInClose(Handle); } catch { }
        Handle = IntPtr.Zero; Headers = null; Buffers = null; Opened = false;
        try { if (Output != null) Output.Flush(); } catch { }
    }
}
'@
Add-Type -TypeDefinition $source
$stopPath = ${quotePowerShell(stopPath)}
$output = [Console]::OpenStandardOutput()
try {
    [PiCodexVoiceWaveIn]::Open($output)
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    [PiCodexVoiceWaveIn]::Begin()
    while (-not [System.IO.File]::Exists($stopPath)) { Start-Sleep -Milliseconds 40 }
    $action = $null
    while ($null -eq $action) {
        try { $action = [System.IO.File]::ReadAllText($stopPath).Trim() }
        catch [System.IO.IOException] { Start-Sleep -Milliseconds 20 }
    }
    [PiCodexVoiceWaveIn]::Close()
    exit 0
} catch {
    try { [PiCodexVoiceWaveIn]::Close() } catch { }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;
}

function makeWindowsRecorderScript(outputPath: string, stopPath: string): string {
	return `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PiCodexVoiceMci {
    [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciSendStringW")]
    public static extern uint Send(string command, StringBuilder returnValue, uint returnLength, IntPtr callback);
    [DllImport("winmm.dll", CharSet = CharSet.Unicode, EntryPoint = "mciGetErrorStringW")]
    public static extern bool GetError(uint errorCode, StringBuilder errorText, uint errorTextLength);
    public static string Error(uint code) {
        var text = new StringBuilder(256);
        return GetError(code, text, 256) ? text.ToString() : ("MCI error " + code);
    }
}
'@
Add-Type -TypeDefinition $source
$outputPath = ${quotePowerShell(outputPath)}
$stopPath = ${quotePowerShell(stopPath)}
$alias = 'PiCodexVoice'
function Invoke-Mci([string]$command) {
    $result = [PiCodexVoiceMci]::Send($command, $null, 0, [IntPtr]::Zero)
    if ($result -ne 0) { throw ([PiCodexVoiceMci]::Error($result)) }
}
try {
    Invoke-Mci ("open new type waveaudio alias " + $alias)
    try {
        Invoke-Mci ("set " + $alias + " bitspersample 16 channels 1 samplespersec ${TARGET_SAMPLE_RATE} alignment 2 bytespersec ${TARGET_SAMPLE_RATE * 2}")
    } catch {
        # Some legacy WinMM drivers do not advertise 24 kHz; 16 kHz PCM is also accepted by ASR.
        Invoke-Mci ("set " + $alias + " bitspersample 16 channels 1 samplespersec 16000 alignment 2 bytespersec 32000")
    }
    Invoke-Mci ("record " + $alias)
    [Console]::Out.WriteLine('READY')
    [Console]::Out.Flush()
    while (-not [System.IO.File]::Exists($stopPath)) { Start-Sleep -Milliseconds 40 }
    $action = $null
    while ($null -eq $action) {
        try {
            $action = [System.IO.File]::ReadAllText($stopPath).Trim()
        } catch [System.IO.IOException] {
            Start-Sleep -Milliseconds 20
        }
    }
    if ($action -eq 'save') {
        Invoke-Mci ("save " + $alias + ' "' + $outputPath + '"')
    } else {
        Invoke-Mci ("stop " + $alias)
    }
    Invoke-Mci ("close " + $alias)
    exit 0
} catch {
    try { [PiCodexVoiceMci]::Send(("close " + $alias), $null, 0, [IntPtr]::Zero) } catch { }
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
`;
}

function quotePowerShell(value: string): string {
	return `'${value.replace(/'/gu, "''")}'`;
}

/** Publish recorder commands atomically so PowerShell never observes a half-written file. */
async function writeControlFile(controlPath: string, action: "save" | "cancel"): Promise<void> {
	const pendingPath = `${controlPath}.pending`;
	await writeFile(pendingPath, action, "utf8");
	await rename(pendingPath, controlPath);
}

async function ffmpegArguments(executable: string, outputPath: string, streamPcm: boolean): Promise<string[]> {
	const common = [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
	];
	const output = ["-ac", "1", "-ar", String(TARGET_SAMPLE_RATE), "-c:a", "pcm_s16le", "-f", "wav", outputPath];
	const streamedOutput = [
		"-map",
		"0:a:0",
		"-ac",
		"1",
		"-ar",
		String(TARGET_SAMPLE_RATE),
		"-c:a",
		"pcm_s16le",
		"-f",
		"s16le",
		"pipe:1",
	];

	if (process.platform === "win32") {
		const device = process.env.PI_CODEX_VOICE_DEVICE || (await findWindowsAudioDevice(executable));
		if (!device) {
			throw new Error("No DirectShow microphone found. Set PI_CODEX_VOICE_DEVICE or use the built-in Windows recorder.");
		}
		return [...common, "-f", "dshow", "-i", `audio=${device}`, ...(streamPcm ? [...output, ...streamedOutput] : output)];
	}
	if (process.platform === "darwin") {
		const device = process.env.PI_CODEX_VOICE_DEVICE || ":0";
		return [...common, "-f", "avfoundation", "-i", device, ...(streamPcm ? [...output, ...streamedOutput] : output)];
	}
	const device = process.env.PI_CODEX_VOICE_DEVICE || "default";
	return [...common, "-f", "pulse", "-i", device, ...(streamPcm ? [...output, ...streamedOutput] : output)];
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

async function findWindowsAudioDevice(executable: string): Promise<string | undefined> {
	const result = await runAndCollect(executable, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"]);
	const lines = result.output.split(/\r?\n/u);
	let audioSection = false;
	for (const line of lines) {
		if (/directshow audio devices/iu.test(line)) audioSection = true;
		else if (/directshow video devices/iu.test(line)) audioSection = false;
		if (!audioSection) continue;
		const match = line.match(/"([^"\r\n]+)"/u);
		if (match?.[1]) return match[1];
	}
	return undefined;
}

async function probeExecutable(executable: string): Promise<void> {
	const result = await runAndCollect(executable, ["-version"]);
	if (result.spawnError || result.timedOut || result.code !== 0) {
		throw new Error(
			`ffmpeg is required for voice input on ${process.platform}. Install it or set PI_CODEX_VOICE_FFMPEG to its executable path.`,
		);
	}
}

interface CollectedProcess {
	output: string;
	code: number | null;
	spawnError?: Error;
	timedOut: boolean;
}

function runAndCollect(command: string, args: string[]): Promise<CollectedProcess> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let output = "";
		let spawnError: Error | undefined;
		let timedOut = false;
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ output, code, spawnError, timedOut });
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
			finish(null);
		}, START_TIMEOUT_MS);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		const append = (chunk: string) => {
			output = `${output}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
		};
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => {
			spawnError = error;
			finish(null);
		});
		child.once("close", (code) => finish(code));
	});
}

function waitForWindowsReady(monitor: ProcessMonitor): Promise<void> {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			monitor.child.stdout.off("data", onData);
			error ? reject(error) : resolve();
		};
		const onData = (chunk: Buffer | string) => {
			stdout += chunk.toString();
			if (/\bREADY\b/u.test(stdout)) finish();
		};
		const timer = setTimeout(() => finish(new Error("Windows could not start microphone capture.")), START_TIMEOUT_MS);
		monitor.child.stdout.on("data", onData);
		void monitor.exit.then(
			(result) => {
				if (!settled) {
					finish(processExitError("Windows microphone capture exited during startup", result, monitor));
				}
			},
			(error: unknown) => finish(asError(error)),
		);
	});
}

function waitForWaveInReady(monitor: ProcessMonitor): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const marker = Buffer.from("READY\r\n");
		const alternateMarker = Buffer.from("READY\n");
		let buffered = Buffer.alloc(0);
		let settled = false;
		const finish = (error?: Error, initialPcm?: Uint8Array): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			monitor.child.stdout.off("data", onData);
			monitor.exit.then(undefined, () => undefined);
			if (error) reject(error);
			else resolve(initialPcm ?? new Uint8Array());
		};
		const onData = (chunk: Buffer | string): void => {
			buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
			const crlfIndex = buffered.indexOf(marker);
			const lfIndex = buffered.indexOf(alternateMarker);
			const index = crlfIndex >= 0 && (lfIndex < 0 || crlfIndex <= lfIndex) ? crlfIndex : lfIndex;
			if (index < 0) return;
			const markerLength = crlfIndex >= 0 && crlfIndex <= index ? marker.length : alternateMarker.length;
			finish(undefined, new Uint8Array(buffered.subarray(index + markerLength)));
		};
		const timer = setTimeout(() => finish(new Error("Windows could not start streaming microphone capture.")), START_TIMEOUT_MS);
		monitor.child.stdout.on("data", onData);
		void monitor.exit.then(
			(result) => {
				if (!settled) finish(processExitError("Windows streaming microphone capture exited during startup", result, monitor));
			},
			(error: unknown) => {
				if (!settled) finish(asError(error));
			},
		);
	});
}

function waitForSpawn(monitor: ProcessMonitor): Promise<void> {
	return withTimeout(
		new Promise<void>((resolve, reject) => {
			monitor.child.once("spawn", resolve);
			monitor.child.once("error", reject);
		}),
		START_TIMEOUT_MS,
		"ffmpeg did not start microphone capture.",
	);
}

async function ensureStillRunning(monitor: ProcessMonitor, milliseconds: number): Promise<void> {
	await Promise.race([
		delay(milliseconds),
		monitor.exit.then(
			(result) => Promise.reject(processExitError("ffmpeg microphone capture exited during startup", result, monitor)),
			(error: unknown) => Promise.reject(asError(error)),
		),
	]);
}

async function waitForExitOrTerminate(
	monitor: ProcessMonitor,
	timeoutMs: number,
	message: string,
): Promise<ProcessExit> {
	try {
		return await withTimeout(monitor.exit, timeoutMs, message);
	} catch (error) {
		await terminate(monitor);
		throw error;
	}
}

async function terminate(monitor: ProcessMonitor): Promise<void> {
	if (monitor.child.exitCode === null && monitor.child.signalCode === null) monitor.child.kill();
	await withTimeout(monitor.exit, 2_000, "Recorder process did not exit.").catch(() => undefined);
}

function assertSuccessfulExit(result: ProcessExit, monitor: ProcessMonitor, prefix: string): void {
	if (result.code === 0) return;
	throw processExitError(prefix, result, monitor);
}

function processExitError(prefix: string, result: ProcessExit, monitor: ProcessMonitor): Error {
	const reason = result.signal ? ` (signal ${result.signal})` : result.code === null ? "" : ` (exit ${result.code})`;
	const detail = monitor.stderr();
	return new Error(`${prefix}${reason}${detail ? `: ${detail}` : ""}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function cleanup(directory: string): Promise<void> {
	return rm(directory, { recursive: true, force: true }).catch(() => undefined);
}

function compact(text: string): string {
	return text.replace(/\s+/gu, " ").trim().slice(0, 300);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
