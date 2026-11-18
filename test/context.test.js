// Tests for context management. Like the loop tests, they never call a real
// LLM: summaries come from a fake `summarize` / `callModel`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countTokens,
  estimateMessageTokens,
  pruneToolResults,
  findCutPoint,
  compactConversation,
  createContextManager,
  isContextOverflow,
  SUMMARY_PREFIX,
  PRUNED_NOTE,
} from '../src/context.js';
import { runAgentTurn } from '../src/agentLoop.js';
import { toAssistantMessage, toWireMessage } from '../src/model.js';

const big = (n) => 'x'.repeat(n);
const call = (id, name, args = {}) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

// system, then `rounds` of: user asks, assistant reads a file, tool answers, assistant replies.
const longConversation = (rounds, resultSize = 4_000) => [
  { role: 'system', content: 'rules' },
  ...Array.from({ length: rounds }, (_, i) => [
    { role: 'user', content: `task ${i}` },
    { role: 'assistant', content: null, tool_calls: [call(`c${i}`, 'read', { filePath: `f${i}.js` })] },
    { role: 'tool', tool_call_id: `c${i}`, content: big(resultSize) },
    { role: 'assistant', content: `done ${i}` },
  ]).flat(),
];

test('count: trusts the newest measurement and estimates what came after it', () => {
  const after = { role: 'tool', tool_call_id: 'c', content: big(400) };
  const messages = [
    { role: 'user', content: big(4_000) },
    { role: 'assistant', content: 'hi', contextTokens: 1_500 },
    after,
  ];
  assert.equal(countTokens(messages), 1_500 + estimateMessageTokens(after));
  assert.equal(countTokens([after]), estimateMessageTokens(after), 'no measurement: estimate all');
});

test('prune: blanks old tool results, keeps their ids and the newest ones', () => {
  const messages = longConversation(4);
  const pruned = pruneToolResults(messages, 2);
  const tools = pruned.filter((m) => m.role === 'tool');

  assert.deepEqual(tools.map((m) => m.content === PRUNED_NOTE), [true, true, false, false]);
  assert.deepEqual(tools.map((m) => m.tool_call_id), ['c0', 'c1', 'c2', 'c3']);
  assert.equal(messages[3].content.length, 4_000, 'the input is not mutated');
  assert.equal(pruneToolResults(pruned, 2), pruned, 'nothing left to prune: same array back');
});

test('cut point: never makes the kept part start with a tool result', () => {
  const messages = longConversation(6);
  for (const keep of [0, 500, 1_500, 3_000, 6_000]) {
    const cut = findCutPoint(messages, keep);
    assert.ok(cut > 1, `keep ${keep}`);
    assert.notEqual(messages[cut].role, 'tool', `keep ${keep}`);
  }
  assert.equal(findCutPoint(longConversation(1), 100_000), -1, 'everything fits: no cut');
});

test('compact: system prompt, then a summary, then the recent messages', async () => {
  const messages = longConversation(6);
  const prompts = [];
  const summarize = async (prompt) => {
    prompts.push(prompt);
    return `summary ${prompts.length}`;
  };

  const once = await compactConversation(messages, { summarize, keepTokens: 2_000 });
  assert.deepEqual(once[0], messages[0]);
  assert.equal(once[1].content, `${SUMMARY_PREFIX}summary 1`);
  assert.deepEqual(once.slice(2), messages.slice(messages.length - (once.length - 2)));
  assert.match(prompts[0], /Files read in this part: f0\.js/);

  // A second compaction updates the first summary instead of summarising it.
  const twice = await compactConversation([...once, ...longConversation(3).slice(1)], {
    summarize,
    keepTokens: 2_000,
  });
  assert.match(prompts[1], /<previous-summary>\nsummary 1\n<\/previous-summary>/);
  assert.equal(twice.filter((m) => m.content?.startsWith(SUMMARY_PREFIX)).length, 1);
});

test('manager: does nothing when small, prunes at 50%, compacts at 85%', async () => {
  const summarizer = async () => ({ role: 'assistant', content: 'the summary' });
  const fit = createContextManager({ callModel: summarizer, contextWindow: 20_000 });
  const events = [];
  const onEvent = (event) => events.push(event.type);

  const small = longConversation(2);
  assert.equal(await fit(small, { onEvent }), small);

  // ~12k tokens of a 20k window: above 50%, and pruning brings it under 85%.
  const medium = longConversation(12, 4_000);
  const pruned = await fit(medium, { onEvent });
  assert.ok(pruned.some((m) => m.content === PRUNED_NOTE));
  assert.deepEqual(events, ['context_pruned']);

  // Recent tool results are kept, so this is still above 85% after pruning.
  const huge = longConversation(12, 12_000);
  const compacted = await fit(huge, { onEvent });
  assert.equal(compacted[1].content, `${SUMMARY_PREFIX}the summary`);
  assert.deepEqual(events.slice(1), ['context_pruned', 'context_compacted']);
});

test('agent loop: compacts and retries once when the provider reports overflow', async () => {
  const sentSizes = [];
  const callModel = async (messages) => {
    sentSizes.push(messages.length);
    if (sentSizes.length === 1) throw new Error('Model API error 400: maximum context length exceeded');
    return { role: 'assistant', content: 'answer' };
  };
  const fitContext = async (conversation, { force } = {}) =>
    force ? [conversation[0], { role: 'user', content: `${SUMMARY_PREFIX}s` }, conversation.at(-1)] : conversation;

  const start = longConversation(3);
  const result = await runAgentTurn({
    messages: [...start, { role: 'user', content: 'next' }],
    callModel,
    executeToolCall: async () => assert.fail('no tools expected'),
    fitContext,
    maxSteps: 5,
  });

  assert.deepEqual(sentSizes, [start.length + 1, 3]);
  assert.deepEqual(result.map((m) => m.role), ['system', 'user', 'user', 'assistant']);
});

test('agent loop: other errors are not treated as overflow', async () => {
  assert.equal(isContextOverflow(new Error('Model API error 401: bad key')), false);
  await assert.rejects(
    runAgentTurn({
      messages: [],
      callModel: async () => { throw new Error('Model API error 401: bad key'); },
      executeToolCall: async () => {},
      fitContext: async (conversation, { force }) =>
        force ? assert.fail('must not compact') : conversation,
      maxSteps: 1,
    }),
    /401/,
  );
});

test('model: records context size, and never sends it back to the API', () => {
  const reply = toAssistantMessage(
    { content: 'hi' },
    { prompt_tokens: 900, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 200 } },
  );
  assert.equal(reply.contextTokens, 1_000, 'reasoning tokens are not part of the history');
  assert.deepEqual(toWireMessage(reply), { role: 'assistant', content: 'hi' });
});
