// Approval: the human stays in control.
//
// Validation in the tools catches the obviously bad cases. Approval covers the
// rest: before anything changes the disk or runs a program, the user sees the
// exact call and decides.
//
// Modes:
//   auto  - read-only tools run freely, everything else asks first (default)
//   allow - never ask (only sensible inside a disposable sandbox)
//   block - deny every tool call (the model can only talk)

const READ_ONLY_TOOLS = new Set(['read']);

export const createApprover = (mode, askUser) => async (toolName, args) => {
  if (mode === 'allow') return true;
  if (mode === 'block') return false;
  if (READ_ONLY_TOOLS.has(toolName)) return true;

  const answer = await askUser(
    `\nAllow ${toolName} with ${JSON.stringify(args, null, 2)}?\n(y/N) `,
  );
  return answer?.trim().toLowerCase() === 'y';
};
