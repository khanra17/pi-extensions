// Extension-owned coordination only; no Pi or Pi Web registries are touched.
const KEY = Symbol.for("@khanra17/pi-extension-kit/microphone/v1");
type Owner = { sessionId: string; kind: "dictation" | "live"; token: symbol };
const globals = globalThis as typeof globalThis & { [KEY]?: Map<string, Owner> };
const owners = globals[KEY] ??= new Map<string, Owner>();

export function claimMicrophone(sessionId: string, kind: Owner["kind"]): () => void {
	const current = owners.get(sessionId);
	if (current) throw new Error(`${current.kind === "live" ? "Live voice" : "Dictation"} is active. Stop it before starting ${kind}.`);
	const token = Symbol(kind);
	owners.set(sessionId, { sessionId, kind, token });
	return () => { if (owners.get(sessionId)?.token === token) owners.delete(sessionId); };
}
