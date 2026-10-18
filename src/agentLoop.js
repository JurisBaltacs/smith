// The agent loop: the heart of the harness.
//
// One user message can trigger many model calls:
//
//   messages ──▶ model ──▶ tool calls? ──yes──▶ run tools ──▶ append results ──┐
//                  ▲                                                          │
//                  └──────────────────────────────────────────────────────────┘
//                         no ──▶ done, the model has given its final answer
//
// Think → Act → Observe, repeated until the model stops asking for tools.
//
// The loop never mutates the conversation. Each step builds a new array, and
// the finished conversation is returned to the caller.

import { toolSchemas } from './tools/schemas.js';

// Run async work one item at a time, in order. Tool calls must run
// sequentially because each one may stop to ask the user for approval.
const mapSequential = (items, fn) =>
  items.reduce(
    async (done, item) => [...(await done), await fn(item)],
    Promise.resolve([]),
  );

export const runAgentTurn = async ({
  messages,
  callModel,
  executeToolCall,
  maxSteps,
  onEvent = () => {},
}) => {
  const step = async (conversation, stepsLeft) => {
    // Safety valve: a confused model could otherwise loop forever (and burn money).
    if (stepsLeft === 0) {
      onEvent({ type: 'step_limit' });
      return conversation;
    }

    // THINK: send the whole history plus the tool menu to the model.
    const reply = await callModel(conversation, toolSchemas);
    const withReply = [...conversation, reply];

    if (reply.content) onEvent({ type: 'assistant', content: reply.content });

    // No tool calls means the model has finished; this is the final answer.
    if (!reply.tool_calls) return withReply;

    // ACT: run every tool the model asked for.
    const toolResults = await mapSequential(reply.tool_calls, async (toolCall) => {
      onEvent({ type: 'tool_call', toolCall });
      const result = await executeToolCall(toolCall);
      onEvent({ type: 'tool_result', result });
      return result;
    });

    // OBSERVE: put the results into the history and let the model look at them.
    return step([...withReply, ...toolResults], stepsLeft - 1);
  };

  return step(messages, maxSteps);
};
