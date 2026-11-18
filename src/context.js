// Context management: keeping the conversation inside the model's context window.
//
// Every model call sends the whole conversation, and every tool result makes it
// longer. Left alone, a long session eventually exceeds the model's context
// window and the provider rejects the request. We handle that in two layers,
// cheapest first:
//
//   1. PRUNE (no model call). Above PRUNE_AT of the window, the content of old
//      tool results is replaced by a short note. The model can re-run the tool
//      if it needs the output again.
//   2. COMPACT (one model call). Above COMPACT_AT of the window, everything
//      except the most recent messages is replaced by a summary that the model
//      writes. A second compaction updates the first summary instead of
//      summarising a summary.
//
// A third path lives in agentLoop.js: if the provider still says the request
// is too long, compact and retry once.
//
//   [system, user, assistant, tool, ..., assistant, tool, user, assistant]
//            └──────── summarised ────────┘ └──── kept verbatim ─────┘
//   [system, user(summary),                 assistant, tool, user, assistant]
//
// Everything except createContextManager is a pure function: a conversation
// goes in, a new conversation comes out, and the input is never changed.

const PRUNE_AT = 0.5;
const COMPACT_AT = 0.85;
const KEEP_TOOL_RESULTS = 10; // the newest tool results are never pruned
const KEEP_RECENT_TOKENS = 20_000; // roughly this much stays verbatim after compaction
const MAX_TOOL_CHARS_IN_SUMMARY = 2_000;

export const SUMMARY_PREFIX =
  'The conversation before this point was compacted into the following summary:\n\n';
export const PRUNED_NOTE =
  '[Old tool output removed to save context. Run the tool again if you need it.]';

const sum = (numbers) => numbers.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

// Rule of thumb: one token is about 4 characters of English or code, plus a
// few tokens of overhead per message. Good enough to decide *when* to act.
export const estimateMessageTokens = ({ content, tool_calls }) =>
  Math.ceil(((content?.length ?? 0) + (tool_calls ? JSON.stringify(tool_calls).length : 0)) / 4) + 4;

// The provider reports the real size. model.js stores it on each reply as
// `contextTokens`: the size of the conversation up to and including that
// reply. We trust the newest measurement and estimate only what came after it.
export const countTokens = (messages) => {
  const lastMeasured = messages.findLastIndex((m) => m.contextTokens);
  const measured = lastMeasured === -1 ? 0 : messages[lastMeasured].contextTokens;
  return measured + sum(messages.slice(lastMeasured + 1).map(estimateMessageTokens));
};

// A measurement describes the history as it was when it was taken. After we
// rewrite history it would overstate the size, so rewriting drops them all and
// the next model reply brings a fresh one.
const forgetMeasurements = (messages) => messages.map(({ contextTokens, ...message }) => message);

// ---------------------------------------------------------------------------
// Layer 1: prune old tool results
// ---------------------------------------------------------------------------

// Replaces the content of every tool result except the newest `keepRecent`.
// The message itself stays, with its tool_call_id, because the API rejects a
// tool call that has no matching result. Returns the very same array when
// there is nothing to prune, so callers can tell nothing happened.
export const pruneToolResults = (messages, keepRecent = KEEP_TOOL_RESULTS) => {
  const toolIndexes = messages.flatMap((m, i) => (m.role === 'tool' ? [i] : []));
  const old = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)));
  const prunable = (m, i) => old.has(i) && m.content.length > PRUNED_NOTE.length;

  if (!messages.some(prunable)) return messages;
  return forgetMeasurements(
    messages.map((m, i) => (prunable(m, i) ? { ...m, content: PRUNED_NOTE } : m)),
  );
};

// ---------------------------------------------------------------------------
// Layer 2: compact into a summary
// ---------------------------------------------------------------------------

const isSummary = (message) =>
  message?.role === 'user' && message.content.startsWith(SUMMARY_PREFIX);

// The system prompt (and an earlier summary) sit at the front and are handled
// separately. Returns how many messages that is.
const headLength = (messages) => {
  const system = messages[0]?.role === 'system' ? 1 : 0;
  return isSummary(messages[system]) ? system + 1 : system;
};

// Where to cut: keep roughly `keepTokens` of the newest messages verbatim.
// The kept part must not start with a tool result. Its tool call would be in
// the summarised part, and the API rejects a result without its call. Returns
// -1 if there is nothing worth summarising.
export const findCutPoint = (messages, keepTokens) => {
  const head = headLength(messages);
  const sizes = messages.map(estimateMessageTokens);
  const fromEnd = sizes.map((_, i) => sum(sizes.slice(i))); // tokens from i to the end
  const fits = fromEnd.findIndex((tokens) => tokens <= keepTokens);
  if (fits !== -1 && fits <= head) return -1; // everything already fits
  const target = fits === -1 ? messages.length - 1 : fits;

  const canCut = (i) => i > head && messages[i].role !== 'tool';
  const indexes = messages.map((_, i) => i);
  // Prefer keeping a little less than the budget; if that is impossible (the
  // tail is all tool results), keep a little more.
  return indexes.find((i) => i >= target && canCut(i))
    ?? indexes.findLast((i) => i < target && canCut(i))
    ?? -1;
};

const clip = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max)}\n...[${text.length - max} more characters]`;

// The summariser gets the old messages as plain text, not as a conversation
// to continue. Otherwise it may try to answer the user or call tools itself.
const serialize = (message) => {
  if (message.role === 'tool') {
    return `[tool result]\n${clip(message.content, MAX_TOOL_CHARS_IN_SUMMARY)}`;
  }
  const calls = (message.tool_calls ?? []).map(
    (call) => `[tool call] ${call.function.name} ${call.function.arguments}`,
  );
  return [message.content && `[${message.role}]\n${message.content}`, ...calls]
    .filter(Boolean)
    .join('\n');
};

const parseArguments = (call) => {
  try {
    return JSON.parse(call.function.arguments || '{}');
  } catch {
    return {};
  }
};

// File paths are what the model most needs after a compaction, so we list
// them from the tool calls themselves rather than trust the summary to
// remember them.
export const filesTouched = (messages) => {
  const calls = messages.flatMap((m) => m.tool_calls ?? []);
  const pathsFor = (names) => [
    ...new Set(
      calls
        .filter((call) => names.includes(call.function.name))
        .map((call) => parseArguments(call).filePath)
        .filter(Boolean),
    ),
  ];
  return { read: pathsFor(['read']), modified: pathsFor(['write', 'edit']) };
};

const SUMMARY_SYSTEM =
  'You summarise a coding session so that another assistant can continue it. ' +
  'Output only the summary, in Markdown. Do not answer the user and do not call tools.';

const SUMMARY_FORMAT = `## Goal
What the user wants, in their words where possible.

## Constraints and preferences
Anything the user asked for or ruled out.

## Progress
### Done
### In progress
### Blocked

## Key decisions
What was decided and why.

## Next steps
What should happen next, in order.

## Critical context
Exact file paths, function names, commands, error messages and values that will be needed again.

## Files
Read: ...
Modified: ...`;

export const buildSummaryPrompt = ({ previous, old, focus }) => {
  const { read, modified } = filesTouched(old);
  return [
    previous
      ? 'Update the previous summary with the newer part of the conversation below. ' +
        'Keep everything from it that is still true, add what is new, and move finished work to "Done".'
      : 'Summarise the conversation below.',
    previous && `<previous-summary>\n${previous}\n</previous-summary>`,
    `<conversation>\n${old.map(serialize).join('\n\n')}\n</conversation>`,
    `Files read in this part: ${read.join(', ') || 'none'}\n` +
      `Files modified in this part: ${modified.join(', ') || 'none'}`,
    `Use exactly this format:\n\n${SUMMARY_FORMAT}`,
    focus && `Pay special attention to: ${focus}`,
  ]
    .filter(Boolean)
    .join('\n\n');
};

// Replaces everything between the system prompt and the cut point with one
// summary message. `summarize` is a function (prompt -> summary text), so this
// stays pure apart from what that function does, and tests can pass a fake.
export const compactConversation = async (
  messages,
  { summarize, keepTokens = KEEP_RECENT_TOKENS, focus },
) => {
  const cut = findCutPoint(messages, keepTokens);
  if (cut === -1) return messages;

  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  const head = headLength(messages);
  const previous = head > system.length
    ? messages[head - 1].content.slice(SUMMARY_PREFIX.length)
    : null;

  const summary = await summarize(
    buildSummaryPrompt({ previous, old: messages.slice(head, cut), focus }),
  );
  return forgetMeasurements([
    ...system,
    { role: 'user', content: SUMMARY_PREFIX + summary },
    ...messages.slice(cut),
  ]);
};

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

// Providers word this error differently; these cover the common ones.
const OVERFLOW_PATTERN =
  /context[ _]length|context window|maximum context|too many tokens|prompt is too long|reduce the length/i;
export const isContextOverflow = (error) => OVERFLOW_PATTERN.test(error?.message ?? '');

// Returns `fitContext(conversation, options)`. The agent loop calls it before
// every model call. With `force: true` it compacts regardless of size (used by
// /compact and by overflow recovery).
export const createContextManager = ({
  callModel,
  contextWindow,
  pruneAt = PRUNE_AT,
  compactAt = COMPACT_AT,
  keepToolResults = KEEP_TOOL_RESULTS,
  // On a small window, keeping 20k tokens verbatim would leave no room to work.
  keepTokens = Math.min(KEEP_RECENT_TOKENS, Math.floor(contextWindow / 4)),
}) => {
  // The summary is written by the same model, with no tools on offer.
  const summarize = async (prompt) => {
    const reply = await callModel([
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: prompt },
    ]);
    if (!reply.content?.trim()) throw new Error('Compaction failed: the model returned no summary.');
    return reply.content.trim();
  };

  const compact = async (conversation, { focus, onEvent }) => {
    const compacted = await compactConversation(conversation, { summarize, keepTokens, focus });
    if (compacted !== conversation) {
      onEvent({ type: 'context_compacted', before: countTokens(conversation), after: countTokens(compacted) });
    }
    return compacted;
  };

  return async (conversation, { force = false, focus, onEvent = () => {} } = {}) => {
    if (force) return compact(conversation, { focus, onEvent });

    const pruned = countTokens(conversation) > pruneAt * contextWindow
      ? pruneToolResults(conversation, keepToolResults)
      : conversation;
    if (pruned !== conversation) {
      onEvent({ type: 'context_pruned', before: countTokens(conversation), after: countTokens(pruned) });
    }

    return countTokens(pruned) > compactAt * contextWindow
      ? compact(pruned, { focus, onEvent })
      : pruned;
  };
};
