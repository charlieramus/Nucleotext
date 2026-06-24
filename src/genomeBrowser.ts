import { ItemView, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type NucleotextPlugin from "../main";
import { Chromosome, Genome } from "./genome";

/**
 * Linear Genome Browser (log 4).
 *
 * Stage 1 — View Registration: a real, stable custom view wired into Obsidian.
 * It opens in a main-area pane, persists through workspace save/reload (it is a
 * registered view type, so Obsidian restores it automatically), and cleans up
 * after itself so repeated open/close leaves no orphaned panes, duplicate views
 * or leaked listeners/observers.
 *
 * Stage 2 — Track Rendering: each chromosome from the log-2 genome is drawn as
 * its own horizontal track, sized in proportion to that chromosome's actual
 * total sequence length and clearly labelled.
 *
 * ── Why canvas, not SVG ─────────────────────────────────────────────────────
 * The tracks are drawn on a single <canvas>. Reasons it integrates more cleanly
 * here than SVG:
 *   • Stage 3 (zoom/pan) must stay smooth on vaults with a very large total
 *     sequence length. An immediate-mode canvas redraws a handful of rectangles
 *     regardless of sequence size, whereas SVG would accumulate one node per
 *     drawn region and bog down the DOM at high zoom.
 *   • Stage 4 (per-region GC / mutation shading) paints many coloured segments
 *     per track; on canvas that is just more fillRect calls, not thousands of
 *     extra DOM elements.
 *   • Stage 5 (click-through) needs an exact pixel→note hit test. We already own
 *     the coordinate mapping used to draw, so the inverse mapping is trivial and
 *     precise — no reliance on SVG event targets at element boundaries.
 * The only thing canvas gives up is CSS theming of shapes, which we recover by
 * reading Obsidian's theme variables and painting with those colours, so the
 * browser still follows light/dark themes.
 *
 * No zoom, pan or interaction here — that is stage 3. This view is static,
 * accurate, proportional rendering only.
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
/**
 * Floor on a track's drawn width. Pure linear scaling would render a chromosome
 * that is a tiny fraction of the largest as a sub-pixel sliver — effectively
 * invisible. We keep length the dominant visual signal (the bar fills its lane
 * in proportion to length) but never let a real chromosome shrink below this, so
 * the smallest stays visible; the always-drawn label carries the exact figure.
 */
const MIN_BAR_WIDTH = 4;

export class GenomeBrowserView extends ItemView {
	private readonly plugin: NucleotextPlugin;
	private genome: Genome | null = null;
	private loading = false;

	private scrollEl: HTMLDivElement | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private lastWidth = 0;

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

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("nucleotext-browser");

		const head = root.createDiv({ cls: "nucleotext-browser-head" });
		head.createEl("h3", { text: "Genome browser" });
		const refreshBtn = head.createEl("button", {
			cls: "nucleotext-browser-refresh",
		});
		setIcon(refreshBtn, "refresh-cw");
		refreshBtn.setAttr("aria-label", "Rebuild from vault");
		refreshBtn.onclick = () => void this.refresh();

		this.scrollEl = root.createDiv({ cls: "nucleotext-browser-scroll" });
		this.canvas = this.scrollEl.createEl("canvas", {
			cls: "nucleotext-browser-canvas",
		});

		// Redraw on pane resize so track widths stay proportional to the
		// available width. Tracked with this.register so it is torn down on close
		// — no leaked observer across repeated open/close cycles.
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.scrollEl);
		this.register(() => {
			this.resizeObserver?.disconnect();
			this.resizeObserver = null;
		});

		// Folder add/remove/rename all surface as file create/delete/rename here.
		// registerEvent ties these to the view lifecycle (auto-removed on close).
		this.registerEvent(this.app.vault.on("create", this.scheduleRefresh));
		this.registerEvent(this.app.vault.on("delete", this.scheduleRefresh));
		this.registerEvent(this.app.vault.on("rename", this.scheduleRefresh));

		await this.refresh();
	}

	async onClose(): Promise<void> {
		// registerEvent / this.register handle listener + observer teardown; drop
		// our own references so the canvas and genome can be garbage collected and
		// nothing survives to a second open of a fresh view instance.
		this.scrollEl = null;
		this.canvas = null;
		this.genome = null;
		this.contentEl.empty();
	}

	/** Rebuild the genome from the current vault and redraw. */
	async refresh(): Promise<void> {
		this.loading = true;
		this.draw();
		this.genome = await this.plugin.refreshGenome();
		this.loading = false;
		this.draw();
	}

	private handleResize(): void {
		const width = this.scrollEl?.clientWidth ?? 0;
		// Ignore no-op notifications (e.g. height-only changes) to avoid redundant
		// redraws while scrolling.
		if (width === this.lastWidth) return;
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
		const drawTracks = !this.loading && this.genome && chromosomes.length > 0;

		const cssHeight = drawTracks
			? PADDING_TOP + chromosomes.length * ROW_HEIGHT + PADDING_BOTTOM
			: Math.max(120, scroll.clientHeight);

		const ctx = this.prepareCanvas(canvas, cssWidth, cssHeight);
		if (!ctx) return;

		ctx.clearRect(0, 0, cssWidth, cssHeight);

		if (this.loading) {
			this.drawMessage(ctx, cssWidth, cssHeight, theme, "Building genome…");
			return;
		}
		if (!this.genome) {
			this.drawMessage(
				ctx,
				cssWidth,
				cssHeight,
				theme,
				'No genome yet. Run "Build encoder from vault", then reopen this view.'
			);
			return;
		}
		if (chromosomes.length === 0) {
			this.drawMessage(
				ctx,
				cssWidth,
				cssHeight,
				theme,
				"No chromosomes — the vault has no encodable notes yet."
			);
			return;
		}

		this.drawTracks(ctx, cssWidth, chromosomes, theme);
	}

	/**
	 * Size the canvas backing store for the device pixel ratio (crisp text and
	 * edges on HiDPI displays) while keeping CSS layout in logical pixels, and
	 * return a context already scaled so all draw calls use CSS pixels.
	 */
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
		const laneWidth = Math.max(0, cssWidth - 2 * PADDING_X);
		// Proportionality is anchored to the LONGEST chromosome: it fills the lane,
		// every other track is scaled by its share of that maximum length. A vault
		// where one chromosome dwarfs the rest therefore reads correctly, and the
		// MIN_BAR_WIDTH floor keeps the small ones from vanishing.
		const maxLen = chromosomes.reduce((m, c) => Math.max(m, c.length), 0);
		const defaultName = this.genome?.defaultChromosome;

		let y = PADDING_TOP;
		for (const chr of chromosomes) {
			const proportion = maxLen > 0 ? chr.length / maxLen : 0;
			const barWidth =
				laneWidth <= 0
					? 0
					: Math.max(MIN_BAR_WIDTH, Math.min(laneWidth, laneWidth * proportion));

			// Label: name always in full, with exact figures, so even a track too
			// small to read by width is never unreadable by identity.
			const labelBaseline = y + LABEL_HEIGHT - 4;
			ctx.textBaseline = "alphabetic";
			ctx.font = `600 13px ${theme.fontUi}`;
			ctx.fillStyle = theme.textNormal;
			let nameText = chr.name;
			if (defaultName && chr.name === defaultName) nameText += "  (root notes)";
			ctx.fillText(nameText, PADDING_X, labelBaseline);
			const nameWidth = ctx.measureText(nameText).width;

			ctx.font = `12px ${theme.fontUi}`;
			ctx.fillStyle = theme.textMuted;
			const meta =
				`  ·  ${chr.notes.length.toLocaleString()} note${chr.notes.length === 1 ? "" : "s"}` +
				`  ·  ${chr.length.toLocaleString()} bases  ·  GC ${chr.gcPercent.toFixed(1)}%`;
			ctx.fillText(meta, PADDING_X + nameWidth, labelBaseline);

			// Lane (faint full-width track) + proportional filled bar on top, so the
			// chromosome's share of the longest is visible at a glance.
			const barY = y + LABEL_HEIGHT + LABEL_GAP;
			roundRect(ctx, PADDING_X, barY, laneWidth, BAR_HEIGHT, 4);
			ctx.fillStyle = theme.lane;
			ctx.fill();

			roundRect(ctx, PADDING_X, barY, barWidth, BAR_HEIGHT, 4);
			ctx.fillStyle = theme.accent;
			ctx.fill();

			y += ROW_HEIGHT;
		}
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

	/** Pull theme colours so the canvas tracks Obsidian's light/dark themes. */
	private readTheme(): Theme {
		const styles = getComputedStyle(this.contentEl);
		const v = (name: string, fallback: string): string =>
			styles.getPropertyValue(name).trim() || fallback;
		return {
			textNormal: v("--text-normal", "#dcddde"),
			textMuted: v("--text-muted", "#999"),
			lane: v("--background-modifier-border", "rgba(127,127,127,0.2)"),
			accent: v("--interactive-accent", "#7b6cd9"),
			fontUi: v("--font-interface", "sans-serif"),
		};
	}
}

interface Theme {
	textNormal: string;
	textMuted: string;
	lane: string;
	accent: string;
	fontUi: string;
}

/** Trace a rounded rectangle path (clamped radius), ready to fill/stroke. */
function roundRect(
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
