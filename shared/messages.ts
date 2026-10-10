export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Only visible text: never thinking, tool input, or tool results. */
export function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter(isRecord).filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n").trim();
}

export function assistantText(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || message.stopReason === "error" || message.stopReason === "aborted") return "";
	return textContent(message.content);
}

export function messagePhase(message: unknown): "commentary" | "final" | undefined {
	if (!isRecord(message) || !Array.isArray(message.content)) return;
	let commentary = false;
	for (const part of message.content) {
		if (!isRecord(part) || part.type !== "text" || typeof part.textSignature !== "string") continue;
		try {
			const signature: unknown = JSON.parse(part.textSignature);
			if (isRecord(signature) && signature.phase === "final_answer") return "final";
			if (isRecord(signature) && signature.phase === "commentary") commentary = true;
		} catch { /* Legacy providers have no phase annotations. */ }
	}
	return commentary ? "commentary" : undefined;
}
