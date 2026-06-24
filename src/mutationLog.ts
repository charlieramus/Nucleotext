/**
 * Stage 4 (mutation tracker) — Mutation Log model.
 *
 * Holds one entry per *edit event* (a save that produced at least one mutation),
 * grouped by note, and notifies listeners when it changes so the panel can
 * update live. Stage 5 adds durable persistence and the clear controls on top of
 * this same model — the shape here is already serialisable and exposes
 * `clearNote`/`clearAll` for that.
 *
 * A zero-mutation save never creates an entry (see {@link MutationLog.record}),
 * so no-op saves can't clutter the log.
 */

import { MutationCounts } from "./classify";

/** One edit event: a single save of one note that produced mutations. */
export interface MutationEvent {
	/** Stable unique id (timestamp + counter), used as a render key. */
	id: string;
	/** Vault path of the note this event belongs to (the grouping key). */
	path: string;
	/** Display name without extension, captured at event time. */
	basename: string;
	/** Epoch ms the event was recorded. */
	timestamp: number;
	/** Per-type mutation counts for this single edit. */
	counts: MutationCounts;
}

/** A note plus its events, newest first — what the panel renders per section. */
export interface NoteHistory {
	path: string;
	basename: string;
	events: MutationEvent[];
	/** Timestamp of the most recent event (for ordering notes). */
	lastAt: number;
	/** Summed counts across all of this note's events. */
	totals: MutationCounts;
}

/** Persisted shape (stage 5). */
export interface MutationLogData {
	version: 1;
	events: MutationEvent[];
}

type Listener = () => void;

export class MutationLog {
	/** All events in insertion order (oldest first). */
	private events: MutationEvent[] = [];
	private listeners = new Set<Listener>();
	private seq = 0;

	constructor(initial?: MutationLogData | null) {
		if (initial?.events?.length) {
			this.events = initial.events.slice();
			// Make sure new ids never collide with loaded ones.
			this.seq = this.events.length;
		}
	}

	/**
	 * Record an edit event. Returns the created event, or `null` if `counts.total`
	 * is zero (a no-op save — we never add an empty entry). Fires listeners only
	 * when an entry is actually added.
	 */
	record(
		path: string,
		basename: string,
		counts: MutationCounts,
		timestamp: number = Date.now()
	): MutationEvent | null {
		if (counts.total === 0) return null;
		const event: MutationEvent = {
			id: `${timestamp}-${this.seq++}`,
			path,
			basename,
			timestamp,
			counts,
		};
		this.events.push(event);
		this.emit();
		return event;
	}

	/** Total number of events across all notes. */
	size(): number {
		return this.events.length;
	}

	/** All events, newest first. */
	all(): MutationEvent[] {
		return this.events.slice().reverse();
	}

	/**
	 * Notes that have history, each with its events newest-first, ordered by most
	 * recent activity (most recently edited note first).
	 */
	byNote(): NoteHistory[] {
		const map = new Map<string, NoteHistory>();
		for (const e of this.events) {
			let h = map.get(e.path);
			if (!h) {
				h = {
					path: e.path,
					basename: e.basename,
					events: [],
					lastAt: 0,
					totals: { point: 0, insertion: 0, deletion: 0, frameshift: 0, total: 0 },
				};
				map.set(e.path, h);
			}
			h.events.push(e);
			h.basename = e.basename; // keep the latest known display name
			if (e.timestamp > h.lastAt) h.lastAt = e.timestamp;
			h.totals.point += e.counts.point;
			h.totals.insertion += e.counts.insertion;
			h.totals.deletion += e.counts.deletion;
			h.totals.frameshift += e.counts.frameshift;
			h.totals.total += e.counts.total;
		}
		const out = [...map.values()];
		for (const h of out) h.events.reverse(); // newest first within a note
		out.sort((a, b) => b.lastAt - a.lastAt); // most recently active note first
		return out;
	}

	/** Stage 5: remove all history for one note. Returns how many events were removed. */
	clearNote(path: string): number {
		const before = this.events.length;
		this.events = this.events.filter((e) => e.path !== path);
		const removed = before - this.events.length;
		if (removed > 0) this.emit();
		return removed;
	}

	/** Stage 5: remove all history for every note. Returns how many events were removed. */
	clearAll(): number {
		const removed = this.events.length;
		if (removed > 0) {
			this.events = [];
			this.emit();
		}
		return removed;
	}

	/** Serialise for persistence (stage 5). */
	toData(): MutationLogData {
		return { version: 1, events: this.events.slice() };
	}

	/** Subscribe to changes; returns an unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const l of this.listeners) {
			try {
				l();
			} catch (e) {
				console.error("Nucleotext mutation-log listener failed:", e);
			}
		}
	}
}
