// File tools: read, write and edit files inside the workspace.
//
// Each tool returns a string, because a string is what gets sent back to the
// model as the tool result. Expected failures (text not found, and so on)
// come back as "Error: ..." strings so the model can read them and try again.
// Unexpected failures (missing file, bad path) throw, and the dispatcher turns
// them into the same kind of message.

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveInWorkspace } from './paths.js';

export const readFile = (workspace, filePath) =>
  fs.readFile(resolveInWorkspace(workspace, filePath), 'utf-8');

export const writeFile = async (workspace, filePath, content) => {
  const target = resolveInWorkspace(workspace, filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
  return `Wrote ${content.length} characters to ${filePath}.`;
};

const countOccurrences = (text, search) => text.split(search).length - 1;

// Editing by exact replacement is safer than rewriting whole files. The model
// has to quote the text it wants to change, which shows it has read the file,
// and a small edit cannot accidentally wipe out the rest of the file.
export const editFile = async (workspace, filePath, oldContent, newContent) => {
  if (oldContent === '') return 'Error: oldContent must not be empty. No changes made.';

  const target = resolveInWorkspace(workspace, filePath);
  const original = await fs.readFile(target, 'utf-8');
  const matches = countOccurrences(original, oldContent);

  if (matches === 0) return 'Error: oldContent not found. No changes made.';
  if (matches > 1) {
    return `Error: oldContent appears ${matches} times. Include more surrounding text so it is unique. No changes made.`;
  }

  // The replacer is a function so that "$&" or "$1" in newContent are written
  // literally instead of being treated as String.replace patterns.
  await fs.writeFile(target, original.replace(oldContent, () => newContent), 'utf-8');
  return 'File edited successfully.';
};
