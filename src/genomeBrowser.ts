import { ItemView, ViewStateResult, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type NucleotextPlugin from "../main";
import { Chromosome, Genome } from "./genome";

/**
 * Linear Genome Browser (log 4).
 *
 * Stage 1 — View Registration: a real, stable custom view wired into Obsidian.
 *   Opens in a main-area pane, persists through workspace save/reload, and cleans
 *   up after itself (no orphaned panes, listeners or observers).
 *
 * Stage 2 — Track Rendering: each chromosome from the log-2 genome is drawn as
 *   its own horizontal track, sized in proportion to its total sequence length.
 *
 * Stage 3 — Zoom and Pan: the tracks are drawn through a shared horizontal
 *   viewport expressed in BASE COORDINATES — a zoom factor (`pxPerBase`) and a
 *   pan offset (`viewStartBase`). All tracks share one scale, so a base in one
 *   chromosome is always the same number of pixels as a base in another and the
 *   stage-2 proportionality holds at every zoom level.
 *
 *   Crucially, the canvas is always the size of the VIEWPORT, never the size of
 *   the sequence. We draw only the note-segments that fall inside the visible
 *   base window, so render cost is O(visible notes), independent of total
 *   sequence length — this is what keeps a very large vault smooth instead of
 *   sluggish. Zoom/pan state lives in the view and is also serialised into the
 *   workspace layout (getState/setState), so it survives reopening the view and
 *   restarting Obsidian rather than resetting.
 *
 *   Zoom limits (documented, enforced by clampZoom):
 *     • MIN zoom = fit-to-width — the longest chromosome exactly fills the lane.
 *       You cannot zoom out further; doing so would only shrink the whole genome
 *       into empty space, a meaningless state.
 *     • MAX zoom = MAX_PX_PER_BASE pixels per base — one base spans a dozen
 *       pixels. You cannot zoom past a single base into sub-base nothing. (For a
 *       tiny vault whose fit zoom is already finer than that, max is raised to
 *       the fit zoom so the genome always at least fits; there is simply no zoom
 *       range to traverse.)
 *
 * Stage 4 — Color Coding: each chromosome's bar is painted as its note-segments,
 *   shaded by one of two modes the user toggles between, with no view reload:
 *     • GC content — a blue↔orange diverging scale centred on 50% GC, read
 *       straight from each note's log-2 `gcPercent`.
 *     • Mutation activity — a sequential purple scale from the log-3 mutation
 *       log, weighting each note's recorded mutations by recency so "recent"
 *       activity stands out.
 *   Neither palette relies on red-vs-green, so both stay distinguishable under
 *   common colour-vision deficiencies (blue/orange and a single-hue purple ramp
 *   are safe choices). A legend under the controls explains the active scale.
 *
 * ── Why canvas, not SVG (unchanged from stage 2) ────────────────────────────
 * Immediate-mode canvas redraws a fixed handful of rects regardless of sequence
 * size (stage 3 performance), paints per-region shading as plain fills (stage 4),
 * and gives an exact pixel→note hit test for stage 5 since we own the draw-time
 * coordinate mapping. Theme integration is recovered by reading Obsidian's CSS
 * variables and painting with them.
 */
export const GENOME_BROWSER_VIEW = "nucleotext-genome-browser";

/** Layout constants (CSS pixels). */
const PADDING_X = 16;
const PADDING_TOP = 12;
const PADDING_BOTTOM = 16;
const LABEL_HEIGHT = 18;
const LABEL_GAP = 5;
const BAR_HEIGHT = 22;
const ROW_GAP = 18;
const ROW_HEIGHT = LABEL_HEIGHT + LABEL_GAP + BAR_HEIGHT + ROW_GAP;

/** Stage 3 max zoom: one base spans at most this many pixels. */
const MAX_PX_PER_BASE = 12;
/** Click of a zoom button multiplies/divides the scale by this. */
const ZOOM_BUTTON_FACTOR = 1.5;
/** Recency half-life for mutation-activity weighting (stage 4): 7 days. */
const MUTATION_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Diverging GC palette (colour-blind safe blue↔orange, neutral at 50%). */
const GC_LOW = "#2c7bb6";
const GC_MID = "#f7f7f7";
const GC_HIGH = "#e66101";
/** GC domain clamped to this window so typical near-50% variation reads well. */
const GC_DOMAIN_LO = 30;
const GC_DOMAIN_HI = 70;
/** Sequential mutation palette (single-hue purple ramp, colour-blind safe). */
const MUT_LOW = "#dadaeb";
const MUT_HIGH = "#54278f";

type ColorMode = "gc" | "mutation";

export class GenomeBrowserView extends ItemView {
	private readonly plugin: NucleotextPlugin;
	private genome: Genome | null = null;
	private loading = false;

	private scrollEl: HTMLDivElement | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private zoomLabelEl: HTMLSpanElement | null = null;
	private modeButtons: Partial<Record<ColorMode, HTMLButtonElement>> = {};
	private legendBarEl: HTMLDivElement | null = null;
	private legendLabelsEl: HTMLDivElement | null = null;

	private resizeObserver: ResizeObserver | null = null;
	private lastWidth = 0;

	// Stage 3 viewport: pxPerBase null means "fit on next draw".
	private pxPerBase: number | null = null;
	private viewStartBase = 0;
	// Stage 4 colouring.
	private colorMode: ColorMode = "gc";
	/** Per-note recency-weighted mutation activity, normalised to 0..1. */
	private mutationIntensity = new Map<string, number>();

	private dragging = false;
	private dragStartX = 0;
	private dragStartView = 0;

	private readonly scheduleRefresh: () => void;

	constructor(leaf: WorkspaceLeaf, plugin: NucleotextPlugin) {
		super(leaf);
		this.plugin = plugin;
		// Coalesce bursts of vault events (e.g. a folder rename touching many files).
		this.scheduleRefresh = debounce(() => void this.refresh(), 400, true);
	}

	getViewType(): string {
		return GENOME_BROWSER_VIEW;
	}

	getDisplayText(): string {
		return "Genome browser";
	}

	getIcon(): string {
		return "microscope";
	}

	// --- stage 3: persist zoom/pan/mode in the workspace layout --------------

	getState(): Record<string, unknown> {
		return {
			...super.getState(),
			pxPerBase: this.pxPerBase,
			viewStartBase: this.viewStartBase,
			colorMode: this.colorMode,
		};
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = (state ?? {}) as Record<string, unknown>;
		if (typeof s.pxPerBase === "number" && isFinite(s.pxPerBase)) {
			this.pxPerBase = s.pxPerBase;
		}
		if (typeof s.viewStartBase === "number" && isFinite(s.viewStartBase)) {
			this.viewStartBase = Math.max(0, s.viewStartBase);
		}
		if (s.colorMode === "gc" || s.colorMode === "mutation") {
			this.colorMode = s.colorMode;
		}
		this.syncControls();
		this.draw();
	}

	// --- lifecycle -----------------------------------------------------------

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("nucleotext-browser");

		this.buildHeader(root);

		this.scrollEl = root.createDiv({ cls: "nucleotext-browser-scroll" });
		this.canvas = this.scrollEl.createEl("canvas", {
			cls: "nucleotext-browser-canvas",
		});
		this.canvas.style.cursor = "grab";

		// Stage 3 interaction. registerDomEvent / this.register tie every listener
		// and the observer to the view lifecycle, so repeated open/close leaks none.
		this.registerDomEvent(this.canvas, "pointerdown", (e) => this.onPointerDown(e));
		this.registerDomEvent(this.canvas, "pointermove", (e) => this.onPointerMove(e));
		this.registerDomEvent(this.canvas, "pointerup", (e) => this.onPointerUp(e));
		this.registerDomEvent(this.canvas, "pointercancel", (e) => this.onPointerUp(e));
		// Plain wheel scrolls the track list vertically (native); Ctrl/Cmd+wheel
		// zooms horizontally, anchored at the cursor. passive:false so we can
		// preventDefault on the zoom path.
		this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
		this.register(() => this.canvas?.removeEventListener("wheel", this.onWheel));

		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.scrollEl);
		this.register(() => {
			this.resizeObserver?.disconnect();
			this.resizeObserver = null;
		});

		// Folder add/remove/rename surface as file create/delete/rename.
		this.registerEvent(this.app.vault.on("create", this.scheduleRefresh));
		this.registerEvent(this.app.vault.on("delete", this.scheduleRefresh));
		this.registerEvent(this.app.vault.on("rename", this.scheduleRefresh));

		// Stage 4: keep mutation colouring live as saves land in the log.
		this.register(
			this.plugin.mutationLog.subscribe(() => {
				this.recomputeMutationIntensity();
				if (this.colorMode === "mutation") this.draw();
			})
		);

		await this.refresh();
	}

	async onClose(): Promise<void> {
		// registerEvent / registerDomEvent / this.register handle all teardown;
		// drop references so the canvas and genome can be collected.
		this.scrollEl = null;
		this.canvas = null;
		this.zoomLabelEl = null;
		this.legendBarEl = null;
		this.legendLabelsEl = null;
		this.modeButtons = {};
		this.genome = null;
		this.mutationIntensity.clear();
		this.contentEl.empty();
	}

	private buildHeader(root: HTMLElement): void {
		const head = root.createDiv({ cls: "nucleotext-browser-head" });
		head.createEl("h3", { text: "Genome browser" });
		const refreshBtn = head.createEl("button", {
			cls: "nucleotext-browser-refresh",
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.setAttr("aria-label", "Rebuild from vault");
		refreshBtn.onclick = () => void this.refresh();

		const controls = root.createDiv({ cls: "nucleotext-browser-controls" });

		// Stage 3: zoom controls.
		const zoomGroup = controls.createDiv({ cls: "nucleotext-browser-group" });
		const fitBtn = zoomGroup.createEl("button", {
			cls: "nucleotext-browser-btn",
			text: "Fit",
		});
		fitBtn.setAttr("aria-label", "Zoom to fit the whole genome");
		fitBtn.onclick = () => this.fit();
		const outBtn = zoomGroup.createEl("button", {
			cls: "nucleotext-browser-btn",
			text: "−",
		});
		outBtn.setAttr("aria-label", "Zoom out");
		outBtn.onclick = () => this.zoomByButton(1 / ZOOM_BUTTON_FACTOR);
		this.zoomLabelEl = zoomGroup.createSpan({
			cls: "nucleotext-browser-zoom",
			text: "1.0×",
		});
		const inBtn = zoomGroup.createEl("button", {
			cls: "nucleotext-browser-btn",
			text: "+",
		});
		inBtn.setAttr("aria-label", "Zoom in");
		inBtn.onclick = () => this.zoomByButton(ZOOM_BUTTON_FACTOR);
		zoomGroup.createSpan({
			cls: "nucleotext-browser-hint",
			text: "drag to pan · Ctrl+wheel to zoom",
		});

		// Stage 4: colour-mode toggle.
		const modes = controls.createDiv({ cls: "nucleotext-browser-modes" });
		this.modeButtons.gc = modes.createEl("button", {
			cls: "nucleotext-browser-mode",
			text: "GC content",
		});
		this.modeButtons.gc.onclick = () => this.setColorMode("gc");
		this.modeButtons.mutation = modes.createEl("button", {
			cls: "nucleotext-browser-mode",
			text: "Mutations",
		});
		this.modeButtons.mutation.onclick = () => this.setColorMode("mutation");

		// Stage 4: legend for the active scale.
		const legend = root.createDiv({ cls: "nucleotext-browser-legend" });
		this.legendBarEl = legend.createDiv({ cls: "nucleotext-browser-legend-bar" });
		this.legendLabelsEl = legend.createDiv({
			cls: "nucleotext-browser-legend-labels",
		});

		this.syncControls();
	}

	/** Reflect current zoom/mode into the header controls and legend. */
	private syncControls(): void {
		for (const mode of ["gc", "mutation"] as ColorMode[]) {
			this.modeButtons[mode]?.toggleClass("is-active", this.colorMode === mode);
		}
		if (this.zoomLabelEl) {
			const fit = this.fitPxPerBase();
			const factor = this.pxPerBase && fit > 0 ? this.pxPerBase / fit : 1;
			this.zoomLabelEl.setText(`${factor.toFixed(1)}×`);
		}
		this.syncLegend();
	}

	private syncLegend(): void {
		if (!this.legendBarEl || !this.legendLabelsEl) return;
		this.legendLabelsEl.empty();
		if (this.colorMode === "gc") {
			this.legendBarEl.style.background = `linear-gradient(to right, ${GC_LOW}, ${GC_MID} 50%, ${GC_HIGH})`;
			for (const t of [`≤${GC_DOMAIN_LO}%`, "50% GC", `≥${GC_DOMAIN_HI}%`]) {
				this.legendLabelsEl.createSpan({ text: t });
			}
		} else {
			this.legendBarEl.style.background = `linear-gradient(to right, ${MUT_LOW}, ${MUT_HIGH})`;
			for (const t of ["no recent edits", "most recent activity"]) {
				this.legendLabelsEl.createSpan({ text: t });
			}
		}
	}

	/** Rebuild the genome from the current vault and redraw, preserving zoom/pan. */
	async refresh(): Promise<void> {
		this.loading = true;
		this.draw();
		this.genome = await this.plugin.refreshGenome();
		this.recomputeMutationIntensity();
		this.loading = false;
		this.draw();
	}

	private setColorMode(mode: ColorMode): void {
		if (this.colorMode === mode) return;
		this.colorMode = mode;
		this.syncControls();
		this.draw(); // immediate, no genome rebuild (stage 4 requirement)
		this.app.workspace.requestSaveLayout();
	}

	/**
	 * Stage 4: per-note recency-weighted mutation activity from the log-3 log,
	 * normalised to 0..1 across the vault. Recent edits dominate (exponential
	 * decay), so the colouring reads as "recent activity", not lifetime totals.
	 */
	private recomputeMutationIntensity(): void {
		const next = new Map<string, number>();
		const now = Date.now();
		let max = 0;
		const raw = new Map<string, number>();
		for (const e of this.plugin.mutationLog.all()) {
			const weight = Math.pow(2, -(now - e.timestamp) / MUTATION_HALF_LIFE_MS);
			raw.set(e.path, (raw.get(e.path) ?? 0) + e.counts.total * weight);
		}
		for (const s of raw.values()) max = Math.max(max, s);
		for (const [path, s] of raw) next.set(path, max > 0 ? s / max : 0);
		this.mutationIntensity = next;
	}

	// --- stage 3: viewport maths ---------------------------------------------

	private laneWidth(): number {
		const w = this.scrollEl?.clientWidth ?? 0;
		return Math.max(0, w - 2 * PADDING_X);
	}

	private maxLength(): number {
		const chrs = this.genome?.chromosomes ?? [];
		return Math.max(1, chrs.reduce((m, c) => Math.max(m, c.length), 0));
	}

	/** Zoom at which the longest chromosome exactly fills the lane. */
	private fitPxPerBase(): number {
		const lane = this.laneWidth();
		if (lane <= 0) return 1;
		return lane / this.maxLength();
	}

	private minZoom(): number {
		return this.fitPxPerBase();
	}

	private maxZoom(): number {
		return Math.max(this.fitPxPerBase(), MAX_PX_PER_BASE);
	}

	private clampZoom(px: number): number {
		return Math.min(this.maxZoom(), Math.max(this.minZoom(), px));
	}

	private visibleBases(px: number): number {
		const lane = this.laneWidth();
		return px > 0 ? lane / px : this.maxLength();
	}

	/** Bring zoom + pan into a valid range for the current genome and width. */
	private normalizeView(): void {
		if (this.pxPerBase === null || !isFinite(this.pxPerBase)) {
			this.pxPerBase = this.fitPxPerBase();
			this.viewStartBase = 0;
		}
		this.pxPerBase = this.clampZoom(this.pxPerBase);
		const maxStart = Math.max(0, this.maxLength() - this.visibleBases(this.pxPerBase));
		this.viewStartBase = Math.min(maxStart, Math.max(0, this.viewStartBase));
	}

	private fit(): void {
		this.pxPerBase = this.fitPxPerBase();
		this.viewStartBase = 0;
		this.afterViewChange();
	}

	private zoomByButton(factor: number): void {
		// Anchor the zoom on the centre of the viewport.
		this.zoomAround(this.laneWidth() / 2, factor);
	}

	/** Multiply zoom by `factor`, keeping the base under `focalLaneX` fixed. */
	private zoomAround(focalLaneX: number, factor: number): void {
		this.normalizeView();
		const px = this.pxPerBase ?? this.fitPxPerBase();
		const baseAtFocus = this.viewStartBase + focalLaneX / px;
		const nextPx = this.clampZoom(px * factor);
		this.pxPerBase = nextPx;
		this.viewStartBase = baseAtFocus - focalLaneX / nextPx;
		this.afterViewChange();
	}

	private afterViewChange(): void {
		this.normalizeView();
		this.syncControls();
		this.draw();
		this.app.workspace.requestSaveLayout();
	}

	// --- stage 3: input handlers ---------------------------------------------

	private readonly onWheel = (e: WheelEvent): void => {
		if (!(e.ctrlKey || e.metaKey)) return; // plain wheel = native vertical scroll
		e.preventDefault();
		const rect = this.canvas?.getBoundingClientRect();
		if (!rect) return;
		const focalLaneX = e.clientX - rect.left - PADDING_X;
		// Smooth, proportional zoom from the wheel delta.
		const factor = Math.exp(-e.deltaY * 0.0015);
		this.zoomAround(focalLaneX, factor);
	};

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) return;
		this.dragging = true;
		this.dragStartX = e.clientX;
		this.normalizeView();
		this.dragStartView = this.viewStartBase;
		this.canvas?.setPointerCapture(e.pointerId);
		if (this.canvas) this.canvas.style.cursor = "grabbing";
	}

	private onPointerMove(e: PointerEvent): void {
		if (!this.dragging) return;
		const px = this.pxPerBase ?? this.fitPxPerBase();
		const dxBases = (e.clientX - this.dragStartX) / px;
		this.viewStartBase = this.dragStartView - dxBases;
		this.normalizeView();
		this.syncControls();
		this.draw();
	}

	private onPointerUp(e: PointerEvent): void {
		if (!this.dragging) return;
		this.dragging = false;
		this.canvas?.releasePointerCapture(e.pointerId);
		if (this.canvas) this.canvas.style.cursor = "grab";
		this.app.workspace.requestSaveLayout();
	}

	private handleResize(): void {
		const width = this.scrollEl?.clientWidth ?? 0;
		if (width === this.lastWidth) return; // ignore height-only notifications
		this.syncControls();
		this.draw();
	}

	// --- rendering -----------------------------------------------------------

	private draw(): void {
		const canvas = this.canvas;
		const scroll = this.scrollEl;
		if (!canvas || !scroll) return;

		const cssWidth = Math.max(0, scroll.clientWidth);
		this.lastWidth = cssWidth;
		if (cssWidth === 0) return; // not laid out yet; a resize will redraw.

		const theme = this.readTheme();
		const chromosomes = this.genome?.chromosomes ?? [];
		const hasTracks = !this.loading && !!this.genome && chromosomes.length > 0;

		const cssHeight = hasTracks
			? PADDING_TOP + chromosomes.length * ROW_HEIGHT + PADDING_BOTTOM
			: Math.max(120, scroll.clientHeight);

		const ctx = this.prepareCanvas(canvas, cssWidth, cssHeight);
		if (!ctx) return;
		ctx.clearRect(0, 0, cssWidth, cssHeight);

		if (this.loading) {
			return this.drawMessage(ctx, cssWidth, cssHeight, theme, "Building genome…");
		}
		if (!this.genome) {
			return this.drawMessage(
				ctx,
				cssWidth,
				cssHeight,
				theme,
				'No genome yet. Run "Build encoder from vault", then reopen this view.'
			);
		}
		if (chromosomes.length === 0) {
			return this.drawMessage(
				ctx,
				cssWidth,
				cssHeight,
				theme,
				"No chromosomes — the vault has no encodable notes yet."
			);
		}

		this.normalizeView();
		this.drawTracks(ctx, cssWidth, chromosomes, theme);
	}

	private prepareCanvas(
		canvas: HTMLCanvasElement,
		cssWidth: number,
		cssHeight: number
	): CanvasRenderingContext2D | null {
		const dpr = window.devicePixelRatio || 1;
		canvas.style.width = `${cssWidth}px`;
		canvas.style.height = `${cssHeight}px`;
		canvas.width = Math.round(cssWidth * dpr);
		canvas.height = Math.round(cssHeight * dpr);
		const ctx = canvas.getContext("2d");
		if (!ctx) return null;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		return ctx;
	}

	private drawTracks(
		ctx: CanvasRenderingContext2D,
		cssWidth: number,
		chromosomes: Chromosome[],
		theme: Theme
	): void {
		const laneLeft = PADDING_X;
		const laneRight = cssWidth - PADDING_X;
		const laneWidth = Math.max(0, laneRight - laneLeft);
		const px = this.pxPerBase ?? this.fitPxPerBase();
		const viewStart = this.viewStartBase;
		const viewEnd = viewStart + this.visibleBases(px);
		const defaultName = this.genome?.defaultChromosome;

		// base coordinate -> screen x within the lane.
		const baseToX = (b: number): number => laneLeft + (b - viewStart) * px;
		const clampX = (x: number): number => Math.min(laneRight, Math.max(laneLeft, x));

		let y = PADDING_TOP;
		for (const chr of chromosomes) {
			// Label (always full + exact figures, independent of the viewport).
			const labelBaseline = y + LABEL_HEIGHT - 4;
			ctx.textBaseline = "alphabetic";
			ctx.textAlign = "left";
			ctx.font = `600 13px ${theme.fontUi}`;
			ctx.fillStyle = theme.textNormal;
			let nameText = chr.name;
			if (defaultName && chr.name === defaultName) nameText += "  (root notes)";
			ctx.fillText(nameText, laneLeft, labelBaseline);
			const nameWidth = ctx.measureText(nameText).width;

			ctx.font = `12px ${theme.fontUi}`;
			ctx.fillStyle = theme.textMuted;
			const meta =
				`  ·  ${chr.notes.length.toLocaleString()} note${chr.notes.length === 1 ? "" : "s"}` +
				`  ·  ${chr.length.toLocaleString()} bases  ·  GC ${chr.gcPercent.toFixed(1)}%`;
			ctx.fillText(meta, laneLeft + nameWidth, labelBaseline);

			// Lane background spans the full viewport (the coordinate window).
			const barY = y + LABEL_HEIGHT + LABEL_GAP;
			roundRectPath(ctx, laneLeft, barY, laneWidth, BAR_HEIGHT, 4);
			ctx.fillStyle = theme.lane;
			ctx.fill();

			// Chromosome bar = its note-segments, clipped to a rounded bar shape.
			const barLeft = clampX(baseToX(0));
			const barRight = clampX(baseToX(chr.length));
			if (barRight - barLeft >= 0.5) {
				ctx.save();
				roundRectPath(ctx, barLeft, barY, barRight - barLeft, BAR_HEIGHT, 4);
				ctx.clip();

				let base = 0;
				for (const note of chr.notes) {
					const startBase = base;
					const endBase = base + note.length;
					base = endBase;
					// Skip note-segments entirely outside the visible window.
					if (endBase <= viewStart || startBase >= viewEnd) continue;
					const sx0 = clampX(baseToX(startBase));
					const sx1 = clampX(baseToX(endBase));
					if (sx1 - sx0 < 0.4) continue;
					ctx.fillStyle = this.colorForNote(note.path, note.gcPercent, theme);
					ctx.fillRect(sx0, barY, sx1 - sx0, BAR_HEIGHT);
				}
				ctx.restore();
			}

			y += ROW_HEIGHT;
		}
	}

	/** Stage 4: colour for a note-segment under the active mode. */
	private colorForNote(path: string, gcPercent: number, theme: Theme): string {
		if (this.colorMode === "gc") {
			return gcColor(gcPercent);
		}
		// Mutation: sqrt-spread the normalised intensity so low activity stays
		// visible; notes with no recorded activity sit at the cold end.
		const intensity = this.mutationIntensity.get(path) ?? 0;
		return mutationColor(Math.sqrt(intensity));
	}

	private drawMessage(
		ctx: CanvasRenderingContext2D,
		cssWidth: number,
		cssHeight: number,
		theme: Theme,
		text: string
	): void {
		ctx.fillStyle = theme.textMuted;
		ctx.font = `13px ${theme.fontUi}`;
		ctx.textBaseline = "middle";
		ctx.textAlign = "center";
		ctx.fillText(text, cssWidth / 2, cssHeight / 2, cssWidth - 2 * PADDING_X);
		ctx.textAlign = "left";
	}

	private readTheme(): Theme {
		const styles = getComputedStyle(this.contentEl);
		const v = (name: string, fallback: string): string =>
			styles.getPropertyValue(name).trim() || fallback;
		return {
			textNormal: v("--text-normal", "#dcddde"),
			textMuted: v("--text-muted", "#999"),
			lane: v("--background-modifier-border", "rgba(127,127,127,0.2)"),
			fontUi: v("--font-interface", "sans-serif"),
		};
	}
}

interface Theme {
	textNormal: string;
	textMuted: string;
	lane: string;
	fontUi: string;
}

// --- colour helpers ----------------------------------------------------------

/** Diverging blue↔orange GC colour, neutral at 50%, clamped to the read window. */
function gcColor(gcPercent: number): string {
	const mid = 50;
	const clamped = Math.min(GC_DOMAIN_HI, Math.max(GC_DOMAIN_LO, gcPercent));
	if (clamped <= mid) {
		const u = (clamped - GC_DOMAIN_LO) / (mid - GC_DOMAIN_LO);
		return lerpHex(GC_LOW, GC_MID, u);
	}
	const u = (clamped - mid) / (GC_DOMAIN_HI - mid);
	return lerpHex(GC_MID, GC_HIGH, u);
}

/** Sequential purple mutation colour; t in 0..1 (already perceptually spread). */
function mutationColor(t: number): string {
	return lerpHex(MUT_LOW, MUT_HIGH, Math.min(1, Math.max(0, t)));
}

function lerpHex(a: string, b: string, t: number): string {
	const ca = hexToRgb(a);
	const cb = hexToRgb(b);
	const r = Math.round(ca.r + (cb.r - ca.r) * t);
	const g = Math.round(ca.g + (cb.g - ca.g) * t);
	const bl = Math.round(ca.b + (cb.b - ca.b) * t);
	return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const h = hex.replace("#", "");
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

/** Trace a rounded rectangle path (clamped radius), ready to fill/clip. */
function roundRectPath(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number
): void {
	const radius = Math.max(0, Math.min(r, w / 2, h / 2));
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}
