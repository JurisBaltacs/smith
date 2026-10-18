#!/usr/bin/env node
// Entry point: wires the components together and runs the chat REPL.
//
// This file is the "composition root". It is the only place that knows about
// the terminal, environment variables and the network. Every other module
// gets what it needs as arguments, which keeps them easy to test.
//
//   user input ─▶ runAgentTurn (loop) ─▶ callModel / executeToolCall ─▶ output

import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from './config.js';
import { createModelClient } from './model.js';
import { createApprover } from './approval.js';
import { createToolExecutor } from './tools/dispatch.js';
import { runAgentTurn } from './agentLoop.js';

const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const preview = (text, lines = 8) => {
  const all = text.split('\n');
  return all.length > lines ? `${all.slice(0, lines).join('\n')}\n...` : text;
};

// Turns loop events into terminal output. The loop itself never prints.
const renderers = {
  assistant: ({ content }) => console.log(`\n${content}`),
  tool_call: ({ toolCall: { function: fn } }) => console.log(`\n→ ${fn.name} ${fn.arguments}`),
  tool_result: ({ result }) => console.log(dim(preview(result.content))),
  step_limit: () => console.log('\n[stopped: step limit reached]'),
};
const render = (event) => renderers[event.type]?.(event);

// Both the chat prompt and the approval prompt read from one shared line
// iterator, so lines are never lost (this also makes piped input work).
// Returns null once input has ended (Ctrl+D, Ctrl+C or end of a pipe).
const createLineReader = (rl) => {
  const lines = rl[Symbol.asyncIterator]();
  return async (prompt) => {
    stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value;
  };
};

const main = async () => {
  const config = loadConfig();
  if (!config.apiKey) {
    console.error('Missing API_KEY. Copy .env.example to .env or export API_KEY.');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => rl.close());
  const ask = createLineReader(rl);

  const systemPrompt = await fs.readFile(new URL('./SYSTEM.md', import.meta.url), 'utf-8');
  const initialMessages = [{ role: 'system', content: systemPrompt }];

  const turnDependencies = {
    callModel: createModelClient(config),
    executeToolCall: createToolExecutor({
      workspace: config.workspace,
      approve: createApprover(config.approvalMode, ask),
    }),
    maxSteps: config.maxSteps,
    onEvent: render,
  };

  // The conversation is a value passed from turn to turn, never a global that
  // gets mutated. Each turn returns the new conversation.
  const converse = async (messages) => {
    const line = await ask('\n> ');
    if (line === null || line.trim() === '/exit') return rl.close();

    const input = line.trim();
    if (input === '/clear') {
      console.log('[conversation cleared]');
      return converse(initialMessages);
    }
    if (!input) return converse(messages);

    try {
      const userMessage = { role: 'user', content: input };
      return converse(
        await runAgentTurn({ ...turnDependencies, messages: [...messages, userMessage] }),
      );
    } catch (error) {
      // Because nothing was mutated, a failed turn simply leaves the previous
      // conversation as it was.
      console.error(`\n[error] ${error.message}`);
      return converse(messages);
    }
  };

  console.log(`smith: model ${config.model}, workspace ${config.workspace}, approval ${config.approvalMode}`);
  console.log('Type a task. /clear resets the conversation, /exit quits.');
  return converse(initialMessages);
};

main();
