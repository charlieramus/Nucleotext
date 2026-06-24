import { FrequencyTable } from "./frequency";

/** The four DNA bases, in fixed order. Edge index i in the tree → BASES[i]. */
export const BASES = ["A", "T", "C", "G"] as const;
export type Base = (typeof BASES)[number];

/** Base ↔ abstract quaternary digit, the bridge to the stage 5/6 transcoder. */
export const BASE_OF_DIGIT: Base[] = ["A", "T", "C", "G"];
export const DIGIT_OF_BASE: Record<string, number> = {
	A: 0,
	T: 1,
	C: 2,
	G: 3,
};

/** Thrown when a sequence cannot be decoded, or its mapping is missing/corrupt. */
export class DecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DecodeError";
	}
}

/** Bump when the mapping format changes so stale persisted maps are detectable. */
export const MAPPING_VERSION = 1;

/**
 * A persisted, reloadable character → base-sequence mapping.
 *
 * `codes` is the ground truth. Because every code is a leaf of a 4-ary tree,
 * the set of codes is guaranteed prefix-free (see `isPrefixFree`), which is
 * what makes unambiguous decoding possible in stage 7.
 */
export interface HuffmanMapping {
	version: number;
	/** character → sequence of A/T/C/G */
	codes: Record<string, string>;
}

/** Thrown by `encodeText` when the text contains characters the map can't encode. */
export class UnknownCharacterError extends Error {
	readonly unknownChars: string[];
	constructor(unknownChars: string[]) {
		super(
			`Cannot encode: ${unknownChars.length} character(s) are not in the mapping: ` +
				unknownChars.map((c) => JSON.stringify(c)).join(", ")
		);
		this.name = "UnknownCharacterError";
		this.unknownChars = unknownChars;
	}
}

interface HuffNode {
	freq: number;
	id: number; // deterministic tiebreaker -> stable, reproducible tree
	char?: string; // present on leaves only
	children?: HuffNode[];
}

/**
 * Build a 4-ary (quaternary) Huffman mapping from a frequency table.
 *
 * Standard n-ary Huffman: pad with zero-frequency dummy leaves until
 * (leaves - 1) is divisible by (n - 1) = 3, then repeatedly merge the four
 * lowest-frequency nodes. Dummy leaves carry no character, so they never
 * appear in the output codes.
 */
export function buildHuffman(table: FrequencyTable): HuffmanMapping {
	const chars = Object.keys(table);

	if (chars.length === 0) {
		return { version: MAPPING_VERSION, codes: {} };
	}
	if (chars.length === 1) {
		// A single distinct symbol has no branching; give it a 1-base code.
		return { version: MAPPING_VERSION, codes: { [chars[0]]: BASES[0] } };
	}

	let seq = 0;
	const nodes: HuffNode[] = chars.map((c) => ({
		freq: table[c],
		char: c,
		id: seq++,
	}));

	// Pad so the tree collapses to exactly one root with 4-way merges.
	while ((nodes.length - 1) % (BASES.length - 1) !== 0) {
		nodes.push({ freq: 0, id: seq++ });
	}

	const cmp = (a: HuffNode, b: HuffNode): number =>
		a.freq - b.freq || a.id - b.id;

	while (nodes.length > 1) {
		nodes.sort(cmp);
		const take = nodes.splice(0, BASES.length);
		nodes.push({
			freq: take.reduce((s, n) => s + n.freq, 0),
			id: seq++,
			children: take,
		});
	}

	const codes: Record<string, string> = {};
	const assign = (node: HuffNode, prefix: string): void => {
		if (node.char !== undefined) {
			codes[node.char] = prefix;
			return;
		}
		node.children?.forEach((child, i) => assign(child, prefix + BASES[i]));
	};
	assign(nodes[0], "");

	return { version: MAPPING_VERSION, codes };
}

/**
 * Encode text into one continuous base sequence using the mapping.
 * Iterates by code point so emoji / astral characters are treated as one unit.
 * Throws `UnknownCharacterError` (caught and reported by callers) rather than
 * silently dropping characters or letting an undefined slip through.
 */
export function encodeText(text: string, mapping: HuffmanMapping): string {
	const unknown = new Set<string>();
	let out = "";
	for (const ch of text) {
		const code = mapping.codes[ch];
		if (code === undefined) {
			unknown.add(ch);
			continue;
		}
		out += code;
	}
	if (unknown.size > 0) {
		throw new UnknownCharacterError([...unknown]);
	}
	return out;
}

/**
 * Verify the mapping is genuinely prefix-free over {A,T,C,G}: no code is a
 * prefix of any other. Returns the first offending pair, or null if valid.
 */
export function isPrefixFree(
	mapping: HuffmanMapping
): { a: string; b: string } | null {
	const entries = Object.entries(mapping.codes);
	const sorted = entries.slice().sort((x, y) => x[1].localeCompare(y[1]));
	for (let i = 1; i < sorted.length; i++) {
		const [prevChar, prevCode] = sorted[i - 1];
		const [curChar, curCode] = sorted[i];
		if (prevCode !== "" && curCode.startsWith(prevCode)) {
			return { a: prevChar, b: curChar };
		}
	}
	return null;
}

/**
 * Validate a persisted mapping before decoding. Throws a clear `DecodeError`
 * for a missing, empty, malformed, version-mismatched, or non-prefix-free
 * mapping — so a corrupt map fails loudly rather than returning garbage.
 */
export function validateMapping(
	mapping: HuffmanMapping | null | undefined
): asserts mapping is HuffmanMapping {
	if (!mapping) {
		throw new DecodeError("Mapping is missing.");
	}
	if (mapping.version !== MAPPING_VERSION) {
		throw new DecodeError(
			`Mapping version mismatch: got ${mapping.version}, expected ${MAPPING_VERSION}.`
		);
	}
	if (!mapping.codes || typeof mapping.codes !== "object") {
		throw new DecodeError("Mapping has no code table.");
	}
	const entries = Object.entries(mapping.codes);
	if (entries.length === 0) {
		throw new DecodeError("Mapping code table is empty.");
	}
	for (const [ch, code] of entries) {
		if (typeof code !== "string" || code.length === 0 || !/^[ATCG]+$/.test(code)) {
			throw new DecodeError(
				`Corrupt code for ${JSON.stringify(ch)}: ${JSON.stringify(code)}.`
			);
		}
	}
	const conflict = isPrefixFree(mapping);
	if (conflict) {
		throw new DecodeError(
			`Mapping is not prefix-free (${JSON.stringify(conflict.a)} vs ${JSON.stringify(
				conflict.b
			)}).`
		);
	}
}

/** Encode text into the abstract quaternary digit stream (0..3). */
export function textToDigits(text: string, mapping: HuffmanMapping): number[] {
	const codeStr = encodeText(text, mapping); // throws UnknownCharacterError
	const digits: number[] = [];
	for (const b of codeStr) digits.push(DIGIT_OF_BASE[b]);
	return digits;
}

/**
 * Prefix-decode a raw base-letter code stream back to text. Greedy matching is
 * unambiguous because the codes are prefix-free. Throws `DecodeError` on an
 * invalid base or an undecodable trailing fragment.
 */
export function decodeFromCodes(
	codeStr: string,
	mapping: HuffmanMapping
): string {
	const rev = new Map<string, string>();
	for (const [ch, code] of Object.entries(mapping.codes)) rev.set(code, ch);

	let out = "";
	let buf = "";
	for (const b of codeStr) {
		if (DIGIT_OF_BASE[b] === undefined) {
			throw new DecodeError(`Invalid base ${JSON.stringify(b)} in code stream.`);
		}
		buf += b;
		const ch = rev.get(buf);
		if (ch !== undefined) {
			out += ch;
			buf = "";
		}
	}
	if (buf !== "") {
		throw new DecodeError(`Trailing undecodable bases: ${JSON.stringify(buf)}.`);
	}
	return out;
}
