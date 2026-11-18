// The model client: the only place that talks to the LLM.
//
// It speaks the OpenAI-compatible "chat completions" protocol, which many
// providers (and local servers like Ollama) implement. We use plain fetch
// instead of an SDK so you can see exactly what goes over the wire:
//
//   request:  { model, messages: [...], tools: [...] }
//   response: { choices: [{ message: { role, content, tool_calls } }] }
//
// The LLM is stateless. It knows nothing about earlier turns except what we
// send in `messages` on every single call.

export const createModelClient = ({ apiKey, baseURL, model }) =>
  async (messages, tools) => {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: messages.map(toWireMessage),
        // Some providers reject an empty tools list (the summariser sends none).
        ...(tools?.length ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Model API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return toAssistantMessage(data.choices[0].message, data.usage);
  };

// How big the conversation is once this reply is part of it: the prompt we
// sent plus the reply. Reasoning tokens count as output but are never sent
// back, so they are left out. context.js uses this to decide when to act.
const contextTokensFrom = (usage) =>
  usage?.prompt_tokens
    ? usage.prompt_tokens + (usage.completion_tokens ?? 0)
      - (usage.completion_tokens_details?.reasoning_tokens ?? 0)
    : undefined;

// Keep only the fields we need to send back in later requests.
// Providers sometimes add extra fields that other providers reject.
export const toAssistantMessage = ({ content, tool_calls }, usage) => {
  const contextTokens = contextTokensFrom(usage);
  return {
    role: 'assistant',
    content: content ?? null,
    ...(tool_calls?.length ? { tool_calls } : {}),
    ...(contextTokens ? { contextTokens } : {}),
  };
};

// Our messages carry bookkeeping the API does not know about (contextTokens).
// Only the protocol's own fields go over the wire.
export const toWireMessage = ({ role, content, tool_calls, tool_call_id }) => ({
  role,
  content,
  ...(tool_calls ? { tool_calls } : {}),
  ...(tool_call_id ? { tool_call_id } : {}),
});
