/**
 * Stage 2 — Record headers.
 *
 * Every note needs one consistent, unique, FASTA-safe header that later stages
 * (and the FASTA export in stage 3) can write directly into a record line.
 *
 * Design:
 * - The header is two parts separated by a single space, matching the standard
 *   FASTA "identifier description" convention:
 *
 *       <uid> <description>
 *
 *   `uid` is the note's full vault path with the `.md` extension stripped and
 *   all whitespace/control characters removed. A vault cannot contain two files
 *   with the same path, so the uid is GLOBALLY UNIQUE by construction — this is
 *   what defeats the "same filename in two different folders" collision: their
 *   parent folders differ, so their paths (and uids) differ.
 *
 *   `description` is the human-readable part: the note's basename followed by a
 *   summary of its frontmatter as `key=value` pairs.
 *
 * - Missing frontmatter is fine: the description always carries at least
 *   `name=<basename>`, so the header is never empty and is still unique via the
 *   uid.
 *
 * - Everything is sanitized so the header is a single line with no `\r`/`\n`/`\t`
 *   that could split a record or be mistaken for a sequence line in stage 3.
 */

export interface NoteMeta {
	/** Full vault-relative path, e.g. "Projects/Sub/Note.md". */
	path: string;
	/** Display name without extension, e.g. "Note". */
	basename: string;
	/** Parsed YAML frontmatter, or null/undefined when there is none. */
	frontmatter?: Record<string, unknown> | null;
}

/** Frontmatter keys Obsidian injects that are noise in a header. */
const FRONTMATTER_SKIP = new Set(["position"]);

/** Control characters (incl. \r \n \t) plus DEL — never allowed in a header. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]+/g;

/** Collapse to a single whitespace-free, control-free token (used for the uid). */
function sanitizeToken(s: string): string {
	return s
		.replace(CONTROL, "") // strip control chars incl. \r \n \t
		.replace(/\s+/g, "_") // no spaces -> stays a single FASTA identifier
		.replace(/^>+/, ""); // a leading '>' would look like a new record
}

/** Flatten to a single trimmed line (used for descriptions / values). */
function sanitizeText(s: string): string {
	return s
		.replace(CONTROL, " ") // control chars (incl. newlines) -> space
		.replace(/\s+/g, " ")
		.trim();
}

function stripMd(path: string): string {
	return path.replace(/\.md$/i, "");
}

/** Render a frontmatter value as a compact, single-line string. */
function renderValue(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (Array.isArray(v)) {
		return v
			.map((x) => renderValue(x))
			.filter((s) => s !== "")
			.join(", ");
	}
	if (typeof v === "object") {
		try {
			return JSON.stringify(v);
		} catch {
			return String(v);
		}
	}
	return String(v);
}

/**
 * Build the header text for a note (WITHOUT the leading ">"; stage 3 adds that).
 *
 * The result is guaranteed to be:
 * - non-empty (always at least `<uid> name=<basename>`),
 * - unique across the vault (the uid is the unique path), and
 * - a single line safe to write into a FASTA file.
 */
export function buildHeader(meta: NoteMeta): string {
	const uid = sanitizeToken(stripMd(meta.path)) || "note";

	const parts: string[] = [`name=${sanitizeText(meta.basename)}`];
	const fm = meta.frontmatter;
	if (fm && typeof fm === "object") {
		for (const key of Object.keys(fm).sort()) {
			if (FRONTMATTER_SKIP.has(key)) continue;
			const value = sanitizeText(renderValue(fm[key]));
			if (value === "") continue;
			parts.push(`${sanitizeText(key)}=${value}`);
		}
	}

	return `${uid} ${parts.join("; ")}`;
}
