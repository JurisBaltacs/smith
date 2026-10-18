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
      body: JSON.stringify({ model, messages, tools }),
    });

    if (!response.ok) {
      throw new Error(`Model API error ${response.status}: ${await response.text()}`);
    }

    const data = await response.json();
    return toAssistantMessage(data.choices[0].message);
  };

// Keep only the fields we need to send back in later requests.
// Providers sometimes add extra fields that other providers reject.
export const toAssistantMessage = ({ content, tool_calls }) => ({
  role: 'assistant',
  content: content ?? null,
  ...(tool_calls?.length ? { tool_calls } : {}),
});
