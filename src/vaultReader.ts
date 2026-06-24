import { App, TFile } from "obsidian";
import { FrequencyTable, buildFrequencyTable } from "./frequency";

export interface ReadFailure {
	path: string;
	error: string;
}

export interface VaultScanResult {
	frequencyTable: FrequencyTable;
	filesIncluded: number;
	filesExcluded: number;
	filesFailed: ReadFailure[];
	totalChars: number;
}

/**
 * True if `path` lives inside (or is) any excluded folder.
 *
 * Matching is case-insensitive and path-segment aware, so an exclusion of
 * "Journal" excludes "Journal/2024/today.md" but NOT "Journalmof.md".
 */
export function isExcluded(path: string, excludedFolders: string[]): boolean {
	const p = path.toLowerCase();
	return excludedFolders.some((folder) => {
		const f = folder.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
		if (f === "") return false;
		return p === f || p === `${f}.md` || p.startsWith(`${f}/`);
	});
}

/**
 * Walk the entire vault file tree, read every included markdown file, and
 * aggregate one character frequency table across all of them.
 *
 * - `getMarkdownFiles()` returns every `.md` file at any depth, so nested
 *   folders are covered, not just the vault root.
 * - Folders listed in settings are skipped entirely.
 * - A file that fails to read is recorded in `filesFailed` and skipped; it
 *   does not abort the rest of the scan.
 */
export async function scanVault(
	app: App,
	excludedFolders: string[]
): Promise<VaultScanResult> {
	const files: TFile[] = app.vault.getMarkdownFiles();
	const texts: string[] = [];
	const filesFailed: ReadFailure[] = [];
	let filesIncluded = 0;
	let filesExcluded = 0;
	let totalChars = 0;

	for (const file of files) {
		if (isExcluded(file.path, excludedFolders)) {
			filesExcluded++;
			continue;
		}
		try {
			const content = await app.vault.cachedRead(file);
			texts.push(content);
			// Count by code point to stay consistent with the frequency table.
			for (const _ of content) totalChars++;
			filesIncluded++;
		} catch (e) {
			filesFailed.push({
				path: file.path,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return {
		frequencyTable: buildFrequencyTable(texts),
		filesIncluded,
		filesExcluded,
		filesFailed,
		totalChars,
	};
}
