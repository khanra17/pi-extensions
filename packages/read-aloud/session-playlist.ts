import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { isRecord, textContent, messagePhase } from "../../shared/messages.ts";

export type PlayableMessageRole = "user" | "assistant";

export interface PlayableSessionMessage {
	id: string;
	role: PlayableMessageRole;
	text: string;
	phase?: "commentary" | "final";
}

/** Build the read-aloud order from the same depth-first tree shown by /tree. */
export function buildSessionPlaylist(
	roots: readonly SessionTreeNode[],
): PlayableSessionMessage[] {
	const playlist: PlayableSessionMessage[] = [];
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) continue;
		const playable = playableMessageFromEntry(node.entry);
		if (playable) playlist.push(playable);
		for (let index = node.children.length - 1; index >= 0; index -= 1) {
			const child = node.children[index];
			if (child) stack.push(child);
		}
	}
	return playlist;
}

export function playableMessageFromEntry(
	entry: SessionTreeNode["entry"],
): PlayableSessionMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message as unknown;
	if (!isRecord(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = textContent(message.content);
	if (!text) return undefined;
	return { id: entry.id, role: message.role, text, phase: message.role === "assistant" ? messagePhase(message) ?? (message.stopReason === "stop" ? "final" : "commentary") : undefined };
}
