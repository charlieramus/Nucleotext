/**
 * Stage 2 (mutation tracker) — Diff Engine.
 *
 * Produce an accurate, structured diff between two encoded sequences (the
 * `previous` and `current` snapshots from stage 1). The classification stage
 * (stage 3) attaches biological labels — point mutation, insertion, deletion,
 * frameshift — to these regions, so it depends entirely on this output being
 * correct and minimal. This stage does NO biology: it only emits well-formed
 * change regions.
 *
 * Approach:
 *   1. Trim the common prefix and suffix in O(n). Most real edits touch a small
 *      span, so this collapses the expensive part to just the differing middle
 *      and is what keeps a single-base edit reporting a single tiny region
 *      instead of smearing across the whole sequence.
 *   2. Diff the differing middle with Levenshtein edit distance (insert/delete/
 *      substitute, unit cost) and backtrace the cheapest path, preferring the
 *      diagonal on ties so a changed base is a *substitution* rather than a
 *      delete+insert pair. This yields the minimal edit script.
 *   3. Coalesce the resulting per-base operations into contiguous regions, each
 *      tagged unchanged / added / removed / substituted with positions in both
 *      sequences.
 *
 * For pathologically large differing middles the full DP matrix would blow up,
 * so above a cell budget we fall back to a coarse but still-valid decomposition
 * (overlap as substitution, remainder as add/remove). See {@link MAX_DP_CELLS}.
 */

export type RegionKind = "unchanged" | "added" | "removed" | "substituted";

export interface DiffRegion {
	kind: RegionKind;
	/** Start index in the previous sequence (inclusive). */
	prevStart: number;
	/** End index in the previous sequence (exclusive). */
	prevEnd: number;
	/** Start index in the current sequence (inclusive). */
	currStart: number;
	/** End index in the current sequence (exclusive). */
	currEnd: number;
	/** Slice of the previous sequence ("" for a pure addition). */
	prevText: string;
	/** Slice of the current sequence ("" for a pure removal). */
	currText: string;
}

/** Upper bound on Levenshtein DP cells (≈ 16 MB of Uint8 directions at 16M). */
export const MAX_DP_CELLS = 16_000_000;

type Op = "equal" | "sub" | "del" | "ins";

/**
 * Diff `prev` against `curr` and return contiguous change regions covering both
 * sequences in order. Adjacent regions never share a kind (they're coalesced),
 * and the regions tile both sequences with no gaps or overlaps.
 *
 * Edge cases:
 *   - both empty            -> [] (no changes)
 *   - prev empty, curr not  -> a single `added` region spanning all of curr
 *   - curr empty, prev not  -> a single `removed` region spanning all of prev
 *   - identical sequences   -> a single `unchanged` region (or [] if both empty)
 */
export function diffSequences(prev: string, curr: string): DiffRegion[] {
	// Common prefix length.
	let pre = 0;
	const minLen = Math.min(prev.length, curr.length);
	while (pre < minLen && prev[pre] === curr[pre]) pre++;

	// Common suffix length (not overlapping the prefix).
	let suf = 0;
	while (
		suf < minLen - pre &&
		prev[prev.length - 1 - suf] === curr[curr.length - 1 - suf]
	) {
		suf++;
	}

	const prevMid = prev.slice(pre, prev.length - suf);
	const currMid = curr.slice(pre, curr.length - suf);

	// Build the full op stream: prefix equals, middle ops, suffix equals.
	const ops: Op[] = [];
	for (let i = 0; i < pre; i++) ops.push("equal");
	middleOps(prevMid, currMid, ops);
	for (let i = 0; i < suf; i++) ops.push("equal");

	return opsToRegions(ops, prev, curr);
}

/** Compute the edit ops for the differing middle and append them to `ops`. */
function middleOps(a: string, b: string, ops: Op[]): void {
	if (a.length === 0 && b.length === 0) return;
	if (a.length === 0) {
		for (let j = 0; j < b.length; j++) ops.push("ins");
		return;
	}
	if (b.length === 0) {
		for (let i = 0; i < a.length; i++) ops.push("del");
		return;
	}

	if (a.length * b.length > MAX_DP_CELLS) {
		coarseOps(a, b, ops);
		return;
	}

	levenshteinOps(a, b, ops);
}

/**
 * Coarse fallback for very large differing middles: treat the overlapping span
 * as a substitution and the length remainder as an addition or removal. Still a
 * valid, well-structured region decomposition — just not guaranteed minimal.
 */
function coarseOps(a: string, b: string, ops: Op[]): void {
	const overlap = Math.min(a.length, b.length);
	for (let k = 0; k < overlap; k++) ops.push("sub");
	if (a.length > overlap) for (let k = overlap; k < a.length; k++) ops.push("del");
	if (b.length > overlap) for (let k = overlap; k < b.length; k++) ops.push("ins");
}

/**
 * Levenshtein DP with a backtrace. `dir` records, per cell, which move produced
 * the optimum: diagonal (equal/sub), up (del from a), left (ins from b).
 * Diagonal wins ties so a changed base prefers substitution over delete+insert,
 * giving the minimal-region result the later stages expect.
 */
function levenshteinOps(a: string, b: string, ops: Op[]): void {
	const m = a.length;
	const n = b.length;
	const width = n + 1;

	const cost = new Int32Array((m + 1) * (n + 1));
	// 1 = diagonal, 2 = up (del), 3 = left (ins)
	const dir = new Uint8Array((m + 1) * (n + 1));

	for (let j = 0; j <= n; j++) {
		cost[j] = j;
		if (j > 0) dir[j] = 3; // top row: all insertions
	}
	for (let i = 1; i <= m; i++) {
		cost[i * width] = i;
		dir[i * width] = 2; // left column: all deletions
	}

	for (let i = 1; i <= m; i++) {
		const ai = a[i - 1];
		const row = i * width;
		const prevRow = (i - 1) * width;
		for (let j = 1; j <= n; j++) {
			const subCost = cost[prevRow + (j - 1)] + (ai === b[j - 1] ? 0 : 1);
			const delCost = cost[prevRow + j] + 1;
			const insCost = cost[row + (j - 1)] + 1;

			// Prefer diagonal, then deletion, then insertion on ties.
			let best = subCost;
			let move = 1;
			if (delCost < best) {
				best = delCost;
				move = 2;
			}
			if (insCost < best) {
				best = insCost;
				move = 3;
			}
			cost[row + j] = best;
			dir[row + j] = move;
		}
	}

	// Backtrace from (m, n) to (0, 0), collecting ops in reverse.
	const rev: Op[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		const move = dir[i * width + j];
		if (move === 1) {
			rev.push(a[i - 1] === b[j - 1] ? "equal" : "sub");
			i--;
			j--;
		} else if (move === 2) {
			rev.push("del");
			i--;
		} else {
			rev.push("ins");
			j--;
		}
	}
	for (let k = rev.length - 1; k >= 0; k--) ops.push(rev[k]);
}

/**
 * Walk the op stream, coalescing maximal runs of the same op type into regions
 * with absolute positions in both sequences. `equal` runs become `unchanged`;
 * `sub` -> `substituted`; `del` -> `removed`; `ins` -> `added`.
 */
function opsToRegions(ops: Op[], prev: string, curr: string): DiffRegion[] {
	const regions: DiffRegion[] = [];
	let i = 0; // index into prev
	let j = 0; // index into curr
	let k = 0;

	while (k < ops.length) {
		const t = ops[k];
		const startI = i;
		const startJ = j;
		while (k < ops.length && ops[k] === t) {
			if (t === "equal" || t === "sub") {
				i++;
				j++;
			} else if (t === "del") {
				i++;
			} else {
				j++;
			}
			k++;
		}
		regions.push({
			kind: kindOf(t),
			prevStart: startI,
			prevEnd: i,
			currStart: startJ,
			currEnd: j,
			prevText: prev.slice(startI, i),
			currText: curr.slice(startJ, j),
		});
	}

	return regions;
}

function kindOf(op: Op): RegionKind {
	switch (op) {
		case "equal":
			return "unchanged";
		case "sub":
			return "substituted";
		case "del":
			return "removed";
		case "ins":
			return "added";
	}
}

/** Convenience summary: counts of each region kind (excluding unchanged). */
export interface DiffSummary {
	added: number;
	removed: number;
	substituted: number;
	/** True if the diff found no changes at all. */
	identical: boolean;
}

export function summarizeDiff(regions: DiffRegion[]): DiffSummary {
	let added = 0;
	let removed = 0;
	let substituted = 0;
	for (const r of regions) {
		if (r.kind === "added") added++;
		else if (r.kind === "removed") removed++;
		else if (r.kind === "substituted") substituted++;
	}
	return {
		added,
		removed,
		substituted,
		identical: added + removed + substituted === 0,
	};
}
