import { Genome } from "./genome";

/**
 * Stage 3 — FASTA export (pure formatting; no Obsidian / filesystem here so it
 * can be unit-tested and validated by an external tool).
 *
 * Output follows the conventions a real bioinformatics parser expects:
 * - Each record begins with a single header line introduced by ">".
 * - The header line carries the identifier + description on ONE line.
 * - The sequence follows on subsequent lines, hard-wrapped at a fixed width.
 * - Lines are LF-terminated and the file ends with a trailing newline.
 *
 * Empty sequences (an empty note) are written as a header with no sequence
 * lines — a valid, if minimal, FASTA record. A genome with zero notes produces
 * an empty (zero-byte) file, which every parser reads as "no records" rather
 * than an error.
 */

/** Standard FASTA line width. 70 matches NCBI/BLAST output. */
export const FASTA_WRAP = 70;

/** Hard-wrap a sequence into fixed-width lines. */
export function wrapSequence(seq: string, width: number = FASTA_WRAP): string[] {
	if (width <= 0) return seq.length > 0 ? [seq] : [];
	const lines: string[] = [];
	for (let i = 0; i < seq.length; i += width) {
		lines.push(seq.slice(i, i + width));
	}
	return lines;
}

/** Format one record: ">"+header, then wrapped sequence lines. */
export function toRecord(
	header: string,
	sequence: string,
	width: number = FASTA_WRAP
): string {
	const lines = [`>${header}`, ...wrapSequence(sequence, width)];
	return lines.join("\n");
}

/**
 * Serialize a whole genome to a single FASTA string. Records appear in
 * chromosome order, and within a chromosome in the genome's note order, so the
 * file groups notes by chromosome the same way the genome structure does.
 */
export function genomeToFasta(genome: Genome, width: number = FASTA_WRAP): string {
	const records: string[] = [];
	for (const chr of genome.chromosomes) {
		for (const note of chr.notes) {
			records.push(toRecord(note.header, note.sequence, width));
		}
	}
	if (records.length === 0) return "";
	return records.join("\n") + "\n";
}
