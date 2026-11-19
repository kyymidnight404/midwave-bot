/**
 * Standardized error codes for the Midwave media downloader pipeline.
 */
export const DOWNLOADER_ERROR_CODES = Object.freeze({
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_PLATFORM: 'UNSUPPORTED_PLATFORM',
  UNSAFE_TARGET: 'UNSAFE_TARGET',
  MISSING_DEPENDENCY: 'MISSING_DEPENDENCY',
  PRIVATE_OR_RESTRICTED: 'PRIVATE_OR_RESTRICTED',
  NOT_FOUND: 'NOT_FOUND',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  DURATION_EXCEEDED: 'DURATION_EXCEEDED',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  BUSY: 'BUSY',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  EXTRACTION_FAILED: 'EXTRACTION_FAILED',
});

/**
 * Typed domain error for media download operations.
 * Separates user-facing Indonesian messaging from internal diagnostic codes.
 */
export class DownloaderError extends Error {
  /**
   * @param {string} code - One of DOWNLOADER_ERROR_CODES.
   * @param {string} userMessage - Safe, user-readable message for Discord replies.
   * @param {{ retryable?: boolean, cause?: unknown, details?: string }} [options]
   */
  constructor(code, userMessage, options = {}) {
    super(options.details || userMessage);
    this.name = 'DownloaderError';
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = Boolean(options.retryable);
    this.details = options.details ?? '';
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * Checks whether an error is a permanent failure that must not be retried.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isPermanentDownloaderError(error) {
  if (!(error instanceof DownloaderError)) {
    return false;
  }

  return !error.retryable;
}
