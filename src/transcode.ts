import { BASES, Base, DecodeError } from "./huffman";

/**
 * Stage 5 + 6 constraint layer.
 *
 * The Huffman layer (stage 4) produces a stream of abstract quaternary digits
 * 0..3. This layer transcodes those digits into actual A/T/C/G bases while
 * enforcing two real DNA-storage constraints, in a way that is *exactly*
 * reversible (required for the stage 7 roundtrip):
 *
 * Stage 5 — Homopolymer cap (hard guarantee):
 *   Both encoder and decoder track the trailing run length of the *emitted*
 *   bases. The instant a run reaches `maxRun`, the encoder inserts one "spacer"
 *   base that differs from the run base (carrying no digit), which resets the
 *   run. The decoder detects the identical state (run == maxRun) and knows the
 *   next base is a spacer, so it consumes it without producing a digit. Output
 *   therefore never contains a run longer than `maxRun`.
 *
 * Stage 6 — GC bias (deterministic feedback):
 *   The mapping from digit -> base is a permutation chosen from the running GC
 *   ratio. When GC is below target, GC bases (C,G) are placed at the low digit
 *   indices; when above, AT bases are. Because the choice depends only on
 *   already-emitted bases, the decoder replays it identically. Spacer bases are
 *   likewise picked to push GC toward target. This is a negative-feedback
 *   controller that pulls GC toward the target without ever breaking the
 *   homopolymer cap or the prefix-free property.
 *
 * The two constraints are independent toggles; disabling both makes this an
 * identity transcode (digit i -> BASES[i]) equal to the raw stage-4 output.
 */
export interface ConstraintConfig {
	maxRun: number;
	gcTargetFraction: number; // 0..1
	homopolymer: boolean;
	gc: boolean;
}

export const DEFAULT_CONSTRAINTS: ConstraintConfig = {
	maxRun: 3,
	gcTargetFraction: 0.5,
	homopolymer: true,
	gc: true,
};

const GC_FIRST: Base[] = ["C", "G", "A", "T"];
const AT_FIRST: Base[] = ["A", "T", "C", "G"];

const isGC = (b: string): boolean => b === "C" || b === "G";
const isBase = (b: string): b is Base =>
	b === "A" || b === "T" || b === "C" || b === "G";

/** maxRun must be >= 2, else a spacer (length-1 run) would itself violate it. */
function effMaxRun(cfg: ConstraintConfig): number {
	return Math.max(2, Math.floor(cfg.maxRun));
}

interface RunState {
	gcCount: number;
	total: number;
	runBase: string;
	runLen: number;
	/** Running count of each digit value seen so far (data digits only). */
	cnt: [number, number, number, number];
}

function freshState(): RunState {
	return { gcCount: 0, total: 0, runBase: "", runLen: 0, cnt: [0, 0, 0, 0] };
}

function consume(st: RunState, base: string): void {
	st.total++;
	if (isGC(base)) st.gcCount++;
	if (base === st.runBase) {
		st.runLen++;
	} else {
		st.runBase = base;
		st.runLen = 1;
	}
}

/**
 * Choose the digit→base permutation that moves running GC toward target.
 *
 * The two candidates (GC_FIRST, AT_FIRST) are GC-complementary per digit index,
 * so they straddle the choice "raise vs lower GC". Crucially, which one raises
 * GC depends on the *digit distribution*, not on the index — so we estimate the
 * upcoming digit from the Laplace-smoothed running counts and pick whichever
 * candidate's expected post-step GC lands closer to target. AT_FIRST wins ties,
 * so the controller can never do worse than the raw (always-AT_FIRST) labeling.
 * Counts use only already-seen digits, so the decoder replays the same choice.
 */
function rankBases(st: RunState, cfg: ConstraintConfig): Base[] {
	if (!cfg.gc) return AT_FIRST;
	const target = cfg.gcTargetFraction;
	const sum = st.cnt[0] + st.cnt[1] + st.cnt[2] + st.cnt[3];
	const p = st.cnt.map((c) => (c + 1) / (sum + 4)); // predicted next digit
	const expectedGc = (perm: Base[]): number => {
		let e = 0;
		for (let d = 0; d < 4; d++) if (isGC(perm[d])) e += p[d];
		return (st.gcCount + e) / (st.total + 1);
	};
	const errAt = Math.abs(expectedGc(AT_FIRST) - target);
	const errGc = Math.abs(expectedGc(GC_FIRST) - target);
	return errGc < errAt ? GC_FIRST : AT_FIRST;
}

/** Pick a spacer base != runBase that nudges GC toward target. */
function chooseSpacer(st: RunState, cfg: ConstraintConfig): Base {
	const cur = st.total > 0 ? st.gcCount / st.total : cfg.gcTargetFraction;
	const preferGC = cfg.gc && cur < cfg.gcTargetFraction;
	const order = preferGC ? GC_FIRST : AT_FIRST;
	for (const b of order) if (b !== st.runBase) return b;
	return BASES.find((b) => b !== st.runBase) as Base;
}

/** Digits (0..3) -> constrained base sequence. */
export function transcode(digits: number[], cfg: ConstraintConfig): string {
	const st = freshState();
	const out: string[] = [];
	const max = effMaxRun(cfg);

	const emit = (base: string): void => {
		out.push(base);
		consume(st, base);
		if (cfg.homopolymer && st.runLen >= max) {
			const sp = chooseSpacer(st, cfg);
			out.push(sp);
			consume(st, sp);
		}
	};

	for (const d of digits) {
		const ranked = rankBases(st, cfg);
		st.cnt[d]++; // update digit stats after the (prior-stats) ranking choice
		emit(ranked[d]);
	}
	return out.join("");
}

/** Constrained base sequence -> digits (0..3). Reverses {@link transcode}. */
export function untranscode(bases: string, cfg: ConstraintConfig): number[] {
	const st = freshState();
	const digits: number[] = [];
	const max = effMaxRun(cfg);
	const arr = [...bases];

	for (let i = 0; i < arr.length; i++) {
		const base = arr[i];
		if (!isBase(base)) {
			throw new DecodeError(
				`Invalid base ${JSON.stringify(base)} at position ${i}.`
			);
		}
		if (cfg.homopolymer && st.runLen >= max) {
			// Forced spacer: consume without producing a digit.
			consume(st, base);
			continue;
		}
		const ranked = rankBases(st, cfg);
		const d = ranked.indexOf(base);
		if (d < 0) {
			throw new DecodeError(
				`Base ${JSON.stringify(base)} not found in ranking at position ${i}.`
			);
		}
		digits.push(d);
		st.cnt[d]++; // mirror the encoder's post-ranking stats update
		consume(st, base);
	}
	return digits;
}

/** Longest run of an identical character in a sequence. */
export function maxRunLength(seq: string): number {
	let max = 0;
	let cur = 0;
	let prev = "";
	for (const ch of seq) {
		if (ch === prev) {
			cur++;
		} else {
			cur = 1;
			prev = ch;
		}
		if (cur > max) max = cur;
	}
	return max;
}

/** GC content as a fraction (0..1). Empty sequence -> 0. */
export function gcContent(seq: string): number {
	if (seq.length === 0) return 0;
	let gc = 0;
	for (const ch of seq) if (isGC(ch)) gc++;
	return gc / seq.length;
}
