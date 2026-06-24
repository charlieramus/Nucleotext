/**
 * Stage 3 (mutation tracker) — Mutation Classification.
 *
 * Turn the structural diff regions from stage 2 into biologically labelled
 * mutations. This is the layer the user actually reads, so the labels must be
 * accurate and, above all, *consistent* — the same structural change always
 * gets the same label.
 *
 * Classification rules (the documented, consistent contract):
 *
 *   1. EACH DIFF REGION IS CLASSIFIED INDEPENDENTLY BY ITS OWN KIND. Adjacency
 *      never merges or reclassifies regions. So a substitution sitting next to
 *      an insertion or deletion is reported as TWO mutations — a point mutation
 *      (or run of them) AND an insertion/deletion — never as a single combined
 *      or ambiguous "complex" label. This is the explicit decision for "a region
 *      that is both a substitution and adjacent to an insertion or deletion":
 *      we never guess at a fused biological event; we report exactly what the
 *      diff structure says, every time.
 *
 *   2. A `substituted` region of length L  -> L POINT MUTATIONS. Each substituted
 *      base position is one point mutation (a substituted region always has
 *      equal previous/current length by construction, so L is unambiguous).
 *
 *   3. An `added` region of length L       -> one INSERTION of L bases.
 *   4. A `removed` region of length L      -> one DELETION of L bases.
 *
 *   5. FRAMESHIFT: an insertion or deletion whose length is NOT divisible by 3 is
 *      additionally flagged as a frameshift, because in a real sequence that
 *      length would shift the downstream codon reading frame. Substitutions never
 *      frameshift — they preserve length by definition.
 *
 * Counting model used by {@link summarizeMutations} (also part of the contract):
 *   - point mutations are counted PER BASE (a 3-base substituted run = 3 points),
 *   - insertions and deletions are counted PER EVENT (a 5-base insertion = 1
 *     insertion), since an indel is a single biological event,
 *   - a frameshift is counted once per indel event that is flagged.
 */

import { DiffRegion } from "./diff";

export type MutationType = "point" | "insertion" | "deletion";

export interface Mutation {
	type: MutationType;
	/** True for an indel whose length isn't divisible by 3. Always false for point. */
	frameshift: boolean;
	/**
	 * Bases involved: substituted bases for a point region (also the number of
	 * point mutations it represents), or inserted/deleted bases for an indel.
	 */
	bases: number;
	prevStart: number;
	prevEnd: number;
	currStart: number;
	currEnd: number;
	prevText: string;
	currText: string;
}

export interface MutationCounts {
	point: number;
	insertion: number;
	deletion: number;
	frameshift: number;
	/** point + insertion + deletion (frameshift is an attribute of indels, not added in). */
	total: number;
}

/** Classify a list of diff regions into mutations (unchanged regions produce none). */
export function classifyRegions(regions: DiffRegion[]): Mutation[] {
	const mutations: Mutation[] = [];
	for (const r of regions) {
		switch (r.kind) {
			case "unchanged":
				break;
			case "substituted":
				mutations.push({
					type: "point",
					frameshift: false,
					bases: r.prevEnd - r.prevStart, // == currEnd - currStart
					prevStart: r.prevStart,
					prevEnd: r.prevEnd,
					currStart: r.currStart,
					currEnd: r.currEnd,
					prevText: r.prevText,
					currText: r.currText,
				});
				break;
			case "added": {
				const len = r.currEnd - r.currStart;
				mutations.push({
					type: "insertion",
					frameshift: len % 3 !== 0,
					bases: len,
					prevStart: r.prevStart,
					prevEnd: r.prevEnd,
					currStart: r.currStart,
					currEnd: r.currEnd,
					prevText: r.prevText,
					currText: r.currText,
				});
				break;
			}
			case "removed": {
				const len = r.prevEnd - r.prevStart;
				mutations.push({
					type: "deletion",
					frameshift: len % 3 !== 0,
					bases: len,
					prevStart: r.prevStart,
					prevEnd: r.prevEnd,
					currStart: r.currStart,
					currEnd: r.currEnd,
					prevText: r.prevText,
					currText: r.currText,
				});
				break;
			}
		}
	}
	return mutations;
}

/** Aggregate mutations into the counts the log panel displays. */
export function summarizeMutations(mutations: Mutation[]): MutationCounts {
	let point = 0;
	let insertion = 0;
	let deletion = 0;
	let frameshift = 0;
	for (const m of mutations) {
		if (m.type === "point") {
			point += m.bases; // per-base
		} else if (m.type === "insertion") {
			insertion += 1; // per-event
			if (m.frameshift) frameshift += 1;
		} else {
			deletion += 1; // per-event
			if (m.frameshift) frameshift += 1;
		}
	}
	return { point, insertion, deletion, frameshift, total: point + insertion + deletion };
}

/** A human-readable one-line summary, e.g. "2 point, 1 insertion (frameshift)". */
export function describeCounts(c: MutationCounts): string {
	if (c.total === 0) return "no mutations";
	const parts: string[] = [];
	if (c.point > 0) parts.push(`${c.point} point`);
	if (c.insertion > 0) parts.push(`${c.insertion} insertion${c.insertion === 1 ? "" : "s"}`);
	if (c.deletion > 0) parts.push(`${c.deletion} deletion${c.deletion === 1 ? "" : "s"}`);
	let out = parts.join(", ");
	if (c.frameshift > 0) out += ` (${c.frameshift} frameshift${c.frameshift === 1 ? "" : "s"})`;
	return out;
}
