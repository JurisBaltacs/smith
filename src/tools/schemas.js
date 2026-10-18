// Tool schemas: the "menu" of actions the model is told it can request.
//
// The model never sees our JavaScript. It only sees these JSON Schema
// descriptions, and it answers with a tool name and JSON arguments that match
// them. `strict: true` plus `additionalProperties: false` push the model to
// produce exactly these argument shapes and nothing else.
//
// A schema is a promise, not a guarantee: the harness still validates every
// call before running it (see dispatch.js, paths.js and bash.js).

const defineTool = (name, description, properties) => ({
  type: 'function',
  function: {
    name,
    description,
    strict: true,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  },
});

const filePath = {
  type: 'string',
  description: 'Path to the file, relative to the workspace root.',
};

export const toolSchemas = [
  defineTool('read', 'Read the contents of a file.', { filePath }),

  defineTool('write', 'Create a file, or overwrite it completely, with the given content.', {
    filePath,
    content: { type: 'string', description: 'The full new content of the file.' },
  }),

  defineTool(
    'edit',
    'Replace one exact piece of text in a file. oldContent must appear exactly once in the file.',
    {
      filePath,
      oldContent: { type: 'string', description: 'The exact text to replace.' },
      newContent: { type: 'string', description: 'The text to put in its place.' },
    },
  ),

  defineTool(
    'bash',
    'Run one allowlisted command (ls, cat, grep, git, npm, node, ...) in the workspace. ' +
      'No pipes, redirects, chaining, absolute paths or "..".',
    { command: { type: 'string', description: 'The command line to run, e.g. "npm test".' } },
  ),
];
