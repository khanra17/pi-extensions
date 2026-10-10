import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CodexVoiceAuth } from "../../shared/codex.ts";
import { textContent } from "../../shared/messages.ts";
import { requestBrowser } from "../../shared/browser.ts";
import { LiveSessionController, type LiveSessionControllerOptions, type LiveTranscript } from "./controller.ts";
import { buildLiveStartupContext } from "./context.ts";
import { attachFocusReporting, probeFocusReporting, type FocusTerminalHandle } from "./focus.ts";
import {
	LIVE_QUEUE_TICK_MS,
	LiveFloorArbiter,
	type LiveActivationCause,
	type LiveFloorArbiterCallbacks,
	type LiveFloorArbiterLike,
	type LiveFloorArbiterOptions,
} from "./queue.ts";
import { LiveVisualizer, LIVE_VISUALIZER_TOGGLE_KEY } from "./visualizer.ts";

export const LIVE_COMMAND = "live";
export const LIVE_DELEGATION_MESSAGE_TYPE = "pi-codex-voice-live-delegation";
export const LIVE_FOCUS_SETTLE_MS = 400;

interface LiveSessionRuntime {
	start(): Promise<void>;
	stop(): Promise<void>;
	toggleMute(): void;
	handleAgentMessage(message: unknown): void;
	handleAgentSettled(): void;
}

interface ActiveLiveRun {
	getSession(): LiveSessionRuntime | undefined;
	finishUi(result: LiveUiResult): void;
	dispose(): Promise<void>;
}

type LiveUiResult = { error?: Error };
type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionRuntime;
type LiveArbiterFactory = (
	options: LiveFloorArbiterOptions,
	callbacks: LiveFloorArbiterCallbacks,
) => LiveFloorArbiterLike;

export interface LiveRegistrationOptions {
	getAuth(ctx: ExtensionContext, signal?: AbortSignal): Promise<CodexVoiceAuth>;
	getVoice(): string;
	prepare?: () => Promise<void>;
	isEnabled?: () => boolean;
	isDictationBusy?: () => boolean;
	createSession?: LiveSessionFactory;
	createArbiter?: LiveArbiterFactory;
	probeFocusReporting?: typeof probeFocusReporting;
	attachFocusReporting?: typeof attachFocusReporting;
	notifyActivatedUnfocused?: (handle: FocusTerminalHandle, label: string) => void;
	tickMs?: number;
	handleCommand?: (
		args: string,
		ctx: ExtensionContext,
		registration: LiveRegistration,
	) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
}

export interface LiveRegistration {
	toggle(ctx: ExtensionContext): Promise<void>;
	stop(): Promise<void>;
	isActive(): boolean;
}

// OSC 9 notifications must never carry terminal control characters.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;

export function notifyActivatedUnfocused(handle: FocusTerminalHandle, label: string): void {
	const safeLabel = label.replace(CONTROL_CHARACTER_PATTERN, " ").trim();
	try {
		handle.write(`\x1b]9;Live voice is now active in ${safeLabel}\x07`);
	} catch {
		// Desktop notifications are optional and terminal-specific.
	}
}

function messageText(content: unknown): string {
	return textContent(content).replace(CONTROL_CHARACTER_PATTERN, " ").trim();
}

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function safeDiagnostic(message: string): string {
	return message.replace(CONTROL_CHARACTER_PATTERN, " ").replace(/\s+/gu, " ").trim().slice(0, 2_048);
}

/** Register Codex Desktop realtime conversation without changing the dictation path. */
export function registerLiveVoice(
	pi: ExtensionAPI,
	options: LiveRegistrationOptions,
): LiveRegistration {
	const createSession =
		options.createSession ?? ((sessionOptions) => new LiveSessionController(sessionOptions));
	const createArbiter =
		options.createArbiter ?? ((arbiterOptions, callbacks) => new LiveFloorArbiter(arbiterOptions, callbacks));
	const probeFocus = options.probeFocusReporting ?? probeFocusReporting;
	const attachFocus = options.attachFocusReporting ?? attachFocusReporting;
	const notifyUnfocused = options.notifyActivatedUnfocused ?? notifyActivatedUnfocused;
	const tickMs = options.tickMs ?? LIVE_QUEUE_TICK_MS;
	let activeRun: ActiveLiveRun | undefined;
	let settling: Promise<void> | undefined;

	async function stopActive(): Promise<void> {
		const run = activeRun;
		if (!run) {
			if (settling) await settling;
			return;
		}
		run.finishUi({});
		await run.dispose();
	}

	async function start(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode === "rpc") { requestBrowser(ctx, "live", "toggle"); return; }
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Live voice requires a terminal or the voice-enabled Pi Web integration.", "warning");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Live voice requires an interactive UI such as Pi Web or Pi CLI.", "warning");
			return;
		}
		try {
			await options.prepare?.();
		} catch (cause) {
			ctx.ui.notify(safeDiagnostic(errorFrom(cause).message), "error");
			return;
		}
		if (options.isEnabled && !options.isEnabled()) {
			ctx.ui.notify("Live voice is disabled. Use /live enabled on to enable it.", "warning");
			return;
		}
		if (options.isDictationBusy?.()) {
			ctx.ui.notify("Stop regular voice dictation before starting live voice.", "info");
			return;
		}
		if (settling) await settling;
		if (activeRun) return;

		let result: LiveUiResult | undefined;
		let panelHandle: { isFocused(): boolean } | undefined;
		try {
			result = await ctx.ui.custom<LiveUiResult>(
			(tui, theme, _keybindings, done) => {
				let completed = false;
				let disposed = false;
				const abortController = new AbortController();
				let session: LiveSessionRuntime | undefined;
				let sessionParked = false;
				let arbiter: LiveFloorArbiterLike | undefined;
				let tickInterval: ReturnType<typeof setInterval> | undefined;
				let focusDebounce: ReturnType<typeof setTimeout> | undefined;
				let disposeFocus: (() => void) | undefined;

				const finishUi = (value: LiveUiResult) => {
					if (completed) return;
					completed = true;
					done(value);
				};

				const visualizer = new LiveVisualizer({
					theme,
					requestRender: () => tui.requestRender(),
					onStop: () => finishUi({}),
					onToggleMute: () => session?.toggleMute(),
					tui: ctx.mode === "tui" ? tui : undefined,
					isFocused: () => !completed && (panelHandle?.isFocused() ?? false),
				});
				visualizer.setPhase("standby");

				const terminalHandle: FocusTerminalHandle | undefined = ctx.mode === "tui" ? {
					write: (data) => tui.terminal.write(data),
					addInputListener: (listener) => tui.addInputListener(listener),
				} : undefined;

				const parkSession = () => {
					const current = session;
					session = undefined;
					sessionParked = true;
					visualizer.setPhase("standby");
					visualizer.setTranscript(undefined);
					if (current) void current.stop().catch(() => undefined);
				};

				const activateSession = () => {
					if (completed || session) return;
					sessionParked = false;
					let created: LiveSessionRuntime;
					try {
						created = createSession({
							sessionId: ctx.sessionManager.getSessionId(),
							signal: abortController.signal,
							voice: options.getVoice(),
							startupContext: buildLiveStartupContext(ctx),
							getAuth: (signal) => options.getAuth(ctx, signal),
							delegate: (request) => {
								pi.sendMessage(
									{
										customType: LIVE_DELEGATION_MESSAGE_TYPE,
										content: request,
										display: true,
										details: { source: "live" },
									},
									{ triggerTurn: true, deliverAs: "steer" },
								);
							},
							callbacks: {
								onPhase: (phase) => visualizer.setPhase(phase),
								onLevels: (input) => visualizer.setInputLevel(input),
								onTranscript: (transcript: LiveTranscript | undefined) =>
									visualizer.setTranscript(transcript),
								onTerminal: (error) => {
									if (sessionParked) return;
									finishUi(error ? { error } : {});
								},
							},
						});
					} catch (cause) {
						finishUi({ error: errorFrom(cause) });
						return;
					}
					session = created;
					setImmediate(() => {
						if (session !== created) return;
						void created.start().catch((cause) => finishUi({ error: errorFrom(cause) }));
					});
				};

				const dispose = async (): Promise<void> => {
					if (disposed) return;
					disposed = true;
					abortController.abort();
					if (focusDebounce) clearTimeout(focusDebounce);
					if (tickInterval) clearInterval(tickInterval);
					disposeFocus?.();
					const current = session;
					session = undefined;
					sessionParked = true;
					arbiter?.leave();
					if (current) await current.stop().catch(() => undefined);
					visualizer.dispose();
				};

				const run: ActiveLiveRun = { getSession: () => session, finishUi, dispose };
				activeRun = run;

				setImmediate(() => {
					void (async () => {
						try {
							const focusSupported = terminalHandle ? await probeFocus(terminalHandle) : false;
							if (completed || disposed) return;
							const enrolled = createArbiter(
								{
									pid: process.pid,
									sessionId: ctx.sessionManager.getSessionId(),
									cwd: ctx.cwd,
									policy: focusSupported ? "focus" : "fifo",
								},
								{
									onActivated: (cause: LiveActivationCause) => {
										if (terminalHandle && cause !== "focus") notifyUnfocused(terminalHandle, enrolled.label);
										activateSession();
									},
									onDeactivated: parkSession,
								},
							);
							arbiter = enrolled;
							enrolled.join();
							tickInterval = setInterval(() => {
								try {
									enrolled.tick();
								} catch {
									// Queue failure must not tear down the visible live panel.
								}
							}, tickMs);
							tickInterval.unref?.();
							if (!focusSupported || !terminalHandle) return;
							disposeFocus = attachFocus(terminalHandle, (focused) => {
								if (focusDebounce) clearTimeout(focusDebounce);
								if (!focused) {
									enrolled.setFocused(false);
									return;
								}
								focusDebounce = setTimeout(() => {
									focusDebounce = undefined;
									try {
										enrolled.setFocused(true);
									} catch {
										// A lost focus race settles on the next heartbeat.
									}
								}, LIVE_FOCUS_SETTLE_MS);
								focusDebounce.unref?.();
							});
						} catch (cause) {
							finishUi({ error: errorFrom(cause) });
						}
					})();
				});

				return visualizer;
			},
			{
				overlay: true,
				onHandle: handle => { panelHandle = handle; },
				overlayOptions: {
					anchor: "bottom-center",
					width: 72,
					minWidth: 36,
					maxHeight: 12,
					margin: { top: 1, right: 1, bottom: 1, left: 1 },
				},
			},
			);
		} catch (cause) {
			const failedRun = captureActiveRun(activeRun);
			if (failedRun) {
				failedRun.finishUi({});
				await failedRun.dispose().catch(() => undefined);
				if (activeRun === failedRun) activeRun = undefined;
			}
			ctx.ui.notify(safeDiagnostic(errorFrom(cause).message), "error");
			return;
		}

		const run = captureActiveRun(activeRun);
		if (run) {
			const cleanup = run.dispose().catch(() => undefined);
			settling = cleanup;
			await cleanup;
			if (activeRun === run) activeRun = undefined;
			if (settling === cleanup) settling = undefined;
		}
		if (result?.error) ctx.ui.notify(safeDiagnostic(result.error.message), "error");
	}

	async function toggle(ctx: ExtensionContext): Promise<void> {
		if (activeRun) {
			activeRun.finishUi({});
			return;
		}
		if (settling) {
			await settling;
			return;
		}
		await start(ctx);
	}

	pi.registerMessageRenderer(LIVE_DELEGATION_MESSAGE_TYPE, (message, _options, theme) => {
		const text = messageText(message.content).trim();
		return new Text(
			`${theme.fg("accent", theme.bold("Live request"))}\n${theme.fg("customMessageText", text)}`,
			1,
			0,
		);
	});

	const registration: LiveRegistration = {
		toggle,
		stop: stopActive,
		isActive: () => activeRun !== undefined || settling !== undefined,
	};

	pi.registerCommand(LIVE_COMMAND, {
		description: "Control Codex realtime voice mode and its response voice",
		getArgumentCompletions: options.getArgumentCompletions,
		handler: async (args, ctx) => {
			if (options.handleCommand) {
				await options.handleCommand(args, ctx, registration);
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /live", "warning");
				return;
			}
			await toggle(ctx);
		},
	});

	pi.registerShortcut(LIVE_VISUALIZER_TOGGLE_KEY, {
		description: "Start or stop Codex realtime voice mode",
		handler: async (ctx) => toggle(ctx),
	});

	pi.on("message_end", (event) => {
		activeRun?.getSession()?.handleAgentMessage(event.message);
	});

	pi.on("agent_settled", () => {
		activeRun?.getSession()?.handleAgentSettled();
	});

	pi.on("session_before_switch", stopActive);
	pi.on("session_before_fork", stopActive);
	pi.on("session_before_tree", stopActive);
	pi.on("session_shutdown", async () => {
		await stopActive();
		activeRun = undefined;
	});

	return registration;
}

function captureActiveRun(run: ActiveLiveRun | undefined): ActiveLiveRun | undefined {
	return run;
}
