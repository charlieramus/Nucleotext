export interface NucleotextSettings {
	/**
	 * Folders to exclude from the genome entirely (e.g. a private journal).
	 * Paths are vault-relative, matched case-insensitively against a file's
	 * path and all of its parent folders.
	 */
	excludedFolders: string[];

	/** Stage 5: maximum allowed homopolymer run length (>= 2). */
	maxRun: number;
	/** Stage 5: whether the homopolymer constraint is applied. */
	enableHomopolymer: boolean;

	/** Stage 6: target GC content as a percentage (0-100). */
	gcTargetPercent: number;
	/** Stage 6: whether the GC-bias constraint is applied. */
	enableGc: boolean;
}

export const DEFAULT_SETTINGS: NucleotextSettings = {
	excludedFolders: [],
	maxRun: 3,
	enableHomopolymer: true,
	gcTargetPercent: 50,
	enableGc: true,
};
