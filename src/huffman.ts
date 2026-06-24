import { FrequencyTable } from "./frequency";

/** The four DNA bases, in fixed order. Edge index i in the tree → BASES[i]. */
export const BASES = ["A", "T", "C", "G"] as const;
export type Base = (typeof BASES)[number];

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
