const SENSITIVE_QUERY_RE =
  /([?&](?:token|access_token|refresh_token|auth|api_key|apikey|key|secret|password|pass|signature|sig|x-rapidapi-key)=)([^&\s]+)/gi;
const URL_CREDENTIALS_RE = /(https?:\/\/)([^:@\s]+:[^@\s]+@)/gi;
const BEARER_RE = /\b(Bearer|Basic|Bot)\s+[A-Za-z0-9._~+/-]+=*/gi;
const DISCORD_TOKEN_RE = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g;
const HEADER_KV_RE =
  /\b(authorization|x-rapidapi-key|x-api-key|cookie|set-cookie)\s*[:=]\s*([^\s,;]+)/gi;

/**
 * Redacts sensitive tokens, credentials, authorization headers, and secret query params from a string.
 * Never throws.
 * @param {unknown} input
 * @returns {string}
 */
export function redactSensitiveText(input) {
  try {
    if (input === null || input === undefined) return '';
    let text = typeof input === 'string' ? input : String(input);
    text = text.replace(URL_CREDENTIALS_RE, '$1[REDACTED]@');
    text = text.replace(SENSITIVE_QUERY_RE, '$1[REDACTED]');
    text = text.replace(BEARER_RE, '$1 [REDACTED]');
    text = text.replace(DISCORD_TOKEN_RE, '[REDACTED_TOKEN]');
    text = text.replace(HEADER_KV_RE, '$1=[REDACTED]');
    return text;
  } catch {
    return '[unserializable text]';
  }
}

/**
 * Produces a safe, single-line error summary without raw Axios/REST objects, headers, or secrets.
 * Never throws.
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizeError(err) {
  try {
    if (err === null || err === undefined) return 'Unknown error';
    if (typeof err === 'string') return redactSensitiveText(err);
    if (typeof err !== 'object') return redactSensitiveText(String(err));

    const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
    const code = err.code !== undefined && err.code !== null ? String(err.code) : null;
    const status =
      err.status ??
      err.statusCode ??
      err.response?.status ??
      null;

    const rawMessage =
      typeof err.message === 'string' && err.message
        ? err.message
        : 'Unexpected error';
    const safeMessage = redactSensitiveText(rawMessage).slice(0, 500);

    const meta = [];
    if (code) meta.push(`code=${redactSensitiveText(code)}`);
    if (status !== null && status !== undefined) meta.push(`status=${status}`);

    return meta.length > 0
      ? `[${name}] (${meta.join(', ')}) ${safeMessage}`
      : `[${name}] ${safeMessage}`;
  } catch {
    return '[Error] Unable to sanitize error';
  }
}
