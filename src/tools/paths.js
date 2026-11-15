// Workspace path security: keeps file tools inside the project directory.
//
// The model chooses the paths, so the harness must assume any path could be
// "../../.ssh/id_rsa" or "/etc/passwd". Every file tool goes through this
// check before touching the disk.
//
// Limitation: a symlink inside the workspace that points outside it is not
// caught. A real harness would resolve symlinks with fs.realpath as well.

import path from 'node:path';

export const resolveInWorkspace = (workspace, filePath) => {
  const resolved = path.resolve(workspace, filePath);
  const relative = path.relative(workspace, resolved);

  const escapesWorkspace =
    relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);

  if (escapesWorkspace) {
    throw new Error(`Path "${filePath}" is outside the workspace.`);
  }

  // Secrets files are off limits even inside the workspace. Whatever the model
  // reads is sent to the provider, so an API key in .env would leak.
  const name = path.basename(resolved);
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
    throw new Error(`Path "${filePath}" is a secrets file and cannot be accessed.`);
  }

  return resolved;
};
