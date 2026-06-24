import { App, TFile } from "obsidian";
import { HuffmanMapping } from "./huffman";
import { ConstraintConfig } from "./transcode";
import { encode } from "./codec";
import { isExcluded } from "./vaultReader";
import { buildHeader } from "./header";

/**
 * Stage 1 — Chromosome mapping, and Stage 4 — GC content.
 *
 * This module turns the flat set of vault notes into a `Genome`: a set of
 * chromosomes (one per top-level vault folder), each holding an ordered list of
 * its encoded notes. Every later stage in this log reads this structure rather
 * than re-walking the vault.
 *
 * Chromosome assignment rule (the whole point of stage 1):
 *   The chromosome is the FIRST path segment of a note's vault-relative path.
 *   "Projects/2026/Plan.md"        -> chromosome "Projects"
 *   "Projects/Sub/Deep/Note.md"    -> chromosome "Projects"   (depth doesn't matter)
 *   "Inbox.md"                     -> chromosome DEFAULT_CHROMOSOME (root note)
 *   A note any number of folders deep always resolves up to its top-level folder
 *   because we only ever look at segment 0.
 *
 * Root notes (no folder) are NOT dropped: they are collected under a clearly
 * named default chromosome so they remain part of the genome and the export.
 */

/** Chromosome used for notes that sit directly in the vault root. */
export const DEFAULT_CHROMOSOME = "Unsorted";

export interface GenomeNote {
	/** Full vault-relative path (unique key). */
	path: string;
	/** Display name without extension. */
	basename: string;
	/** Name of the chromosome (top-level folder) this note belongs to. */
	chromosome: string;
	/** Stage 2 FASTA-safe header (without the leading ">"). */
	header: string;
	/** Stage 5/6 constrained base sequence (A/T/C/G). */
	sequence: string;
	/** Sequence length in bases. */
	length: number;
	/** Count of G + C bases in the sequence (cached for stage 4 aggregation). */
	gcCount: number;
	/** GC content of this note as a percentage (0..100), rounded to 2 dp. */
	gcPercent: number;
}

export interface Chromosome {
	name: string;
	/** Notes in stable path order. */
	notes: GenomeNote[];
	/** Stage 4: total bases across all notes in this chromosome. */
	length: number;
	/** Stage 4: total G + C bases across all notes. */
	gcCount: number;
	/** Stage 4: aggregate GC% = gcCount / length (NOT a mean of per-note %). */
	gcPercent: number;
}

export interface NoteFailure {
	path: string;
	error: string;
}

export interface Genome {
	/** Chromosomes in display order (alphabetical, default chromosome last). */
	chromosomes: Chromosome[];
	/** Fast lookup by chromosome name. */
	byName: Map<string, Chromosome>;
	/** Stage 4: total bases across the whole genome. */
	length: number;
	/** Stage 4: total G + C bases across the whole genome. */
	gcCount: number;
	/** Stage 4: aggregate genome GC% = gcCount / length. */
	gcPercent: number;
	/** Name of the default chromosome used for root notes. */
	defaultChromosome: string;
	/** Notes that could not be encoded (e.g. characters outside the encoder). */
	failures: NoteFailure[];
	/** Epoch ms the genome was built — lets callers detect a stale cache. */
	generatedAt: number;
}

/** Resolve a vault path to its top-level chromosome name. */
export function chromosomeOf(path: string): string {
	const slash = path.indexOf("/");
	if (slash === -1) return DEFAULT_CHROMOSOME; // root note, no folder
	const top = path.slice(0, slash);
	return top.length > 0 ? top : DEFAULT_CHROMOSOME;
}

/** Count G + C bases in a sequence (stage 4 building block). */
export function countGC(seq: string): number {
	let gc = 0;
	for (const ch of seq) if (ch === "G" || ch === "C") gc++;
	return gc;
}

/** GC% from counts, with the empty-sequence case defined as 0. */
function gcPercentOf(gcCount: number, length: number): number {
	if (length === 0) return 0;
	return +((gcCount / length) * 100).toFixed(2);
}

/**
 * Walk the vault, encode every included note, and group the results into a
 * `Genome`. The encoder mapping and constraint config must be supplied so each
 * note's stored sequence is the same constrained sequence used everywhere else.
 *
 * A note whose text contains characters the encoder doesn't know is recorded in
 * `failures` and left out of the chromosomes, rather than aborting the build or
 * silently corrupting the genome.
 */
export async function buildGenome(
	app: App,
	mapping: HuffmanMapping,
	cfg: ConstraintConfig,
	excludedFolders: string[]
): Promise<Genome> {
	const files: TFile[] = app.vault
		.getMarkdownFiles()
		.filter((f) => !isExcluded(f.path, excludedFolders))
		// Stable, predictable order: by path. Chromosomes inherit this order.
		.sort((a, b) => a.path.localeCompare(b.path));

	const byName = new Map<string, Chromosome>();
	const failures: NoteFailure[] = [];

	const chromosomeFor = (name: string): Chromosome => {
		let chr = byName.get(name);
		if (!chr) {
			chr = { name, notes: [], length: 0, gcCount: 0, gcPercent: 0 };
			byName.set(name, chr);
		}
		return chr;
	};

	for (const file of files) {
		let text: string;
		try {
			text = await app.vault.cachedRead(file);
		} catch (e) {
			failures.push({ path: file.path, error: `read failed: ${errMsg(e)}` });
			continue;
		}

		let sequence: string;
		try {
			sequence = encode(text, mapping, cfg).constrained;
		} catch (e) {
			failures.push({ path: file.path, error: errMsg(e) });
			continue;
		}

		const chromosomeName = chromosomeOf(file.path);
		const fmCache = app.metadataCache.getFileCache(file)?.frontmatter ?? null;
		// Obsidian stores a `position` key on frontmatter; buildHeader skips it.
		const header = buildHeader({
			path: file.path,
			basename: file.basename,
			frontmatter: fmCache as Record<string, unknown> | null,
		});

		const gcCount = countGC(sequence);
		const note: GenomeNote = {
			path: file.path,
			basename: file.basename,
			chromosome: chromosomeName,
			header,
			sequence,
			length: sequence.length,
			gcCount,
			gcPercent: gcPercentOf(gcCount, sequence.length),
		};

		const chr = chromosomeFor(chromosomeName);
		chr.notes.push(note);
		chr.length += note.length;
		chr.gcCount += note.gcCount;
	}

	// Finalize aggregate GC per chromosome and for the whole genome.
	let genomeLength = 0;
	let genomeGc = 0;
	for (const chr of byName.values()) {
		chr.gcPercent = gcPercentOf(chr.gcCount, chr.length);
		genomeLength += chr.length;
		genomeGc += chr.gcCount;
	}

	const chromosomes = [...byName.values()].sort(orderChromosomes);

	return {
		chromosomes,
		byName,
		length: genomeLength,
		gcCount: genomeGc,
		gcPercent: gcPercentOf(genomeGc, genomeLength),
		defaultChromosome: DEFAULT_CHROMOSOME,
		failures,
		generatedAt: Date.now(),
	};
}

/** Alphabetical, but the default (root) chromosome always sorts last. */
function orderChromosomes(a: Chromosome, b: Chromosome): number {
	const aDef = a.name === DEFAULT_CHROMOSOME;
	const bDef = b.name === DEFAULT_CHROMOSOME;
	if (aDef !== bDef) return aDef ? 1 : -1;
	return a.name.localeCompare(b.name);
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
