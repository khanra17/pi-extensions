import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATE = "pi-codex-fast";

/** Opt-in Codex priority requests only. Does not change models, OAuth, audio or other providers. */
export default function codexFast(pi: ExtensionAPI): void {
	let enabled = false;
	const status = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATE, enabled ? `Fast: ${ctx.model?.provider === "openai-codex" ? "on" : "on (Codex only)"}` : undefined);
	};
	const restore = (ctx: ExtensionContext) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === STATE && isRecord(entry.data) && typeof entry.data.enabled === "boolean") enabled = entry.data.enabled;
		}
		status(ctx);
	};
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => status(ctx));
	pi.on("session_shutdown", (_event, ctx) => { if (ctx.hasUI) ctx.ui.setStatus(STATE, undefined); });
	pi.on("before_provider_request", (event, ctx) => priorityPayload(event.payload, ctx.model, enabled));
	pi.registerCommand("fast", {
		description: "Opt-in priority service tier for OpenAI Codex coding requests",
		getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "status") { ctx.ui.notify(`Codex fast mode is ${enabled ? "on" : "off"}.`, "info"); return; }
			if (!["", "toggle", "on", "off"].includes(action)) { ctx.ui.notify("/fast [on|off|status]", "warning"); return; }
			enabled = action === "on" ? true : action === "off" ? false : !enabled;
			pi.appendEntry(STATE, { enabled });
			status(ctx);
			ctx.ui.notify(enabled ? "Codex fast mode on: requesting priority. Availability and additional quota/cost depend on your account; speed is not guaranteed." : "Codex fast mode off.", "info");
		},
	});
}

export function priorityPayload(payload: unknown, model: { provider: string; api: string; id: string } | undefined, enabled: boolean): unknown {
	if (!enabled || model?.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !isRecord(payload) || payload.model !== model.id) return undefined;
	return { ...payload, service_tier: "priority" };
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
