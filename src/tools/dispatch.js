// Tool dispatch: turns a tool call requested by the model into a real action.
//
// The rule is: the model requests, the harness decides. For every tool call
// we check, in order:
//   1. Does the tool exist?
//   2. Are the arguments valid JSON?
//   3. Does the user (or the approval policy) allow it?
//   4. Run it. Turn any crash into a message instead of bringing the harness down.
//
// Whatever happens, we answer with exactly one "tool" message tagged with the
// call's id. The API requires every tool call to get a matching result.

import { readFile, writeFile, editFile } from './fileTools.js';
import { runBash } from './bash.js';

// Tool name -> handler. Adding a tool means: write the function, register it
// here, and describe it in schemas.js.
const toolHandlers = new Map([
  ['read', (workspace, { filePath }) => readFile(workspace, filePath)],
  ['write', (workspace, { filePath, content }) => writeFile(workspace, filePath, content)],
  ['edit', (workspace, { filePath, oldContent, newContent }) =>
    editFile(workspace, filePath, oldContent, newContent)],
  ['bash', (workspace, { command }) => runBash(workspace, command)],
]);

// Huge outputs would fill up the model's context window, so we cut them short.
const MAX_RESULT_LENGTH = 20_000;

const truncate = (text) =>
  text.length <= MAX_RESULT_LENGTH
    ? text
    : `${text.slice(0, MAX_RESULT_LENGTH)}\n...[truncated ${text.length - MAX_RESULT_LENGTH} characters]`;

const parseArguments = (raw) => {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return null;
  }
};

export const createToolExecutor = ({ workspace, approve }) => async (toolCall) => {
  const { id, function: { name, arguments: rawArgs } } = toolCall;
  const reply = (content) => ({ role: 'tool', tool_call_id: id, content: truncate(String(content)) });

  const handler = toolHandlers.get(name);
  if (!handler) return reply(`Error: unknown tool "${name}".`);

  const args = parseArguments(rawArgs);
  if (args === null) return reply('Error: tool arguments were not valid JSON.');

  if (!(await approve(name, args))) return reply('The user denied this tool call.');

  try {
    return reply(await handler(workspace, args));
  } catch (error) {
    return reply(`Error: ${error.message}`);
  }
};
