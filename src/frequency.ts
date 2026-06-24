/**
 * Character frequency table for the vault.
 *
 * Design decisions (kept consistent everywhere, because the end goal in
 * stage 7 is a *lossless* roundtrip — decode must reconstruct the original
 * text byte-for-byte):
 *
 * - No case folding. "A" and "a" are distinct characters.
 * - No whitespace normalization. Spaces, tabs and newlines ("\n", "\r") are
 *   all counted as ordinary characters with their own frequencies.
 * - Punctuation and numbers ARE included. Every character in the source text
 *   gets an entry; nothing is stripped.
 * - Iteration is by Unicode code point (via `for..of` / spread), so an emoji
 *   or other astral-plane character counts as a single symbol rather than two
 *   surrogate halves. This keeps the alphabet clean and the later encoder
 *   correct for non-English / emoji content.
 */
export type FrequencyTable = Record<string, number>;

/** Aggregate a single frequency table across many texts. */
export function buildFrequencyTable(texts: string[]): FrequencyTable {
	const table: FrequencyTable = {};
	for (const text of texts) {
		for (const ch of text) {
			table[ch] = (table[ch] ?? 0) + 1;
		}
	}
	return table;
}

/** Total number of counted characters (code points) in a table. */
export function totalCount(table: FrequencyTable): number {
	let sum = 0;
	for (const ch in table) sum += table[ch];
	return sum;
}

/** Number of distinct characters (alphabet size) in a table. */
export function distinctCount(table: FrequencyTable): number {
	return Object.keys(table).length;
}

/** Human-readable label for a character, escaping control/whitespace. */
export function describeChar(ch: string): string {
	switch (ch) {
		case "\n":
			return "\\n (newline)";
		case "\r":
			return "\\r (carriage return)";
		case "\t":
			return "\\t (tab)";
		case " ":
			return "' ' (space)";
		default:
			return JSON.stringify(ch);
	}
}
