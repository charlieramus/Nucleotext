/**
 * Stage 1 (mutation tracker) — Snapshot Store.
 *
 * Every later stage in this log (diff, classification, the mutation log panel,
 * persistence) depends on having an accurate *previous* version of each note's
 * encoded sequence to compare the current one against. This module is that
 * source of truth: for every note it keeps the most recent encoded sequence
 * (`current`) and the one before it (`previous`), and nothing else.
 *
 * It deliberately does NOT diff anything — that is stage 2. The only job here is
 * to make the before/after snapshots themselves reliable:
 *   - capture on every save (wired to Obsidian's `modify` event in main.ts),
 *   - keep the prior snapshot until the next *distinct* save replaces it,
 *   - define the very first save of a brand-new note clearly (no fake giant
 *     insertion — `previous` is explicitly `null`),
 *   - never corrupt the store under rapid consecutive saves (autosave), by
 *     serialising captures per note path,
 *   - survive a full Obsidian restart, by living in the plugin's persisted data.
 *
 * The pure {@link captureSnapshot} function holds all the roll-forward logic and
 * is unit-testable on its own; {@link SnapshotManager} only adds IO concerns
 * (encoding, per-path serialisation, persistence).
 */

/** The before/after snapshot pair for a single note. */
export interface NoteSnapshot {
	/** Full vault-relative path; also the key into {@link SnapshotMap}. */
	path: string;
	/** Most recent encoded (constrained) sequence captured on save. */
	current: string;
	/**
	 * The sequence captured before {@link current}. `null` means this note has
	 * only ever been snapshotted once — a brand-new note's first save. Stage 2
	 * treats a `null` previous as "no prior version" rather than diffing the
	 * whole note against an empty string and calling it one giant insertion.
	 */
	previous: string | null;
	/** Epoch ms when {@link current} was captured. */
	currentAt: number;
	/** Epoch ms when {@link previous} was captured, or `null` if none. */
	previousAt: number | null;
	/** True only while the note has a single snapshot (no prior version yet). */
	isNew: boolean;
	/** Count of distinct sequences captured for this note (>= 1). */
	revisions: number;
}

/** All notes' snapshots, keyed by vault path. This is what gets persisted. */
export type SnapshotMap = Record<string, NoteSnapshot>;

export interface CaptureResult {
	snapshot: NoteSnapshot;
	/**
	 * True if this capture actually moved the store forward (new note, or the
	 * sequence genuinely changed). False for a no-op save whose encoded sequence
	 * is identical to the current snapshot — see the note below.
	 */
	changed: boolean;
}

/**
 * Roll a note's snapshot forward given the freshly encoded `sequence`.
 *
 * Three cases, all explicit:
 *
 *  1. No prior snapshot (`prev` undefined): brand-new note. `previous` is set to
 *     `null` (NOT the empty string), so downstream stages know there is no real
 *     earlier version rather than mistaking the first save for a full insertion.
 *
 *  2. The sequence is identical to the current snapshot: a no-op save (e.g.
 *     autosave firing with no content change, or a change that encodes to the
 *     same bases). We return the *existing* snapshot unchanged and report
 *     `changed: false`. Crucially we do NOT roll `current` into `previous` here —
 *     doing so would discard the genuinely older version and replace it with a
 *     duplicate of the current one, corrupting the before/after pair that the
 *     mutation tracker exists to preserve.
 *
 *  3. The sequence differs: the real case. The old `current` becomes `previous`
 *     and the new sequence becomes `current`.
 */
export function captureSnapshot(
	path: string,
	prev: NoteSnapshot | undefined,
	sequence: string,
	now: number
): CaptureResult {
	if (!prev) {
		return {
			snapshot: {
				path,
				current: sequence,
				previous: null,
				currentAt: now,
				previousAt: null,
				isNew: true,
				revisions: 1,
			},
			changed: true,
		};
	}

	if (sequence === prev.current) {
		// No-op save: keep the existing before/after pair intact.
		return { snapshot: prev, changed: false };
	}

	return {
		snapshot: {
			path,
			current: sequence,
			previous: prev.current,
			currentAt: now,
			previousAt: prev.currentAt,
			isNew: false,
			revisions: prev.revisions + 1,
		},
		changed: true,
	};
}

/** IO dependencies the manager needs, injected so the manager stays testable. */
export interface SnapshotDeps {
	/**
	 * Encode the note at `path` to its current constrained sequence, or return
	 * `null` if it can't be encoded right now (no encoder yet, file gone,
	 * contains characters outside the encoder, or a read error). Returning `null`
	 * makes the capture a safe no-op rather than corrupting the store with a
	 * bogus sequence.
	 */
	encode(path: string): Promise<string | null>;
	/** Request that the (possibly debounced) persistence of the map happen. */
	persist(): void;
	/**
	 * Optional: called after a capture that actually moved the store forward
	 * (a brand-new note, or a genuine change). The mutation tracker uses this to
	 * diff `previous`→`current` and log mutations. Not called for no-op saves.
	 */
	onChange?(snapshot: NoteSnapshot): void;
}

/**
 * Owns the live {@link SnapshotMap} and turns save/rename/delete signals into
 * snapshot updates.
 *
 * Rapid-save safety: captures for the same path are chained, so two saves that
 * land while the first is still encoding can never interleave and clobber each
 * other's `previous`. Different paths run independently.
 */
export class SnapshotManager {
	private map: SnapshotMap;
	/** Per-path tail of the in-flight capture chain (serialisation). */
	private chains = new Map<string, Promise<unknown>>();

	constructor(private deps: SnapshotDeps, initial?: SnapshotMap | null) {
		this.map = initial ? { ...initial } : {};
	}

	/** The live map (the object persisted to plugin data). */
	getMap(): SnapshotMap {
		return this.map;
	}

	/** Current snapshot for a note, if any. */
	get(path: string): NoteSnapshot | undefined {
		return this.map[path];
	}

	/** Number of notes currently tracked. */
	size(): number {
		return Object.keys(this.map).length;
	}

	/** A note was saved — enqueue a snapshot capture, serialised per path. */
	onSave(path: string): void {
		this.enqueue(path, () => this.capture(path));
	}

	/** A note was renamed — move its snapshot to the new path, serialised. */
	onRename(oldPath: string, newPath: string): void {
		this.enqueue(oldPath, async () => {
			const existing = this.map[oldPath];
			if (!existing) return;
			delete this.map[oldPath];
			existing.path = newPath;
			this.map[newPath] = existing;
			this.deps.persist();
		});
	}

	/** A note was deleted — drop its snapshot so the store doesn't leak. */
	onDelete(path: string): void {
		this.enqueue(path, async () => {
			if (this.map[path]) {
				delete this.map[path];
				this.deps.persist();
			}
		});
	}

	private async capture(path: string): Promise<void> {
		const sequence = await this.deps.encode(path);
		if (sequence === null) return; // can't encode -> don't touch the store
		const { snapshot, changed } = captureSnapshot(
			path,
			this.map[path],
			sequence,
			Date.now()
		);
		if (!changed) return;
		this.map[path] = snapshot;
		this.deps.persist();
		this.deps.onChange?.(snapshot);
	}

	/**
	 * Append `task` to this path's chain so it runs strictly after any capture
	 * already queued for the same path. Failures are logged, not propagated, so
	 * one bad capture can't break the chain for later saves.
	 */
	private enqueue(path: string, task: () => Promise<void>): void {
		const prev = this.chains.get(path) ?? Promise.resolve();
		const run = prev
			.then(() => task())
			.catch((e) => console.error("Nucleotext snapshot capture failed:", e));
		this.chains.set(path, run);
		void run.finally(() => {
			// Drop the chain entry once it's the tail and has settled.
			if (this.chains.get(path) === run) this.chains.delete(path);
		});
	}
}
