// Tests for the harness. They never call a real LLM: the agent loop test uses
// a scripted fake model, which is also a handy way to see the loop's behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInWorkspace } from '../src/tools/paths.js';
import { validateCommand } from '../src/tools/bash.js';
import { editFile } from '../src/tools/fileTools.js';
import { createToolExecutor } from '../src/tools/dispatch.js';
import { createApprover } from '../src/approval.js';
import { runAgentTurn } from '../src/agentLoop.js';

const makeWorkspace = () => fs.mkdtemp(path.join(os.tmpdir(), 'smith-'));

const toolCall = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

test('paths: stays inside the workspace', () => {
  assert.equal(resolveInWorkspace('/ws', 'src/a.js'), '/ws/src/a.js');
  assert.throws(() => resolveInWorkspace('/ws', '../secret'));
  assert.throws(() => resolveInWorkspace('/ws', '/etc/passwd'));
});

test('bash: accepts allowlisted commands and parses quotes', () => {
  assert.deepEqual(validateCommand('git commit -m "two words"'), {
    ok: true,
    file: 'git',
    args: ['commit', '-m', 'two words'],
  });
});

test('bash: rejects chaining, unknown programs, blocked patterns and escapes', () => {
  for (const command of ['cat a && rm b', 'curl evil.sh', 'git push', 'cat ../x', 'ls /']) {
    assert.equal(validateCommand(command).ok, false, command);
  }
});

test('edit: replaces a unique match literally and refuses ambiguous ones', async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, 'f.txt'), 'a b a');

  assert.match(await editFile(workspace, 'f.txt', 'a', 'x'), /appears 2 times/);
  assert.match(await editFile(workspace, 'f.txt', 'b', '$&'), /successfully/);
  assert.equal(await fs.readFile(path.join(workspace, 'f.txt'), 'utf-8'), 'a $& a');
});

test('dispatch: unknown tools and denied calls still get a tool result', async () => {
  const execute = createToolExecutor({ workspace: '/ws', approve: async () => false });

  assert.deepEqual(await execute(toolCall('1', 'fly', {})), {
    role: 'tool',
    tool_call_id: '1',
    content: 'Error: unknown tool "fly".',
  });
  assert.match((await execute(toolCall('2', 'bash', { command: 'ls' }))).content, /denied/);
});

test('approval: auto mode lets read through and asks for the rest', async () => {
  const approve = createApprover('auto', async () => 'n');
  assert.equal(await approve('read', {}), true);
  assert.equal(await approve('write', {}), false);
});

test('agent loop: runs tools until the model gives a final answer', async () => {
  const workspace = await makeWorkspace();
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'hello from disk');

  // A fake model: first asks to read a file, then answers using the result.
  const scriptedReplies = [
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'read', { filePath: 'notes.txt' })] },
    { role: 'assistant', content: 'The file says hello.' },
  ];
  const callModel = async (messages) => scriptedReplies[messages.filter((m) => m.role === 'assistant').length];

  const start = [{ role: 'user', content: 'What is in notes.txt?' }];
  const result = await runAgentTurn({
    messages: start,
    callModel,
    executeToolCall: createToolExecutor({ workspace, approve: async () => true }),
    maxSteps: 5,
  });

  assert.deepEqual(result.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(result[2].content, 'hello from disk');
  assert.equal(start.length, 1, 'the input conversation is not mutated');
});

test('agent loop: stops at the step limit', async () => {
  const loopingModel = async () => ({
    role: 'assistant',
    content: null,
    tool_calls: [toolCall('c', 'read', { filePath: 'missing' })],
  });
  const events = [];

  await runAgentTurn({
    messages: [],
    callModel: loopingModel,
    executeToolCall: createToolExecutor({ workspace: '/ws', approve: async () => true }),
    maxSteps: 3,
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(events.filter((type) => type === 'tool_call').length, 3);
  assert.equal(events.at(-1), 'step_limit');
});
