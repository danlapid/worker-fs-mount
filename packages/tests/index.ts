// Worker entry point for integration tests
// Tests the actual library: withMounts() + mount() + aliased node:fs/promises

import type { Dirent } from 'node:fs';
// This import gets aliased to worker-fs-mount/fs via wrangler.toml
import fs from 'node:fs/promises';
import { DurableObjectFilesystem } from 'durable-object-fs';
import { MemoryFilesystem } from 'memory-fs';
import { R2Filesystem } from 'r2-fs';
import { isInMountContext, isMounted, mount, withMounts } from 'worker-fs-mount';

// Re-export classes to make them available via ctx.exports
export { DurableObjectFilesystem, MemoryFilesystem };

// Helper to wrap async operations and catch errors properly
async function safeCall<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: string }> {
  try {
    const result = await fn();
    return { result };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Shared filesystem endpoint handler.
 * Handles all standard fs operations for any mounted filesystem.
 */
async function handleFsEndpoint(
  fsEndpoint: string,
  body: any,
  mountPath: string
): Promise<Response | null> {
  if (fsEndpoint === '/writeFile') {
    const fullPath = `${mountPath}${body.path}`;
    let fsOptions: any;
    if (body.options) {
      if (body.options.append) {
        fsOptions = { flag: 'a' };
      } else if (body.options.exclusive) {
        fsOptions = { flag: 'wx' };
      } else {
        fsOptions = body.options;
      }
    }
    const { error } = await safeCall(async () => {
      await fs.writeFile(fullPath, body.content, fsOptions);
    });
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true, bytesWritten: body.content.length });
  }

  if (fsEndpoint === '/readFile') {
    const fullPath = `${mountPath}${body.path}`;
    const { result: content, error } = await safeCall(() => fs.readFile(fullPath, 'utf8'));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true, content });
  }

  if (fsEndpoint === '/stat') {
    const fullPath = `${mountPath}${body.path}`;
    const statFn = body.options?.followSymlinks === false ? fs.lstat : fs.stat;
    const { result: stat, error } = await safeCall(() => statFn(fullPath));
    if (error) {
      if (error.includes('ENOENT')) {
        return Response.json({ ok: true, stat: null });
      }
      return Response.json({ ok: false, error }, { status: 500 });
    }
    if (!stat) return Response.json({ ok: true, stat: null });
    return Response.json({
      ok: true,
      stat: {
        type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file',
        size: stat.size,
      },
    });
  }

  if (fsEndpoint === '/mkdir') {
    const fullPath = `${mountPath}${body.path}`;
    const { result, error } = await safeCall(() => fs.mkdir(fullPath, body.options));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true, result });
  }

  if (fsEndpoint === '/readdir') {
    const fullPath = `${mountPath}${body.path}`;
    const { result: entries, error } = await safeCall(async () => {
      const dirents = await fs.readdir(fullPath, { withFileTypes: true, ...body.options });
      return dirents as unknown as Dirent[];
    });
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({
      ok: true,
      entries: entries?.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
      })),
    });
  }

  if (fsEndpoint === '/rm') {
    const fullPath = `${mountPath}${body.path}`;
    const { error } = await safeCall(() => fs.rm(fullPath, body.options));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/unlink') {
    const fullPath = `${mountPath}${body.path}`;
    const { error } = await safeCall(() => fs.unlink(fullPath));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/rename') {
    const fullOldPath = `${mountPath}${body.oldPath}`;
    const fullNewPath = `${mountPath}${body.newPath}`;
    const { error } = await safeCall(() => fs.rename(fullOldPath, fullNewPath));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/cp') {
    const fullSrc = `${mountPath}${body.src}`;
    const fullDest = `${mountPath}${body.dest}`;
    const { error } = await safeCall(() => fs.cp(fullSrc, fullDest, body.options));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/truncate') {
    const fullPath = `${mountPath}${body.path}`;
    const { error } = await safeCall(() => fs.truncate(fullPath, body.length));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/symlink') {
    const fullLinkPath = `${mountPath}${body.linkPath}`;
    const { error } = await safeCall(() => fs.symlink(body.targetPath, fullLinkPath));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/readlink') {
    const fullPath = `${mountPath}${body.path}`;
    const { result: target, error } = await safeCall(() => fs.readlink(fullPath));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true, target });
  }

  if (fsEndpoint === '/access') {
    const fullPath = `${mountPath}${body.path}`;
    const { error } = await safeCall(() => fs.access(fullPath, body.mode));
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  if (fsEndpoint === '/reset') {
    // Delete everything in the filesystem
    const { error } = await safeCall(async () => {
      const entries = await fs.readdir(mountPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = `${mountPath}/${entry.name}`;
        await fs.rm(fullPath, { recursive: true, force: true });
      }
    });
    if (error) return Response.json({ ok: false, error }, { status: 500 });
    return Response.json({ ok: true });
  }

  // Return null if endpoint not handled
  return null;
}

const MEM_MOUNT_PATH = '/mnt/mem';
const DO_MOUNT_PATH = '/mnt/do';
const R2_MOUNT_PATH = '/mnt/r2';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withMounts(async () => {
      const url = new URL(request.url);
      const endpoint = url.pathname;

      try {
        // ============================================
        // Memory Filesystem (/mem/*)
        // ============================================
        if (endpoint.startsWith('/mem/')) {
          const memEndpoint = endpoint.slice(4); // Remove '/mem' prefix
          const body = (await request.json()) as any;

          mount(MEM_MOUNT_PATH, ctx.exports.MemoryFilesystem);

          // Special: reset clears in-memory state instead of deleting files
          if (memEndpoint === '/reset') {
            MemoryFilesystem.resetState();
            return Response.json({ ok: true });
          }

          const response = await handleFsEndpoint(memEndpoint, body, MEM_MOUNT_PATH);
          if (response) return response;

          return Response.json({ error: 'Unknown mem endpoint' }, { status: 404 });
        }

        // ============================================
        // DurableObject Filesystem (/do/*)
        // ============================================
        if (endpoint.startsWith('/do/')) {
          const doEndpoint = endpoint.slice(3); // Remove '/do' prefix
          const body = (await request.json()) as any;

          const doId = body.doId ?? 'test-do';
          const id = ctx.exports.DurableObjectFilesystem.idFromName(doId);
          const stub = ctx.exports.DurableObjectFilesystem.get(id);
          mount(DO_MOUNT_PATH, stub);

          const response = await handleFsEndpoint(doEndpoint, body, DO_MOUNT_PATH);
          if (response) return response;

          return Response.json({ error: 'Unknown DO endpoint' }, { status: 404 });
        }

        // ============================================
        // R2 Filesystem (/r2/*)
        // ============================================
        if (endpoint.startsWith('/r2/')) {
          const r2Endpoint = endpoint.slice(3); // Remove '/r2' prefix
          const body = (await request.json()) as any;

          const r2fs = new R2Filesystem(env.TEST_BUCKET);
          mount(R2_MOUNT_PATH, r2fs);

          const response = await handleFsEndpoint(r2Endpoint, body, R2_MOUNT_PATH);
          if (response) return response;

          return Response.json({ error: 'Unknown R2 endpoint' }, { status: 404 });
        }

        // ============================================
        // Utility Endpoints
        // ============================================
        if (endpoint === '/setup') {
          mount(MEM_MOUNT_PATH, ctx.exports.MemoryFilesystem);
          return Response.json({ ok: true, mounted: MEM_MOUNT_PATH });
        }

        if (endpoint === '/isMounted') {
          mount(MEM_MOUNT_PATH, ctx.exports.MemoryFilesystem);
          const body = (await request.json()) as { path: string };
          return Response.json({ ok: true, mounted: isMounted(body.path) });
        }

        if (endpoint === '/isInMountContext') {
          return Response.json({ ok: true, inContext: isInMountContext() });
        }

        if (endpoint === '/readFileFullPath') {
          mount(MEM_MOUNT_PATH, ctx.exports.MemoryFilesystem);
          const body = (await request.json()) as { fullPath: string };
          const { result: content, error } = await safeCall(() =>
            fs.readFile(body.fullPath, 'utf8')
          );
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, content });
        }

        // ============================================
        // Mount Isolation Tests
        // ============================================
        if (endpoint === '/isolation/test') {
          const body = (await request.json()) as { id: string; action: 'mount' | 'check' };

          if (body.action === 'mount') {
            try {
              mount('/isolation/test', ctx.exports.MemoryFilesystem);
              return Response.json({
                ok: true,
                id: body.id,
                mounted: true,
                inContext: isInMountContext(),
              });
            } catch (error) {
              return Response.json({
                ok: false,
                id: body.id,
                error: (error as Error).message,
              });
            }
          }

          if (body.action === 'check') {
            return Response.json({
              ok: true,
              id: body.id,
              isMounted: isMounted('/isolation/test'),
              inContext: isInMountContext(),
            });
          }
        }

        if (endpoint === '/isolation/concurrent') {
          const body = (await request.json()) as { id: string; delay?: number };

          mount('/concurrent', ctx.exports.MemoryFilesystem);
          await fs.writeFile('/concurrent/id.txt', body.id);

          if (body.delay) {
            await new Promise((r) => setTimeout(r, body.delay));
          }

          const content = await fs.readFile('/concurrent/id.txt', 'utf8');

          return Response.json({
            ok: true,
            id: body.id,
            readId: content,
            match: content === body.id,
          });
        }

        return Response.json({ error: 'Unknown endpoint' }, { status: 404 });
      } catch (error) {
        const err = error as Error;
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    });
  },
};
