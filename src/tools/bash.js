// The bash tool: the most powerful and the most dangerous tool.
//
// Defence in layers:
//   1. Reject shell metacharacters, so commands cannot be chained, piped,
//      redirected or substituted ("cat a && rm -rf .").
//   2. Reject known-destructive patterns.
//   3. Allow only programs on an allowlist.
//   4. Reject absolute paths and "..", so arguments stay inside the workspace.
//   5. Run the program directly with execFile and `shell: false`. No shell
//      ever interprets the string.
//
// This is NOT a sandbox. `node` or `npm` can still run arbitrary code, which
// is why bash always needs the user's approval in the default "auto" mode.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ALLOWED_COMMANDS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'find', 'grep',
  'wc', 'git', 'npm', 'node', 'true', 'false', 'seq',
]);

const BLOCKED_PATTERNS = [
  'rm -rf', 'mkfs', 'dd if=', 'shutdown', 'reboot', 'sudo',
  'git push', 'git reset --hard', 'git clean', 'npm publish', 'find -delete', '-exec',
];

const SHELL_METACHARS = /[;&|`$<>\n\r]/;

// Split a command line into words, honouring simple "double" and 'single' quotes.
const tokenize = (command) =>
  [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    ([, doubleQuoted, singleQuoted, bare]) => doubleQuoted ?? singleQuoted ?? bare,
  );

const escapesWorkspace = (arg) =>
  arg.startsWith('/') || arg.startsWith('~') || arg.split(/[\\/]/).includes('..');

// Pure validation: returns { ok: true, file, args } or { ok: false, reason }.
export const validateCommand = (command) => {
  if (SHELL_METACHARS.test(command)) {
    return { ok: false, reason: 'shell operators (; & | ` $ < > newline) are not allowed' };
  }

  const blocked = BLOCKED_PATTERNS.find((pattern) => command.includes(pattern));
  if (blocked) return { ok: false, reason: `"${blocked}" is blocked` };

  const [file, ...args] = tokenize(command);
  if (!file) return { ok: false, reason: 'empty command' };
  if (!ALLOWED_COMMANDS.has(file)) {
    return { ok: false, reason: `"${file}" is not on the allowlist: ${[...ALLOWED_COMMANDS].join(', ')}` };
  }

  const badArg = args.find(escapesWorkspace);
  if (badArg) return { ok: false, reason: `argument "${badArg}" points outside the workspace` };

  return { ok: true, file, args };
};

const formatOutput = (exitCode, stdout, stderr) =>
  [`exit code: ${exitCode}`, stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
    .filter(Boolean)
    .join('\n');

export const runBash = async (workspace, command) => {
  const validation = validateCommand(command);
  if (!validation.ok) return `Error: command rejected: ${validation.reason}`;

  try {
    const { stdout, stderr } = await execFileAsync(validation.file, validation.args, {
      cwd: workspace,
      shell: false,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return formatOutput(0, stdout, stderr);
  } catch (error) {
    // A failing command (e.g. failing tests) is useful information for the
    // model, not a harness error, so we report it instead of throwing.
    return formatOutput(error.code ?? 1, error.stdout ?? '', error.stderr || error.message);
  }
};
