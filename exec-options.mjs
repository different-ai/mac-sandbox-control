export const EXEC_USAGE = 'Usage: sandbox exec NAME [--timeout SECONDS] [--json] -- COMMAND [ARGS...]\nUse one quoted string for shell expressions, e.g. -- "cd /tmp && pwd". Timeout: 1–600 seconds (default 120).';
export class ExecUsageError extends Error {}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

export function parseExecArgs(args) {
  const [name, ...rest] = args;
  if (!/^space-[a-z0-9][a-z0-9-]{0,30}$/.test(name || '')) throw new ExecUsageError(EXEC_USAGE);
  const boundary = rest.indexOf('--');
  if (boundary < 0 || boundary === rest.length - 1) throw new ExecUsageError(EXEC_USAGE);
  let timeoutSeconds = 120, json = false, timeoutSet = false;
  for (let i = 0; i < boundary; i++) {
    if (rest[i] === '--json' && !json) json = true;
    else if (rest[i] === '--timeout' && !timeoutSet && i + 1 < boundary && /^\d+$/.test(rest[i + 1])) {
      timeoutSeconds = Number(rest[++i]); timeoutSet = true;
      if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new ExecUsageError(EXEC_USAGE);
    } else throw new ExecUsageError(EXEC_USAGE);
  }
  const words = rest.slice(boundary + 1);
  // A single argument is a shell command; multiple argv items are quoted so
  // characters such as $, ; and spaces remain literal inside individual args.
  const command = words.length === 1 ? words[0] : words.map(quote).join(' ');
  if (!command || command.length > 16384 || command.includes('\0')) throw new ExecUsageError(EXEC_USAGE);
  return {name, command, timeoutSeconds, json};
}

export function renderExecResult(result, {json = false, print = console.log, stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text)} = {}) {
  if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || typeof result.timedOut !== 'boolean'
      || !(result.exitCode === null || (Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255))) throw new Error('Invalid exec response.');
  if (json) print(JSON.stringify(result, null, 2));
  else {
    stdout(result.stdout); stderr(result.stderr);
    if (result.timedOut) stderr('Command timed out. Its remote process may still be running; inspect it before retrying.\n');
  }
  return result.timedOut ? 124 : result.exitCode ?? 1;
}
