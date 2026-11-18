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
import { createContextManager } from './context.js';

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
  context_pruned: ({ before, after }) =>
    console.log(dim(`[context: old tool output pruned, ~${before} → ~${after} tokens]`)),
  context_compacted: ({ before, after }) =>
    console.log(dim(`[context: history compacted into a summary, ~${before} → ~${after} tokens]`)),
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
  // The config holds its own copy of the key. Removing it from the environment
  // keeps it out of every program the bash tool starts.
  delete process.env.API_KEY;
  delete process.env.OPENAI_API_KEY;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on('SIGINT', () => rl.close());
  const ask = createLineReader(rl);

  const systemPrompt = await fs.readFile(new URL('./SYSTEM.md', import.meta.url), 'utf-8');
  const initialMessages = [{ role: 'system', content: systemPrompt }];

  const callModel = createModelClient(config);
  const fitContext = createContextManager({ callModel, contextWindow: config.contextWindow });

  const turnDependencies = {
    callModel,
    fitContext,
    executeToolCall: createToolExecutor({
      workspace: config.workspace,
      approve: createApprover(config.approvalMode, ask),
    }),
    maxSteps: config.maxSteps,
    onEvent: render,
  };

  // `/compact [focus]` summarises now; anything else is a message for the agent.
  const handleInput = async (input, messages) => {
    if (input !== '/compact' && !input.startsWith('/compact ')) {
      return runAgentTurn({ ...turnDependencies, messages: [...messages, { role: 'user', content: input }] });
    }
    const focus = input.slice('/compact'.length).trim() || undefined;
    const compacted = await fitContext(messages, { force: true, focus, onEvent: render });
    if (compacted === messages) console.log('[nothing to compact yet]');
    return compacted;
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
      return converse(await handleInput(input, messages));
    } catch (error) {
      // Because nothing was mutated, a failed turn simply leaves the previous
      // conversation as it was.
      console.error(`\n[error] ${error.message}`);
      return converse(messages);
    }
  };

  console.log(`smith: model ${config.model}, workspace ${config.workspace}, approval ${config.approvalMode}`);
  console.log('Type a task. /compact summarises the history, /clear resets it, /exit quits.');
  return converse(initialMessages);
};

main();
