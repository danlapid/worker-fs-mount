/**
 * Test-specific Durable Object that extends DurableObjectFilesystem
 * to add fetch handlers for testing sync filesystem operations.
 */
import { DurableObjectFilesystem, LocalDOFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';
// Import fs modules directly (not aliased) for testing
import * as fsPromises from 'worker-fs-mount/fs';
import * as fsSync from 'worker-fs-mount/fs-sync';

// Helper to safely execute and catch errors
function safeCall<T>(fn: () => T): { result?: T; error?: string } {
  try {
    return { result: fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

async function safeCallAsync<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: string }> {
  try {
    return { result: await fn() };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/**
 * Extended DurableObjectFilesystem with fetch handlers for testing.
 * This adds endpoints to test LocalDOFilesystem sync operations and
 * async fallback to sync functionality.
 */
export class TestDurableObjectFilesystem extends DurableObjectFilesystem {
  override async fetch(request: Request): Promise<Response> {
    // Initialize schema by calling parent's stat method
    // This ensures the SQLite tables exist for LocalDOFilesystem
    await this.stat('/');

    const url = new URL(request.url);
    const endpoint = url.pathname;

    // ============================================
    // LocalDOFilesystem tests (/local-fs/*) - Tests sync fs with sync-only mount
    // ============================================
    if (endpoint.startsWith('/local-fs/')) {
      const localFsEndpoint = endpoint.slice(9); // Remove '/local-fs' prefix
      const body = (await request.json()) as any;

      return withMounts(() => {
        const localFs = new LocalDOFilesystem(this.ctx.storage.sql);
        const mountPath = '/mnt/local';
        mount(mountPath, localFs);

        if (localFsEndpoint === '/writeFileSync') {
          const fullPath = `${mountPath}${body.path}`;
          let fsOptions: any;
          if (body.options?.append) {
            fsOptions = { flag: 'a' };
          } else if (body.options?.exclusive) {
            fsOptions = { flag: 'wx' };
          }
          const { error } = safeCall(() => fsSync.writeFileSync(fullPath, body.content, fsOptions));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, bytesWritten: body.content.length });
        }

        if (localFsEndpoint === '/readFileSync') {
          const fullPath = `${mountPath}${body.path}`;
          const { result: content, error } = safeCall(() => fsSync.readFileSync(fullPath, 'utf8'));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, content });
        }

        if (localFsEndpoint === '/statSync') {
          const fullPath = `${mountPath}${body.path}`;
          const statFn = body.options?.followSymlinks === false ? fsSync.lstatSync : fsSync.statSync;
          const { result: stat, error } = safeCall(() => statFn(fullPath));
          if (error) {
            if (error.includes('ENOENT')) {
              return Response.json({ ok: true, stat: null });
            }
            return Response.json({ ok: false, error }, { status: 500 });
          }
          return Response.json({
            ok: true,
            stat: {
              type: stat!.isDirectory() ? 'directory' : stat!.isSymbolicLink() ? 'symlink' : 'file',
              size: stat!.size,
            },
          });
        }

        if (localFsEndpoint === '/mkdirSync') {
          const fullPath = `${mountPath}${body.path}`;
          const { result, error } = safeCall(() => fsSync.mkdirSync(fullPath, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, result });
        }

        if (localFsEndpoint === '/readdirSync') {
          const fullPath = `${mountPath}${body.path}`;
          const { result: entries, error } = safeCall(() => {
            const dirents = fsSync.readdirSync(fullPath, { withFileTypes: true, ...body.options });
            return dirents;
          });
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({
            ok: true,
            entries: (entries as any[])?.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
            })),
          });
        }

        if (localFsEndpoint === '/rmSync') {
          const fullPath = `${mountPath}${body.path}`;
          const { error } = safeCall(() => fsSync.rmSync(fullPath, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (localFsEndpoint === '/unlinkSync') {
          const fullPath = `${mountPath}${body.path}`;
          const { error } = safeCall(() => fsSync.unlinkSync(fullPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (localFsEndpoint === '/existsSync') {
          const fullPath = `${mountPath}${body.path}`;
          const exists = fsSync.existsSync(fullPath);
          return Response.json({ ok: true, exists });
        }

        if (localFsEndpoint === '/symlinkSync') {
          const fullLinkPath = `${mountPath}${body.linkPath}`;
          const { error } = safeCall(() => fsSync.symlinkSync(body.targetPath, fullLinkPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (localFsEndpoint === '/readlinkSync') {
          const fullPath = `${mountPath}${body.path}`;
          const { result: target, error } = safeCall(() => fsSync.readlinkSync(fullPath));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, target });
        }

        if (localFsEndpoint === '/reset') {
          // Reset using the DO's own storage
          this.ctx.storage.sql.exec('DELETE FROM entries WHERE path != ?', '/');
          return Response.json({ ok: true });
        }

        return Response.json({ error: 'Unknown local-fs endpoint' }, { status: 404 });
      });
    }

    // ============================================
    // Async with sync-only mount tests (/async-with-sync/*)
    // Tests that async fs methods fall back to sync methods
    // ============================================
    if (endpoint.startsWith('/async-with-sync/')) {
      const asyncEndpoint = endpoint.slice(16); // Remove '/async-with-sync' prefix
      const body = (await request.json()) as any;

      return withMounts(async () => {
        const localFs = new LocalDOFilesystem(this.ctx.storage.sql);
        const mountPath = '/mnt/async-sync';
        mount(mountPath, localFs);

        if (asyncEndpoint === '/writeFile') {
          const fullPath = `${mountPath}${body.path}`;
          let fsOptions: any;
          if (body.options?.append) {
            fsOptions = { flag: 'a' };
          } else if (body.options?.exclusive) {
            fsOptions = { flag: 'wx' };
          }
          const { error } = await safeCallAsync(() => fsPromises.writeFile(fullPath, body.content, fsOptions));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, bytesWritten: body.content.length });
        }

        if (asyncEndpoint === '/readFile') {
          const fullPath = `${mountPath}${body.path}`;
          const { result: content, error } = await safeCallAsync(() => fsPromises.readFile(fullPath, 'utf8'));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, content });
        }

        if (asyncEndpoint === '/stat') {
          const fullPath = `${mountPath}${body.path}`;
          const statFn = body.options?.followSymlinks === false ? fsPromises.lstat : fsPromises.stat;
          const { result: stat, error } = await safeCallAsync(() => statFn(fullPath));
          if (error) {
            if (error.includes('ENOENT')) {
              return Response.json({ ok: true, stat: null });
            }
            return Response.json({ ok: false, error }, { status: 500 });
          }
          return Response.json({
            ok: true,
            stat: {
              type: stat!.isDirectory() ? 'directory' : stat!.isSymbolicLink() ? 'symlink' : 'file',
              size: stat!.size,
            },
          });
        }

        if (asyncEndpoint === '/mkdir') {
          const fullPath = `${mountPath}${body.path}`;
          const { result, error } = await safeCallAsync(() => fsPromises.mkdir(fullPath, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true, result });
        }

        if (asyncEndpoint === '/readdir') {
          const fullPath = `${mountPath}${body.path}`;
          const { result: entries, error } = await safeCallAsync(async () => {
            const dirents = await fsPromises.readdir(fullPath, { withFileTypes: true, ...body.options });
            return dirents;
          });
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({
            ok: true,
            entries: (entries as any[])?.map((e) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
            })),
          });
        }

        if (asyncEndpoint === '/rm') {
          const fullPath = `${mountPath}${body.path}`;
          const { error } = await safeCallAsync(() => fsPromises.rm(fullPath, body.options));
          if (error) return Response.json({ ok: false, error }, { status: 500 });
          return Response.json({ ok: true });
        }

        if (asyncEndpoint === '/reset') {
          // Reset using the DO's own storage
          this.ctx.storage.sql.exec('DELETE FROM entries WHERE path != ?', '/');
          return Response.json({ ok: true });
        }

        return Response.json({ error: 'Unknown async-with-sync endpoint' }, { status: 404 });
      });
    }

    return Response.json({ error: 'Unknown endpoint' }, { status: 404 });
  }
}
