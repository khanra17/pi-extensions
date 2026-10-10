const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const TARGET_SAMPLE_RATE = 24_000;
const TARGET_CHANNELS = 1;
const NORMALIZED_PEAK = Math.round(32_767 * 0.9);

export interface PreparedWav {
	audio: Uint8Array;
	durationMs?: number;
	normalized: boolean;
	converted: boolean;
}

/** Return the normalized RMS level of a little-endian PCM16 chunk. */
export function pcm16Rms(input: Uint8Array): number {
	const sampleCount = Math.floor(input.byteLength / 2);
	if (sampleCount === 0) return 0;

	let sumSquares = 0;
	for (let index = 0; index < sampleCount; index++) {
		const offset = index * 2;
		const sample = readPcm16Sample(input[offset]!, input[offset + 1]!);
		const normalized = sample / 32_768;
		sumSquares += normalized * normalized;
	}
	return Math.min(1, Math.sqrt(sumSquares / sampleCount));
}

/** Keeps PCM16 sample alignment when a streaming source splits a sample across chunks. */
export class Pcm16RmsMeter {
	private pendingByte: number | undefined;

	update(input: Uint8Array): number | undefined {
		let sumSquares = 0;
		let sampleCount = 0;
		let offset = 0;

		if (this.pendingByte !== undefined) {
			if (input.byteLength === 0) return undefined;
			const normalized = readPcm16Sample(this.pendingByte, input[0]!) / 32_768;
			sumSquares += normalized * normalized;
			sampleCount++;
			this.pendingByte = undefined;
			offset = 1;
		}

		const completeBytes = input.byteLength - ((input.byteLength - offset) % 2);
		for (; offset < completeBytes; offset += 2) {
			const normalized = readPcm16Sample(input[offset]!, input[offset + 1]!) / 32_768;
			sumSquares += normalized * normalized;
			sampleCount++;
		}
		if (offset < input.byteLength) this.pendingByte = input[offset]!;
		return sampleCount === 0 ? undefined : Math.min(1, Math.sqrt(sumSquares / sampleCount));
	}

	reset(): void {
		this.pendingByte = undefined;
	}
}

function readPcm16Sample(lowByte: number, highByte: number): number {
	const unsigned = lowByte | (highByte << 8);
	return unsigned & 0x8000 ? unsigned - 0x1_0000 : unsigned;
}

/**
 * Prepare PCM16 WAV audio the same way as Codex's former composer dictation:
 * downmix to mono, resample to 24 kHz, and peak-normalize with 10% headroom.
 *
 * Deliberately do not reject quiet clips. Speech/no-speech detection belongs to
 * the transcription service; a local amplitude threshold can discard valid
 * quiet speech before the model sees it.
 */
export function prepareWavForTranscription(input: Uint8Array): PreparedWav {
	if (input.byteLength > MAX_AUDIO_BYTES) {
		throw new Error("Recording exceeded the 12 MiB safety limit.");
	}

	const parsed = parsePcm16Wav(input);
	if (!parsed) return { audio: input, normalized: false, converted: false };

	const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const inputFrames = Math.floor(parsed.dataLength / parsed.blockAlign);
	if (inputFrames < 1) throw new Error("Microphone recording was empty.");

	const outputFrames =
		parsed.sampleRate === TARGET_SAMPLE_RATE
			? inputFrames
			: Math.max(1, Math.floor((inputFrames * TARGET_SAMPLE_RATE) / parsed.sampleRate));
	const outputByteLength = 44 + outputFrames * TARGET_CHANNELS * 2;
	if (outputByteLength > MAX_AUDIO_BYTES) {
		throw new Error("Prepared recording exceeded the 12 MiB safety limit.");
	}

	const samples = new Int16Array(outputFrames);
	let peak = 0;
	for (let outputFrame = 0; outputFrame < outputFrames; outputFrame++) {
		const inputFrame =
			outputFrames <= 1 || inputFrames <= 1
				? 0
				: Math.floor((outputFrame * (inputFrames - 1)) / (outputFrames - 1));
		const frameOffset = parsed.dataOffset + inputFrame * parsed.blockAlign;
		let sum = 0;
		for (let channel = 0; channel < parsed.channels; channel++) {
			sum += inputView.getInt16(frameOffset + channel * 2, true);
		}
		const sample = Math.trunc(sum / parsed.channels);
		samples[outputFrame] = sample;
		peak = Math.max(peak, Math.abs(sample));
	}

	const gain = peak > 0 ? NORMALIZED_PEAK / peak : 1;
	const normalized = Math.abs(gain - 1) > 0.001;
	if (normalized) {
		for (let index = 0; index < samples.length; index++) {
			const scaled = Math.round(samples[index]! * gain);
			samples[index] = Math.max(-32_768, Math.min(32_767, scaled));
		}
	}

	const converted = parsed.sampleRate !== TARGET_SAMPLE_RATE || parsed.channels !== TARGET_CHANNELS;
	return {
		audio: encodePcm16Wav(samples, TARGET_SAMPLE_RATE, TARGET_CHANNELS),
		durationMs: (inputFrames / parsed.sampleRate) * 1_000,
		normalized,
		converted,
	};
}

interface Pcm16Wav {
	sampleRate: number;
	channels: number;
	blockAlign: number;
	dataOffset: number;
	dataLength: number;
}

function parsePcm16Wav(input: Uint8Array): Pcm16Wav | undefined {
	if (input.byteLength < 44) return undefined;
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	if (ascii(input, 0, 4) !== "RIFF" || ascii(input, 8, 12) !== "WAVE") return undefined;

	let sampleRate = 0;
	let channels = 0;
	let blockAlign = 0;
	let pcm16 = false;
	let dataOffset = 0;
	let dataLength = 0;
	for (let offset = 12; offset + 8 <= input.byteLength; ) {
		const id = ascii(input, offset, offset + 4);
		const size = view.getUint32(offset + 4, true);
		const payload = offset + 8;
		const available = Math.max(0, Math.min(size, input.byteLength - payload));
		if (id === "fmt " && available >= 16) {
			const format = view.getUint16(payload, true);
			channels = view.getUint16(payload + 2, true);
			sampleRate = view.getUint32(payload + 4, true);
			blockAlign = view.getUint16(payload + 12, true);
			const bitsPerSample = view.getUint16(payload + 14, true);
			pcm16 = format === 1 && bitsPerSample === 16;
		} else if (id === "data") {
			dataOffset = payload;
			dataLength = available;
		}
		const next = payload + size + (size % 2);
		if (next <= offset || next > input.byteLength) break;
		offset = next;
	}

	if (
		!pcm16 ||
		!dataOffset ||
		dataLength < 2 ||
		sampleRate < 1 ||
		channels < 1 ||
		blockAlign < channels * 2
	) {
		return undefined;
	}
	return { sampleRate, channels, blockAlign, dataOffset, dataLength };
}

function encodePcm16Wav(samples: Int16Array, sampleRate: number, channels: number): Uint8Array {
	const output = createPcmWav(samples.length * 2, sampleRate, channels);
	const view = new DataView(output.buffer);
	for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, samples[index]!, true);
	return output;
}

/** Encode complete PCM16 frames once; recorder and progressive previews share this header. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number, channels = 1): Uint8Array {
	const length = pcm.byteLength - pcm.byteLength % (channels * 2);
	const output = createPcmWav(length, sampleRate, channels);
	output.set(pcm.subarray(0, length), 44);
	return output;
}

function createPcmWav(dataLength: number, sampleRate: number, channels: number): Uint8Array {
	const output = new Uint8Array(44 + dataLength);
	const view = new DataView(output.buffer);
	writeAscii(output, 0, "RIFF");
	view.setUint32(4, 36 + dataLength, true);
	writeAscii(output, 8, "WAVE");
	writeAscii(output, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * 2, true);
	view.setUint16(32, channels * 2, true);
	view.setUint16(34, 16, true);
	writeAscii(output, 36, "data");
	view.setUint32(40, dataLength, true);
	return output;
}

function ascii(input: Uint8Array, start: number, end: number): string {
	let value = "";
	for (let index = start; index < end && index < input.byteLength; index++) {
		value += String.fromCharCode(input[index]!);
	}
	return value;
}

function writeAscii(output: Uint8Array, offset: number, value: string): void {
	for (let index = 0; index < value.length; index++) output[offset + index] = value.charCodeAt(index);
}
