export interface NucleotextSettings {
	/**
	 * Folders to exclude from the genome entirely (e.g. a private journal).
	 * Paths are vault-relative, matched case-insensitively against a file's
	 * path and all of its parent folders.
	 */
	excludedFolders: string[];
}

export const DEFAULT_SETTINGS: NucleotextSettings = {
	excludedFolders: [],
};
