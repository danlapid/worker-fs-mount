/**
 * Example: Durable Object-backed Filesystem
 *
 * This example demonstrates using worker-fs-mount and durable-object-fs
 * to store files persistently in a Durable Object using standard Node.js
 * fs/promises APIs.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import fs from 'node:fs/promises';
import { DurableObjectFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';

// Re-export the Durable Object class
export { DurableObjectFilesystem };

const MOUNT_PATH = '/data';

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    // Durable Objects require request scope - use withMounts
    return withMounts(async () => {
      // Mount the Durable Object filesystem
      // TODO: Once the runtime supports `exports` at module scope for DO namespaces,
      // this can be simplified to a global mount like the R2 example.
      const id = this.ctx.exports.DurableObjectFilesystem.idFromName('demo');
      const stub = this.ctx.exports.DurableObjectFilesystem.get(id);
      mount(MOUNT_PATH, stub);

      const url = new URL(request.url);

      // API endpoints
      if (url.pathname.startsWith('/api/')) {
        return this.handleApi(request, url);
      }

      return new Response("Not found", { status: 404 });
    });
  }

  async handleApi(request: Request, url: URL): Promise<Response> {
    const path = MOUNT_PATH + (url.searchParams.get('path') || '/');

    try {
      switch (url.pathname) {
        case '/api/list': {
          const entries = await fs.readdir(path, { withFileTypes: true });
          const items = entries.map(
            (e: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }) => ({
              name: e.name,
              type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
            })
          );
          return Response.json({ success: true, items });
        }

        case '/api/read': {
          const content = await fs.readFile(path, 'utf8');
          const stats = await fs.stat(path);
          return Response.json({
            success: true,
            content,
            size: stats.size,
            modified: stats.mtime,
          });
        }

        case '/api/write': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          const { content } = (await request.json()) as { content: string };
          await fs.writeFile(path, content);
          return Response.json({ success: true });
        }

        case '/api/mkdir': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          await fs.mkdir(path, { recursive: true });
          return Response.json({ success: true });
        }

        case '/api/delete': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          const stats = await fs.stat(path);
          if (stats.isDirectory()) {
            await fs.rm(path, { recursive: true });
          } else {
            await fs.unlink(path);
          }
          return Response.json({ success: true });
        }

        case '/api/rename': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          const { newPath } = (await request.json()) as { newPath: string };
          await fs.rename(path, MOUNT_PATH + newPath);
          return Response.json({ success: true });
        }

        case '/api/stat': {
          const stats = await fs.stat(path);
          return Response.json({
            success: true,
            stat: {
              type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
              size: stats.size,
              modified: stats.mtime,
              created: stats.birthtime,
            },
          });
        }

        default:
          return Response.json({ success: false, error: 'Unknown endpoint' }, { status: 404 });
      }
    } catch (err) {
      const error = err as Error & { code?: string };
      return Response.json(
        {
          success: false,
          error: error.message,
          code: error.code,
        },
        { status: error.code === 'ENOENT' ? 404 : 500 }
      );
    }
  }
}
