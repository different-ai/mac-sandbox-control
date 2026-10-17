import {stripVTControlCharacters} from 'node:util';

// Lume's timestamped, non-error logger records can share stdout with JSON.
// Match whole physical lines, not severity words or the first '[' (timestamps
// also start with '['). Unknown output and ERROR records must still fail closed.
const logLine = /^[\t ]*\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\] (?:INFO|DEBUG|WARN):[^\r\n]*$/;

export function parseLumeJSON(stdout) {
  try {
    if (typeof stdout !== 'string') throw new TypeError();
    let inString = false, escaped = false;
    const lines = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!inString && logLine.test(stripVTControlCharacters(line))) continue;
      // Strip terminal decoration only outside JSON strings. In particular,
      // escaped newlines, quotes, ANSI escapes and log-like field values remain
      // untouched, and illegal raw control characters in strings stay invalid.
      let cleaned = '', outside = '';
      for (const char of line) {
        if (inString) {
          cleaned += char;
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
        } else if (char === '"') {
          cleaned += stripVTControlCharacters(outside) + char;
          outside = ''; inString = true;
        } else outside += char;
      }
      lines.push(cleaned + stripVTControlCharacters(outside));
    }
    return JSON.parse(lines.join('\n'));
  } catch {
    // Do not attach the native parse error/cause: it may quote credentials,
    // private paths, VNC URLs or any other content from Lume's stdout.
    throw new SyntaxError('Lume JSON output is invalid.');
  }
}
