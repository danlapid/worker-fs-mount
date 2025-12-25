// Worker entry point for integration tests
// Tests the actual library: mount() + aliased node:fs/promises

import { mount, clearMounts, findMount } from 'worker-fs-mount';
// This import gets aliased to worker-fs-mount/fs via wrangler.toml
import fs from 'node:fs/promises';

export { MemoryFilesystem, resetMemoryFilesystem } from './memory-filesystem.js';


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

export default {
  async fetch(request: Request, _env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const endpoint = url.pathname;

    try {
      // Get the MemoryFilesystem entrypoint from ctx.exports
      // Ensure mount exists for operations
      if (!findMount(MOUNT_PATH)) {
        mount(MOUNT_PATH, ctx.exports.MemoryFilesystem);
      }

      if (endpoint === '/setup') {
        clearMounts();
        mount(MOUNT_PATH, ctx.exports.MemoryFilesystem);
        return Response.json({ ok: true, mounted: MOUNT_PATH });
      }

      if (endpoint === '/reset') {
        const { resetMemoryFilesystem } = await import('./memory-filesystem.js');
        resetMemoryFilesystem();
        clearMounts();
        return Response.json({ ok: true });
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
        const { result: entries, error } = await safeCall(() =>
          fs.readdir(fullPath, { withFileTypes: true, ...body.options })
        );
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

      // For chunked read/write, use the stub directly (no fs equivalent)
      if (endpoint === '/read') {
        const body = (await request.json()) as { path: string; offset: number; length: number };
        const match = findMount(`${MOUNT_PATH}${body.path}`);
        if (!match) return Response.json({ ok: false, error: 'Mount not found' }, { status: 500 });
        const { result: chunk, error } = await safeCall(() =>
          match.mount.stub.read!(match.relativePath, { offset: body.offset, length: body.length })
        );
        if (error) return Response.json({ ok: false, error }, { status: 500 });
        return Response.json({ ok: true, content: new TextDecoder().decode(chunk!) });
      }

      if (endpoint === '/write') {
        const body = (await request.json()) as { path: string; content: string; offset: number };
        const match = findMount(`${MOUNT_PATH}${body.path}`);
        if (!match) return Response.json({ ok: false, error: 'Mount not found' }, { status: 500 });
        const data = new TextEncoder().encode(body.content);
        const { result: bytesWritten, error } = await safeCall(() =>
          match.mount.stub.write!(match.relativePath, data, { offset: body.offset })
        );
        if (error) return Response.json({ ok: false, error }, { status: 500 });
        return Response.json({ ok: true, bytesWritten });
      }

      if (endpoint === '/findMount') {
        const body = (await request.json()) as { path: string };
        const match = findMount(body.path);
        if (!match) {
          return Response.json({ ok: true, match: null });
        }
        return Response.json({
          ok: true,
          match: {
            mountPath: match.mount.path,
            relativePath: match.relativePath,
          },
        });
      }

      if (endpoint === '/readFileViaFindMount') {
        const body = (await request.json()) as { fullPath: string };
        // Uses the aliased fs.readFile which routes through findMount
        const { result: content, error } = await safeCall(() => fs.readFile(body.fullPath, 'utf8'));
        if (error) return Response.json({ ok: false, error }, { status: 500 });
        return Response.json({ ok: true, content });
      }

      return Response.json({ error: 'Unknown endpoint' }, { status: 404 });
    } catch (error) {
      const err = error as Error;
      return Response.json({ ok: false, error: err.message }, { status: 500 });
    }
  },
};
