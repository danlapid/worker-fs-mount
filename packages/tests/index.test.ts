import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PORT = 8787 + Math.floor(Math.random() * 1000);

let wranglerProcess: ChildProcess;

async function waitForReady(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Worker did not become ready within ${timeoutMs}ms`);
}

// Helper to make requests to the worker
async function workerFetch(endpoint: string, body?: object): Promise<Response> {
  return fetch(`http://localhost:${TEST_PORT}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : JSON.stringify({}),
  });
}

/**
 * Creates a test suite for a filesystem implementation.
 * All filesystems use the same URL pattern: /{prefix}/{operation}
 */
function createFilesystemTests(
  name: string,
  prefix: string,
  options: {
    resetFn: () => Promise<void>;
    extraBody?: object;
  }
) {
  const { resetFn, extraBody = {} } = options;

  async function fsFetch(endpoint: string, body?: object): Promise<Response> {
    return fetch(`http://localhost:${TEST_PORT}${prefix}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...extraBody, ...body }),
    });
  }

  describe(name, () => {
    beforeEach(async () => {
      await resetFn();
    });

    describe('file operations', () => {
      it('should write and read file', async () => {
        const writeRes = await fsFetch('/writeFile', {
          path: '/hello.txt',
          content: 'Hello, World!',
        });
        const writeData = (await writeRes.json()) as any;
        expect(writeData.ok).toBe(true);
        expect(writeData.bytesWritten).toBe(13);

        const readRes = await fsFetch('/readFile', { path: '/hello.txt' });
        const readData = (await readRes.json()) as any;
        expect(readData.ok).toBe(true);
        expect(readData.content).toBe('Hello, World!');
      });

      it('should overwrite existing file', async () => {
        await fsFetch('/writeFile', { path: '/file.txt', content: 'First' });
        await fsFetch('/writeFile', { path: '/file.txt', content: 'Second' });

        const res = await fsFetch('/readFile', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('Second');
      });

      it('should append to file with append option', async () => {
        await fsFetch('/writeFile', { path: '/log.txt', content: 'Line 1\n' });
        await fsFetch('/writeFile', {
          path: '/log.txt',
          content: 'Line 2\n',
          options: { append: true },
        });

        const res = await fsFetch('/readFile', { path: '/log.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('Line 1\nLine 2\n');
      });

      it('should fail with exclusive flag if file exists', async () => {
        await fsFetch('/writeFile', { path: '/exists.txt', content: 'data' });
        const res = await fsFetch('/writeFile', {
          path: '/exists.txt',
          content: 'new',
          options: { exclusive: true },
        });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('EEXIST');
      });

      it('should return error for non-existent file', async () => {
        const res = await fsFetch('/readFile', { path: '/nonexistent.txt' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });

      it('should handle unicode content', async () => {
        const unicodeContent = '\u{1F600}\u{1F389}\u{2764}\u{FE0F}';
        await fsFetch('/writeFile', { path: '/unicode.txt', content: unicodeContent });

        const res = await fsFetch('/readFile', { path: '/unicode.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe(unicodeContent);
      });
    });

    describe('stat operations', () => {
      it('should stat file', async () => {
        await fsFetch('/writeFile', { path: '/file.txt', content: 'content' });

        const res = await fsFetch('/stat', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.stat.type).toBe('file');
        expect(data.stat.size).toBe(7);
      });

      it('should stat directory', async () => {
        await fsFetch('/mkdir', { path: '/dir' });

        const res = await fsFetch('/stat', { path: '/dir' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.stat.type).toBe('directory');
      });

      it('should return null for non-existent path', async () => {
        const res = await fsFetch('/stat', { path: '/nonexistent' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.stat).toBeNull();
      });

      it('should follow symlinks by default', async () => {
        await fsFetch('/writeFile', { path: '/target.txt', content: 'target' });
        await fsFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await fsFetch('/stat', { path: '/link.txt' });
        const data = (await res.json()) as any;
        expect(data.stat.type).toBe('file');
      });

      it('should not follow symlinks when option is false', async () => {
        await fsFetch('/writeFile', { path: '/target.txt', content: 'target' });
        await fsFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await fsFetch('/stat', {
          path: '/link.txt',
          options: { followSymlinks: false },
        });
        const data = (await res.json()) as any;
        expect(data.stat.type).toBe('symlink');
      });
    });

    describe('directory operations', () => {
      it('should create directory', async () => {
        const res = await fsFetch('/mkdir', { path: '/newdir' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);

        const statRes = await fsFetch('/stat', { path: '/newdir' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat.type).toBe('directory');
      });

      it('should create nested directories with recursive', async () => {
        const res = await fsFetch('/mkdir', { path: '/a/b/c', options: { recursive: true } });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);

        const statRes = await fsFetch('/stat', { path: '/a/b/c' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat.type).toBe('directory');
      });

      it('should throw ENOENT without recursive for nested path', async () => {
        const res = await fsFetch('/mkdir', { path: '/x/y/z' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });

      it('should list directory entries', async () => {
        await fsFetch('/mkdir', { path: '/mydir' });
        await fsFetch('/writeFile', { path: '/mydir/a.txt', content: '' });
        await fsFetch('/writeFile', { path: '/mydir/b.txt', content: '' });
        await fsFetch('/mkdir', { path: '/mydir/subdir' });

        const res = await fsFetch('/readdir', { path: '/mydir' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.entries).toHaveLength(3);
        expect(data.entries.map((e: any) => e.name)).toContain('a.txt');
        expect(data.entries.map((e: any) => e.name)).toContain('b.txt');
        expect(data.entries.map((e: any) => e.name)).toContain('subdir');
      });

      it('should list directory entries with types', async () => {
        await fsFetch('/mkdir', { path: '/mydir' });
        await fsFetch('/writeFile', { path: '/mydir/file.txt', content: '' });
        await fsFetch('/mkdir', { path: '/mydir/subdir' });

        const res = await fsFetch('/readdir', { path: '/mydir' });
        const data = (await res.json()) as any;
        const fileEntry = data.entries.find((e: any) => e.name === 'file.txt');
        const dirEntry = data.entries.find((e: any) => e.name === 'subdir');

        expect(fileEntry.type).toBe('file');
        expect(dirEntry.type).toBe('directory');
      });

      it('should list root directory', async () => {
        await fsFetch('/writeFile', { path: '/root-file.txt', content: 'data' });
        await fsFetch('/mkdir', { path: '/root-dir' });

        const res = await fsFetch('/readdir', { path: '/' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        const names = data.entries.map((e: any) => e.name);
        expect(names).toContain('root-file.txt');
        expect(names).toContain('root-dir');
      });
    });

    describe('remove operations', () => {
      it('should remove a file with rm', async () => {
        await fsFetch('/writeFile', { path: '/file.txt', content: 'data' });
        const rmRes = await fsFetch('/rm', { path: '/file.txt' });
        expect(((await rmRes.json()) as any).ok).toBe(true);

        const statRes = await fsFetch('/stat', { path: '/file.txt' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat).toBeNull();
      });

      it('should remove non-empty directory with recursive', async () => {
        await fsFetch('/mkdir', { path: '/dir' });
        await fsFetch('/writeFile', { path: '/dir/file.txt', content: 'data' });

        const rmRes = await fsFetch('/rm', { path: '/dir', options: { recursive: true } });
        expect(((await rmRes.json()) as any).ok).toBe(true);

        const statRes = await fsFetch('/stat', { path: '/dir' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat).toBeNull();
      });

      it('should not throw for non-existent path with force', async () => {
        const res = await fsFetch('/rm', { path: '/nonexistent', options: { force: true } });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
      });

      it('should throw ENOTEMPTY without recursive', async () => {
        await fsFetch('/mkdir', { path: '/dir' });
        await fsFetch('/writeFile', { path: '/dir/file.txt', content: 'data' });

        const res = await fsFetch('/rm', { path: '/dir' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOTEMPTY');
      });

      it('should unlink a file', async () => {
        await fsFetch('/writeFile', { path: '/file.txt', content: 'data' });
        const unlinkRes = await fsFetch('/unlink', { path: '/file.txt' });
        expect(((await unlinkRes.json()) as any).ok).toBe(true);

        const statRes = await fsFetch('/stat', { path: '/file.txt' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat).toBeNull();
      });

      it('should throw EISDIR when unlinking directory', async () => {
        await fsFetch('/mkdir', { path: '/dir' });
        const res = await fsFetch('/unlink', { path: '/dir' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('EISDIR');
      });
    });

    describe('symlink operations', () => {
      it('should create symlink', async () => {
        await fsFetch('/writeFile', { path: '/target.txt', content: 'target' });
        const res = await fsFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });
        expect(((await res.json()) as any).ok).toBe(true);

        const statRes = await fsFetch('/stat', {
          path: '/link.txt',
          options: { followSymlinks: false },
        });
        const statData = (await statRes.json()) as any;
        expect(statData.stat.type).toBe('symlink');
      });

      it('should read through symlink', async () => {
        await fsFetch('/writeFile', { path: '/target.txt', content: 'target content' });
        await fsFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await fsFetch('/readFile', { path: '/link.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('target content');
      });

      it('should readlink', async () => {
        await fsFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await fsFetch('/readlink', { path: '/link.txt' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.target).toBe('/target.txt');
      });
    });

    describe('rename operations', () => {
      it('should rename a file', async () => {
        await fsFetch('/writeFile', { path: '/old.txt', content: 'content' });
        const res = await fsFetch('/rename', { oldPath: '/old.txt', newPath: '/new.txt' });
        expect(((await res.json()) as any).ok).toBe(true);

        const oldStatRes = await fsFetch('/stat', { path: '/old.txt' });
        expect(((await oldStatRes.json()) as any).stat).toBeNull();

        const readRes = await fsFetch('/readFile', { path: '/new.txt' });
        expect(((await readRes.json()) as any).content).toBe('content');
      });

      it('should rename a directory with contents', async () => {
        await fsFetch('/mkdir', { path: '/olddir' });
        await fsFetch('/writeFile', { path: '/olddir/file.txt', content: 'data' });
        await fsFetch('/rename', { oldPath: '/olddir', newPath: '/newdir' });

        const oldStatRes = await fsFetch('/stat', { path: '/olddir' });
        expect(((await oldStatRes.json()) as any).stat).toBeNull();

        const readRes = await fsFetch('/readFile', { path: '/newdir/file.txt' });
        expect(((await readRes.json()) as any).content).toBe('data');
      });
    });

    describe('copy operations', () => {
      it('should copy a file', async () => {
        await fsFetch('/writeFile', { path: '/source.txt', content: 'copy me' });
        const res = await fsFetch('/cp', { src: '/source.txt', dest: '/dest.txt' });
        expect(((await res.json()) as any).ok).toBe(true);

        const srcRes = await fsFetch('/readFile', { path: '/source.txt' });
        expect(((await srcRes.json()) as any).content).toBe('copy me');

        const destRes = await fsFetch('/readFile', { path: '/dest.txt' });
        expect(((await destRes.json()) as any).content).toBe('copy me');
      });

      it('should copy a directory recursively', async () => {
        await fsFetch('/mkdir', { path: '/srcdir' });
        await fsFetch('/writeFile', { path: '/srcdir/a.txt', content: 'file a' });
        await fsFetch('/mkdir', { path: '/srcdir/sub' });
        await fsFetch('/writeFile', { path: '/srcdir/sub/b.txt', content: 'file b' });

        await fsFetch('/cp', { src: '/srcdir', dest: '/destdir', options: { recursive: true } });

        const aRes = await fsFetch('/readFile', { path: '/destdir/a.txt' });
        expect(((await aRes.json()) as any).content).toBe('file a');

        const bRes = await fsFetch('/readFile', { path: '/destdir/sub/b.txt' });
        expect(((await bRes.json()) as any).content).toBe('file b');
      });
    });

    describe('truncate operations', () => {
      it('should truncate file to specified length', async () => {
        await fsFetch('/writeFile', { path: '/file.txt', content: '1234567890' });
        await fsFetch('/truncate', { path: '/file.txt', length: 5 });

        const res = await fsFetch('/readFile', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('12345');
      });

      it('should truncate file to zero by default', async () => {
        await fsFetch('/writeFile', { path: '/file.txt', content: 'content' });
        await fsFetch('/truncate', { path: '/file.txt' });

        const res = await fsFetch('/readFile', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('');
      });
    });

    describe('access operations', () => {
      it('should succeed for existing file', async () => {
        await fsFetch('/writeFile', { path: '/exists.txt', content: 'data' });
        const res = await fsFetch('/access', { path: '/exists.txt' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
      });

      it('should fail for non-existent path', async () => {
        const res = await fsFetch('/access', { path: '/nonexistent' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });
    });

    describe('edge cases', () => {
      it('should handle deeply nested paths', async () => {
        await fsFetch('/mkdir', { path: '/a/b/c/d/e/f/g', options: { recursive: true } });
        await fsFetch('/writeFile', { path: '/a/b/c/d/e/f/g/file.txt', content: 'deep' });

        const res = await fsFetch('/readFile', { path: '/a/b/c/d/e/f/g/file.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('deep');
      });

      it('should handle special characters in filenames', async () => {
        const specialName = 'file with spaces & special!@#.txt';
        await fsFetch('/writeFile', { path: `/${specialName}`, content: 'special' });

        const res = await fsFetch('/readFile', { path: `/${specialName}` });
        const data = (await res.json()) as any;
        expect(data.content).toBe('special');
      });

      it('should persist data across multiple requests', async () => {
        await fsFetch('/writeFile', { path: '/persist.txt', content: 'first' });
        await fsFetch('/writeFile', {
          path: '/persist.txt',
          content: ' second',
          options: { append: true },
        });

        const res = await fsFetch('/readFile', { path: '/persist.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('first second');
      });
    });
  });
}

describe('worker-fs-mount integration tests', () => {
  beforeAll(async () => {
    wranglerProcess = spawn('npx', ['wrangler', 'dev', '--port', String(TEST_PORT)], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    wranglerProcess.stderr?.on('data', (data) => {
      const str = data.toString();
      if (str.includes('ERROR')) {
        console.error('Wrangler error:', str);
      }
    });

    await waitForReady(TEST_PORT);
  });

  afterAll(async () => {
    wranglerProcess?.kill();
    await new Promise((r) => setTimeout(r, 500));
  });

  // ============================================
  // Basic Setup Tests
  // ============================================

  describe('worker setup', () => {
    it('should setup mount using ctx.exports.MemoryFilesystemEntrypoint', async () => {
      const res = await workerFetch('/setup');
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.mounted).toBe('/mnt/mem');
    });

    it('should report mounted for paths under mount point', async () => {
      const res = await workerFetch('/isMounted', { path: '/mnt/mem/some/file.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.mounted).toBe(true);
    });

    it('should report not mounted for paths outside mount point', async () => {
      const res = await workerFetch('/isMounted', { path: '/other/path' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.mounted).toBe(false);
    });
  });

  // ============================================
  // withMounts Isolation Tests
  // ============================================

  describe('withMounts isolation', () => {
    it('should report being in mount context', async () => {
      const res = await workerFetch('/isInMountContext');
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.inContext).toBe(true);
    });

    it('should allow same mount path in different requests', async () => {
      const [res1, res2] = await Promise.all([
        workerFetch('/isolation/test', { id: 'req1', action: 'mount' }),
        workerFetch('/isolation/test', { id: 'req2', action: 'mount' }),
      ]);

      const data1 = (await res1.json()) as any;
      const data2 = (await res2.json()) as any;

      expect(data1.ok).toBe(true);
      expect(data1.mounted).toBe(true);
      expect(data2.ok).toBe(true);
      expect(data2.mounted).toBe(true);
    });

    it('should not leak mounts between requests', async () => {
      const res1 = await workerFetch('/isolation/test', { id: 'req1', action: 'mount' });
      const data1 = (await res1.json()) as any;
      expect(data1.mounted).toBe(true);

      const res2 = await workerFetch('/isolation/test', { id: 'req2', action: 'check' });
      const data2 = (await res2.json()) as any;
      expect(data2.isMounted).toBe(false);
    });
  });

  // ============================================
  // Full Integration: mount routing
  // ============================================

  describe('full integration: mount routing', () => {
    beforeEach(async () => {
      await workerFetch('/mem/reset');
    });

    it('should read file using full mount path', async () => {
      await workerFetch('/mem/writeFile', { path: '/test.txt', content: 'hello from mount' });

      const res = await workerFetch('/readFileFullPath', { fullPath: '/mnt/mem/test.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('hello from mount');
    });

    it('should handle deeply nested paths with full mount path', async () => {
      await workerFetch('/mem/mkdir', { path: '/a/b/c', options: { recursive: true } });
      await workerFetch('/mem/writeFile', { path: '/a/b/c/deep.txt', content: 'deep content' });

      const res = await workerFetch('/readFileFullPath', {
        fullPath: '/mnt/mem/a/b/c/deep.txt',
      });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('deep content');
    });
  });

  // ============================================
  // Filesystem Tests (shared across all implementations)
  // ============================================

  createFilesystemTests('Memory filesystem', '/mem', {
    resetFn: async () => {
      await workerFetch('/mem/reset');
    },
  });

  createFilesystemTests('DurableObject filesystem', '/do', {
    resetFn: async () => {
      await workerFetch('/do/reset', { doId: 'test-do' });
    },
  });

  createFilesystemTests('R2 filesystem', '/r2', {
    resetFn: async () => {
      await workerFetch('/r2/reset');
    },
  });

  // ============================================
  // Implementation-specific tests
  // ============================================

  describe('DurableObject filesystem - specific', () => {
    beforeEach(async () => {
      await workerFetch('/do/reset', { doId: 'test-do' });
    });

    describe('multiple DO instances', () => {
      it('should isolate data between different DO IDs', async () => {
        await workerFetch('/do/writeFile', {
          doId: 'do-1',
          path: '/file.txt',
          content: 'DO 1 data',
        });
        await workerFetch('/do/writeFile', {
          doId: 'do-2',
          path: '/file.txt',
          content: 'DO 2 data',
        });

        const res1 = await workerFetch('/do/readFile', { doId: 'do-1', path: '/file.txt' });
        expect(((await res1.json()) as any).content).toBe('DO 1 data');

        const res2 = await workerFetch('/do/readFile', { doId: 'do-2', path: '/file.txt' });
        expect(((await res2.json()) as any).content).toBe('DO 2 data');
      });
    });
  });
});
