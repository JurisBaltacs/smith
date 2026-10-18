// Configuration: everything the harness needs to know about its environment.
//
// It is read once at startup and frozen, so no other part of the program can
// change it behind our back. The model is just a setting here: swap BASE_URL
// and MODEL to point the same harness at a different provider.

const APPROVAL_MODES = ['auto', 'allow', 'block'];

export const loadConfig = (env = process.env, cwd = process.cwd()) => {
  const approvalMode = env.APPROVAL_MODE ?? 'auto';

  if (!APPROVAL_MODES.includes(approvalMode)) {
    throw new Error(`APPROVAL_MODE must be one of: ${APPROVAL_MODES.join(', ')}`);
  }

  return Object.freeze({
    apiKey: env.API_KEY ?? env.OPENAI_API_KEY,
    baseURL: env.BASE_URL ?? 'https://api.openai.com/v1',
    model: env.MODEL ?? 'gpt-5.4-mini',
    approvalMode,
    maxSteps: Number(env.MAX_STEPS ?? 25),
    // The agent may only touch files inside the directory it was started from.
    workspace: cwd,
  });
};
