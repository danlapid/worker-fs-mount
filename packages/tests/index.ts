// Worker entry point for integration tests
// Tests the actual library: withMounts() + mount() + aliased node:fs/promises

import { withMounts, mount, isMounted, isInMountContext } from 'worker-fs-mount';
import { DurableObjectFilesystem } from 'durable-object-fs';
import { R2Filesystem } from 'r2-fs';
import { MemoryFilesystemEntrypoint } from 'memory-fs';
// This import gets aliased to worker-fs-mount/fs via wrangler.toml
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';

// Re-export classes to make them available via ctx.exports
export { DurableObjectFilesystem, MemoryFilesystemEntrypoint };


// Helper to wrap async operations and catch errors properly
async function safeCall<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: string }> {
  try {
    const result = await fn();
    return { result };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

const MOUNT_PATH = '/mnt/test';
const DO_MOUNT_PATH = '/mnt/do';
const R2_MOUNT_PATH = '/mnt/r2';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Wrap entire request in withMounts for request-scoped mount isolation
    return withMounts(async () => {
      const url = new URL(request.url);
      const endpoint = url.pathname;

      try {
        // Mount the filesystem for this request (except reset which clears state)
        if (endpoint !== '/reset' && !endpoint.startsWith('/do/') && !endpoint.startsWith('/r2/') && !endpoint.startsWith('/isolation/')) {
          mount(MOUNT_PATH, ctx.exports.MemoryFilesystemEntrypoint);
        }

        if (endpoint === '/setup') {
          // Mount already done above, just return success
          return Response.json({ ok: true, mounted: MOUNT_PATH });
        }

        if (endpoint === '/reset') {
          MemoryFilesystemEntrypoint.resetState();
          return Response.json({ ok: true });
        }

        if (endpoint === '/isMounted') {
          const body = (await request.json()) as { path: string };
          return Response.json({ ok: true, mounted: isMounted(body.path) });
        }

        if (endpoint === '/isInMountContext') {
          return Response.json({ ok: true, inContext: isInMountContext() });
        }

        // ============================================
        // DurableObject Filesystem Tests
        // ============================================

        if (endpoint.startsWith('/do/')) {
          const doEndpoint = endpoint.slice(3); // Remove '/do' prefix
          const body = (await request.json()) as any;

          // Get or create DO instance using ctx.exports
          const doId = body.doId ?? 'test-do';
          const id = ctx.exports.DurableObjectFilesystem.idFromName(doId);
          const stub = ctx.exports.DurableObjectFilesystem.get(id);

          // Mount the DO filesystem
          mount(DO_MOUNT_PATH, stub);

          if (doEndpoint === '/writeFile') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            let fsOptions: any = undefined;
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

          if (doEndpoint === '/readFile') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { result: content, error } = await safeCall(() => fs.readFile(fullPath, 'utf8'));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true, content });
          }

          if (doEndpoint === '/stat') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
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

          if (doEndpoint === '/mkdir') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { result, error } = await safeCall(() => fs.mkdir(fullPath, body.options));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true, result });
          }

          if (doEndpoint === '/readdir') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { result: entries, error } = await safeCall(async () => {
              const dirents = await fs.readdir(fullPath, { withFileTypes: true, ...body.options });
              return dirents as unknown as Dirent[];
            });
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({
              ok: true,
              entries: entries!.map((e) => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
              })),
            });
          }

          if (doEndpoint === '/rm') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.rm(fullPath, body.options));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/unlink') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.unlink(fullPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/rename') {
            const fullOldPath = `${DO_MOUNT_PATH}${body.oldPath}`;
            const fullNewPath = `${DO_MOUNT_PATH}${body.newPath}`;
            const { error } = await safeCall(() => fs.rename(fullOldPath, fullNewPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/cp') {
            const fullSrc = `${DO_MOUNT_PATH}${body.src}`;
            const fullDest = `${DO_MOUNT_PATH}${body.dest}`;
            const { error } = await safeCall(() => fs.cp(fullSrc, fullDest, body.options));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/truncate') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.truncate(fullPath, body.length));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/symlink') {
            const fullLinkPath = `${DO_MOUNT_PATH}${body.linkPath}`;
            const { error } = await safeCall(() => fs.symlink(body.targetPath, fullLinkPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/readlink') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { result: target, error } = await safeCall(() => fs.readlink(fullPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true, target });
          }

          if (doEndpoint === '/access') {
            const fullPath = `${DO_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.access(fullPath, body.mode));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (doEndpoint === '/reset') {
            // Delete everything in the DO filesystem
            const { error } = await safeCall(async () => {
              const entries = await fs.readdir(DO_MOUNT_PATH, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = `${DO_MOUNT_PATH}/${entry.name}`;
                await fs.rm(fullPath, { recursive: true, force: true });
              }
            });
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          return Response.json({ error: 'Unknown DO endpoint' }, { status: 404 });
        }

        // ============================================
        // R2 Filesystem Tests
        // ============================================

        if (endpoint.startsWith('/r2/')) {
          const r2Endpoint = endpoint.slice(3); // Remove '/r2' prefix
          const body = (await request.json()) as any;

          // Get the R2 bucket from env and create R2Filesystem
          const r2fs = new R2Filesystem(env.TEST_BUCKET);

          // Mount the R2 filesystem
          mount(R2_MOUNT_PATH, r2fs);

          if (r2Endpoint === '/writeFile') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            let fsOptions: any = undefined;
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

          if (r2Endpoint === '/readFile') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { result: content, error } = await safeCall(() => fs.readFile(fullPath, 'utf8'));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true, content });
          }

          if (r2Endpoint === '/stat') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
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

          if (r2Endpoint === '/mkdir') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { result, error } = await safeCall(() => fs.mkdir(fullPath, body.options));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true, result });
          }

          if (r2Endpoint === '/readdir') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { result: entries, error } = await safeCall(async () => {
              const dirents = await fs.readdir(fullPath, { withFileTypes: true, ...body.options });
              return dirents as unknown as Dirent[];
            });
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({
              ok: true,
              entries: entries!.map((e) => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
              })),
            });
          }

          if (r2Endpoint === '/rm') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.rm(fullPath, body.options));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/unlink') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.unlink(fullPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/rename') {
            const fullOldPath = `${R2_MOUNT_PATH}${body.oldPath}`;
            const fullNewPath = `${R2_MOUNT_PATH}${body.newPath}`;
            const { error } = await safeCall(() => fs.rename(fullOldPath, fullNewPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/cp') {
            const fullSrc = `${R2_MOUNT_PATH}${body.src}`;
            const fullDest = `${R2_MOUNT_PATH}${body.dest}`;
            const { error } = await safeCall(() => fs.cp(fullSrc, fullDest, body.options));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/truncate') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.truncate(fullPath, body.length));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/symlink') {
            const fullLinkPath = `${R2_MOUNT_PATH}${body.linkPath}`;
            const { error } = await safeCall(() => fs.symlink(body.targetPath, fullLinkPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/readlink') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { result: target, error } = await safeCall(() => fs.readlink(fullPath));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true, target });
          }

          if (r2Endpoint === '/access') {
            const fullPath = `${R2_MOUNT_PATH}${body.path}`;
            const { error } = await safeCall(() => fs.access(fullPath, body.mode));
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          if (r2Endpoint === '/reset') {
            // Delete everything in the R2 bucket
            const { error } = await safeCall(async () => {
              const entries = await fs.readdir(R2_MOUNT_PATH, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = `${R2_MOUNT_PATH}/${entry.name}`;
                await fs.rm(fullPath, { recursive: true, force: true });
              }
            });
            if (error) return Response.json({ ok: false, error }, { status: 500 });
            return Response.json({ ok: true });
          }

          return Response.json({ error: 'Unknown R2 endpoint' }, { status: 404 });
        }

        // ============================================
        // Mount Isolation Tests
        // ============================================

        if (endpoint === '/isolation/test') {
          // This endpoint tests that mounts are isolated per-request
          // Each request should be able to mount to /test without conflict
          const body = (await request.json()) as { id: string; action: 'mount' | 'check' };

          if (body.action === 'mount') {
            // Try to mount - should succeed because we're in our own context
            try {
              mount('/isolation/test', ctx.exports.MemoryFilesystemEntrypoint);
              return Response.json({
                ok: true,
                id: body.id,
                mounted: true,
                inContext: isInMountContext()
              });
            } catch (error) {
              return Response.json({
                ok: false,
                id: body.id,
                error: (error as Error).message
              });
            }
          }

          if (body.action === 'check') {
            return Response.json({
              ok: true,
              id: body.id,
              isMounted: isMounted('/isolation/test'),
              inContext: isInMountContext()
            });
          }
        }

        if (endpoint === '/isolation/concurrent') {
          // Simulate a long-running operation to test concurrent mount isolation
          const body = (await request.json()) as { id: string; delay?: number };

          mount('/concurrent', ctx.exports.MemoryFilesystemEntrypoint);

          // Write a file with the request ID
          await fs.writeFile('/concurrent/id.txt', body.id);

          // Wait for the specified delay
          if (body.delay) {
            await new Promise(r => setTimeout(r, body.delay));
          }

          // Read back the file - should still have our ID
          const content = await fs.readFile('/concurrent/id.txt', 'utf8');

          return Response.json({
            ok: true,
            id: body.id,
            readId: content,
            match: content === body.id
          });
        }

        // ============================================
        // All operations use the ALIASED node:fs/promises
        // fs.X() -> fs-promises.ts -> findMount() -> stub.X()
        // ============================================

        if (endpoint === '/writeFile') {
          const body = (await request.json()) as { path: string; content: string; options?: any };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          // Convert our simple options to node:fs flag format
          let fsOptions: any = undefined;
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

        if (endpoint === '/readFile') {
          const body = (await request.json()) as { path: string };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { result: content, error } = await safeCall(() => fs.readFile(fullPath, 'utf8'));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, content });
        }

        if (endpoint === '/stat') {
          const body = (await request.json()) as { path: string; options?: any };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          // Use lstat if followSymlinks is false
          const statFn = body.options?.followSymlinks === false ? fs.lstat : fs.stat;
          const { result: stat, error } = await safeCall(() => statFn(fullPath));
          if (error) {
            // Return null for ENOENT errors
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

        if (endpoint === '/mkdir') {
          const body = (await request.json()) as { path: string; options?: any };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { result, error } = await safeCall(() => fs.mkdir(fullPath, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, result });
        }

        if (endpoint === '/readdir') {
          const body = (await request.json()) as { path: string; options?: any };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { result: entries, error } = await safeCall(async () => {
            const dirents = await fs.readdir(fullPath, { withFileTypes: true, ...body.options });
            return dirents as unknown as Dirent[];
          });
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({
            ok: true,
            entries: entries!.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
            })),
          });
        }

        if (endpoint === '/rm') {
          const body = (await request.json()) as { path: string; options?: any };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { error } = await safeCall(() => fs.rm(fullPath, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/unlink') {
          const body = (await request.json()) as { path: string };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { error } = await safeCall(() => fs.unlink(fullPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/rename') {
          const body = (await request.json()) as { oldPath: string; newPath: string };
          const fullOldPath = `${MOUNT_PATH}${body.oldPath}`;
          const fullNewPath = `${MOUNT_PATH}${body.newPath}`;
          const { error } = await safeCall(() => fs.rename(fullOldPath, fullNewPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/cp') {
          const body = (await request.json()) as { src: string; dest: string; options?: any };
          const fullSrc = `${MOUNT_PATH}${body.src}`;
          const fullDest = `${MOUNT_PATH}${body.dest}`;
          const { error } = await safeCall(() => fs.cp(fullSrc, fullDest, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/truncate') {
          const body = (await request.json()) as { path: string; length?: number };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { error } = await safeCall(() => fs.truncate(fullPath, body.length));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/symlink') {
          const body = (await request.json()) as { linkPath: string; targetPath: string };
          const fullLinkPath = `${MOUNT_PATH}${body.linkPath}`;
          const { error } = await safeCall(() => fs.symlink(body.targetPath, fullLinkPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/readlink') {
          const body = (await request.json()) as { path: string };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { result: target, error } = await safeCall(() => fs.readlink(fullPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, target });
        }

        if (endpoint === '/access') {
          const body = (await request.json()) as { path: string; mode?: number };
          const fullPath = `${MOUNT_PATH}${body.path}`;
          const { error } = await safeCall(() => fs.access(fullPath, body.mode));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (endpoint === '/readFileFullPath') {
          const body = (await request.json()) as { fullPath: string };
          // Uses the aliased fs.readFile with a full path (tests that mount routing works)
          const { result: content, error } = await safeCall(() => fs.readFile(body.fullPath, 'utf8'));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, content });
        }

        return Response.json({ error: 'Unknown endpoint' }, { status: 404 });
      } catch (error) {
        const err = error as Error;
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    });
  },
};
