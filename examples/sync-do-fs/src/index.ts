/**
 * Example: Synchronous Filesystem in Durable Objects
 *
 * This example demonstrates using LocalDOFilesystem with synchronous
 * node:fs methods inside a Durable Object. This is useful when you need
 * to use libraries that require synchronous filesystem access.
 */

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import fs from 'node:fs'; // Aliased to worker-fs-mount/fs-sync
import { LocalDOFilesystem } from 'durable-object-fs';
import { mount } from 'worker-fs-mount';

const MOUNT_PATH = '/data';

/**
 * A Durable Object that uses synchronous filesystem operations.
 * LocalDOFilesystem operates directly on ctx.storage.sql, enabling
 * true synchronous fs methods within the DO context.
 */
export class SyncFilesystemDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Create and mount LocalDOFilesystem using the DO's SQLite storage.
    // Mount once in constructor - DOs are single-threaded so no request isolation needed.
    const localFs = new LocalDOFilesystem(ctx.storage.sql);
    mount(MOUNT_PATH, localFs);
  }

  /**
   * Handle filesystem operations using sync fs methods.
   * All operations run synchronously within the DO's single-threaded context.
   */
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    const path = MOUNT_PATH + (url.searchParams.get('path') || '/');

    try {
      switch (url.pathname) {
        case '/api/list': {
          // Synchronous readdir
          const entries = fs.readdirSync(path, { withFileTypes: true });
          const items = entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : e.isSymbolicLink() ? 'symlink' : 'file',
          }));
          return Response.json({ success: true, items });
        }

        case '/api/read': {
          // Synchronous readFile
          const content = fs.readFileSync(path, 'utf8');
          const stats = fs.statSync(path);
          return Response.json({
            success: true,
            content,
            size: stats.size,
          });
        }

        case '/api/write': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          // Note: We need to read the body async, but the fs operation is sync
          return (async () => {
            const { content } = (await request.json()) as { content: string };
            fs.writeFileSync(path, content);
            return Response.json({ success: true });
          })();
        }

        case '/api/mkdir': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          fs.mkdirSync(path, { recursive: true });
          return Response.json({ success: true });
        }

        case '/api/delete': {
          if (request.method !== 'POST') {
            return Response.json({ success: false, error: 'Method not allowed' }, { status: 405 });
          }
          fs.rmSync(path, { recursive: true, force: true });
          return Response.json({ success: true });
        }

        case '/api/exists': {
          const exists = fs.existsSync(path);
          return Response.json({ success: true, exists });
        }

        case '/api/stat': {
          const stats = fs.statSync(path);
          return Response.json({
            success: true,
            stat: {
              type: stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file',
              size: stats.size,
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

/**
 * Worker entrypoint that routes requests to the Durable Object.
 */
export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Route API requests to the Durable Object
    if (url.pathname.startsWith('/api/')) {
      const id = this.ctx.exports.SyncFilesystemDO.idFromName('demo');
      const stub = this.ctx.exports.SyncFilesystemDO.get(id);
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
}
