/**
 * Token Saver — self-contained compression module for omnicell-router.
 *
 * Compresses verbose tool/command output embedded in conversation history
 * (git status, grep hits, build logs, directory listings …) before the
 * request is forwarded upstream, cutting input tokens on noisy turns.
 * Detection logic, compression strategies, and output formats are designed
 * and implemented in this project.
 */

/** Blobs smaller than this are not worth compressing. */
export const MIN_BLOB_BYTES = 500;
/** Blobs larger than this are left untouched (safety ceiling). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

/** The classifier samples at most this many leading bytes / lines. */
export const SAMPLE_BYTES = 4096;
export const SAMPLE_LINES = 200;

/** Minimum confidence score required to pick a specialized compressor. */
export const DETECT_MIN_SCORE = 3;

/** Per-compressor budgets. */
export const GIT_STATUS_FILES_SHOWN = 8;
export const GIT_DIFF_CHANGED_LINES_PER_FILE = 60;
export const GIT_LOG_ENTRIES_MAX = 100;
export const GREP_MATCHES_PER_FILE = 8;
export const PATHS_PER_DIR_SHOWN = 8;
export const PATHS_DIRS_MAX = 15;
export const BUILD_WARNINGS_SHOWN = 3;
export const GENERIC_HEAD_LINES = 120;
export const GENERIC_TAIL_LINES = 60;
export const GENERIC_MIN_LINES_TO_CUT = 250;

/** Directory names treated as noise in listings. */
export const LISTING_NOISE_NAMES = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', '__pycache__',
  '.next', '.cache', '.turbo', '.vercel', 'coverage',
  '.venv', 'venv', '.idea', '.vscode',
]);
