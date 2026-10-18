# smith: a minimal agent harness

`smith` is a small terminal coding agent. It is meant to be read, not just
used. It follows the design in Udit Rajput's article
[*Building an Agent Harness from Scratch: The Loop and the Tools*](https://medium.com/@uditrajput03/building-an-agent-harness-from-scratch-the-loop-and-the-tools-4e3aedb9e5e0),
written in JavaScript in a functional style: no classes, no mutable shared
state and no dependencies.

The whole harness is about 500 lines, roughly half of them comments. You can
read it in one sitting.

---

## The one idea to take away

An LLM on its own can only **produce text**. It cannot read your files or run
your tests. An **agent harness** is the program around the model that:

1. keeps the conversation (the model itself is stateless),
2. tells the model which tools exist,
3. runs the tools the model asks for, *after checking it is safe to*,
4. gives the results back to the model,
5. repeats until the model says it is done.

```
User asks → Model decides → Harness validates → Tool executes → Result returns → Model continues
```

The model never touches your computer. It only *asks*, by producing a piece
of JSON. **The model requests; the harness decides.**

---

## Running it

Requires Node.js 22 or newer. There is nothing to install.

```bash
cp .env.example .env        # then put your API key in it
npm start                   # runs the agent in this directory
```

The agent works on the directory it is **started from** (the *workspace*). To
point it at another project:

```bash
cd ~/some/project
node --env-file=/path/to/smith/.env /path/to/smith/src/index.js
```

Any provider with an OpenAI-compatible `/chat/completions` endpoint works
(OpenAI, OpenRouter, a local Ollama at `http://localhost:11434/v1`, ...). Set
`BASE_URL` and `MODEL` to choose one. The model needs to support tool calling.

| Variable        | Default                     | Meaning                                    |
| --------------- | --------------------------- | ------------------------------------------ |
| `API_KEY`       | none (required)             | Bearer token for the provider              |
| `BASE_URL`      | `https://api.openai.com/v1` | Provider endpoint                          |
| `MODEL`         | `gpt-5.4-mini`              | Model name                                 |
| `APPROVAL_MODE` | `auto`                      | `auto`, `allow` or `block` (see Approval)  |
| `MAX_STEPS`     | `25`                        | Max model calls per user message           |

In the chat, `/clear` resets the conversation and `/exit` quits.

`npm test` runs the tests. They use a fake, scripted model, so they need no
API key, and `test/harness.test.js` is a good place to watch the loop work.

---

## Project layout

```
src/
├── index.js          Entry point: reads config, wires everything up, runs the chat REPL
├── config.js         Reads environment variables into a frozen config object
├── SYSTEM.md         The system prompt: the agent's "operating manual"
├── model.js          The only code that talks to the LLM (one HTTP call)
├── agentLoop.js      THE LOOP: call model → run tools → repeat
├── approval.js       Asks the human before risky tool calls
└── tools/
    ├── schemas.js    JSON descriptions of the tools, sent to the model
    ├── dispatch.js   Turns a tool call into a real function call, safely
    ├── fileTools.js  read / write / edit
    ├── bash.js       Restricted command execution
    └── paths.js      Keeps file access inside the workspace
test/
└── harness.test.js
```

How the parts depend on each other:

```
                 index.js  (composition root: the only file with I/O wiring)
                    │
       ┌────────────┼──────────────┬───────────────┐
       ▼            ▼              ▼               ▼
   config.js    model.js      agentLoop.js     approval.js
                    ▲              │
                    │ callModel    │ executeToolCall
                    │              ▼
                    │        tools/dispatch.js ──▶ fileTools.js ──▶ paths.js
                    │              │
                    └── schemas ◀──┘──────────────▶ bash.js
```

`agentLoop.js` does not import the model client or the tools. It is
*given* `callModel` and `executeToolCall` as arguments. That is why the tests
can hand it a fake model. It is also what makes the model pluggable.

---

## Part 1: The loop (`agentLoop.js`)

The conversation is just an array of messages:

```js
[
  { role: 'system',    content: '...rules from SYSTEM.md...' },
  { role: 'user',      content: 'What is in notes.txt?' },
  { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function',
        function: { name: 'read', arguments: '{"filePath":"notes.txt"}' } } ] },
  { role: 'tool',      tool_call_id: 'c1', content: 'hello from disk' },
  { role: 'assistant', content: 'The file says hello.' },
]
```

Every model call sends **the whole array**. That is the agent's memory: the
model remembers nothing between calls, and the harness supplies continuity by
replaying history.

One user message can lead to several model calls:

```
                ┌──────────────────────────────────────────────┐
                ▼                                              │
  messages ──▶ callModel ──▶ reply has tool_calls? ──yes──▶ run each tool,
                                    │                      append results
                                    no
                                    ▼
                         final answer, wait for user
```

In code (simplified from `runAgentTurn`):

```js
const step = async (conversation, stepsLeft) => {
  if (stepsLeft === 0) return conversation;                    // safety valve
  const reply = await callModel(conversation, toolSchemas);    // THINK
  const withReply = [...conversation, reply];
  if (!reply.tool_calls) return withReply;                     // done
  const results = await mapSequential(reply.tool_calls, executeToolCall); // ACT
  return step([...withReply, ...results], stepsLeft - 1);      // OBSERVE, repeat
};
```

Details worth noticing:

- **Two nested loops.** The outer one (`converse` in `index.js`) waits for
  user input. The inner one (`step`) keeps calling the model until it stops
  asking for tools. The article's simplified pseudocode merges them; the real
  thing needs both.
- **Step limit.** Without `MAX_STEPS`, a confused model could call tools
  forever.
- **Tools run one at a time**, because each one may stop to ask you for
  approval.
- **No mutation.** Each step builds a new array. If a turn crashes (say, a
  network error), `index.js` simply keeps the previous array. There is no
  half-updated state to clean up.
- **The loop never prints.** It emits events (`assistant`, `tool_call`,
  `tool_result`, `step_limit`) and `index.js` decides how to show them. The
  same loop could drive a web UI.

---

## Part 2: The tools

### What the model sees: schemas (`tools/schemas.js`)

The model does not know your tools exist until you describe them. Each tool
is a JSON Schema sent with every request:

```js
{
  type: 'function',
  function: {
    name: 'read',
    description: 'Read the contents of a file.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string', description: '...' } },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
}
```

`strict: true` and `additionalProperties: false` push the model to produce
exactly `{"filePath": "..."}` and nothing else. The `description` matters a
lot: it is how the model decides *when* to use a tool.

### What actually runs: handlers (`tools/dispatch.js`)

A `Map` from tool name to function:

| Tool    | Arguments                            | What it does                                      |
| ------- | ------------------------------------ | ------------------------------------------------- |
| `read`  | `filePath`                           | Returns the file's text                           |
| `write` | `filePath`, `content`                | Creates or overwrites a file                      |
| `edit`  | `filePath`, `oldContent`, `newContent` | Replaces one exact, unique snippet              |
| `bash`  | `command`                            | Runs one allowlisted program (no shell)           |

`createToolExecutor` handles every tool call the same way:

1. Unknown tool? Reply with an error.
2. Arguments not valid JSON? Reply with an error.
3. Not approved? Reply "denied".
4. Run the handler. If it throws, reply with the error message.

Every path ends in exactly **one** `{ role: 'tool', tool_call_id, content }`
message. That is required, because the API rejects a conversation where a tool
call has no matching result. Errors are *returned to the model* instead of
crashing the harness, so the model can read "oldContent not found" and try
again. That self-correction is a big part of what makes agents work.

Results longer than 20,000 characters are cut short so one huge file cannot
flood the model's context window.

**Adding a tool** takes three steps: write the function, register it in
`dispatch.js`, and describe it in `schemas.js`.

### Why `edit` instead of always `write`?

`edit` makes the model quote the exact text it wants to replace. If the quote
is wrong, nothing changes. If it matches more than once, nothing changes. So
edits are small, precise, and impossible to make without having read the file.

---

## Part 3: Safety (the harness is the authority)

The system prompt *asks* the model to behave. **A prompt is not security.**
The real limits are in code:

1. **Workspace-scoped paths** (`paths.js`). Every file path is resolved
   against the workspace, and anything that lands outside it (`../x`,
   `/etc/passwd`) is rejected.
2. **Bash validation** (`bash.js`):
   - shell metacharacters ``; & | ` $ < >`` are rejected, so there is no
     chaining, piping, redirection or substitution;
   - known-destructive patterns (`rm -rf`, `sudo`, `git push`, ...) are blocked;
   - only allowlisted programs run (`ls`, `cat`, `grep`, `git`, `npm`, `node`, ...);
   - absolute paths, `~` and `..` in arguments are rejected;
   - the program runs through `execFile` with `shell: false`, so no shell ever
     interprets the string, and it has a 30 s timeout.
3. **Approval** (`approval.js`):
   - `auto`: `read` runs freely; `write`, `edit` and `bash` show you the exact
     arguments and wait for `y`;
   - `allow`: never asks (only in a throwaway sandbox);
   - `block`: denies everything, so the model can only talk.

Be honest about the limits: this is **not a sandbox**. `node` and `npm` can
run arbitrary code, and a symlink inside the workspace could point outside
it. Approval is the final safeguard. Read what you approve.

---

## Deliberately left out

Everything here is in service of the loop and the tools. Things from the
article (and from real harnesses) you could add as exercises:

- **Streaming**: print tokens as they arrive (`stream: true`, then parse the
  server-sent events and stitch the tool call fragments back together).
- **Context tags**: expand `@./file.js` in the user's message into the
  file's contents before sending it.
- **Sessions**: save and load the messages array as JSON. Because it is
  plain data, this is a few lines.
- **`.gitignore` protection**: refuse or require approval to read ignored
  files like `.env`.
- **Output review**: ask before sending a tool's output back to the model.
- **Context management**: once the history gets too long, summarise or drop
  old tool results.
- **Validate before approving**: run `validateCommand` before asking the
  user, so you are never asked about a command that will be rejected anyway.

## A suggested reading order

1. `src/agentLoop.js`: the loop
2. `src/tools/schemas.js`, then `src/tools/dispatch.js`: how tools are offered and run
3. `src/model.js`: what one model call looks like on the wire
4. `src/tools/bash.js`, `src/tools/paths.js` and `src/approval.js`: safety
5. `src/index.js`: how it is all wired together
6. `test/harness.test.js`: the loop running against a fake model
