import { AsyncLocalStorage } from 'node:async_hooks';
import * as nodeFs from './fs-sync.js';
import { mount, withMounts } from './registry.js';
import type { SyncWorkerFilesystem } from './types.js';
import { normalizePath } from './utils.js';

export interface EmscriptenFilesystemOptions {
  nodeFs: typeof nodeFs;
  cwd: string;
}

/** Create one module with a mount context retained across calls and async callbacks. */
export function createEmscriptenModule<T>(
  directory: string,
  filesystem: SyncWorkerFilesystem,
  create: (options: EmscriptenFilesystemOptions) => Promise<T>
): Promise<{ instance: T; run: ReturnType<typeof AsyncLocalStorage.snapshot> }> {
  return withMounts(async () => {
    const cwd = normalizePath(directory);
    mount(cwd, filesystem);
    const run = AsyncLocalStorage.snapshot();
    return { instance: await create({ nodeFs, cwd }), run };
  });
}
