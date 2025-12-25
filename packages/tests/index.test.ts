import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

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
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function reset(): Promise<void> {
  await workerFetch('/reset');
}

describe('worker-fs-mount integration tests', () => {
  beforeAll(async () => {
    wranglerProcess = spawn('npx', ['wrangler', 'dev', '--port', String(TEST_PORT)], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Log errors for debugging
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
    // Wait a bit for cleanup
    await new Promise((r) => setTimeout(r, 500));
  });

  beforeEach(async () => {
    // Reset filesystem state and mounts before each test
    await reset();
  });

  // ============================================
  // Basic Setup Tests
  // ============================================

  describe('worker setup', () => {
    it('should setup mount using ctx.exports.MemoryFilesystem', async () => {
      const res = await workerFetch('/setup');
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.mounted).toBe('/mnt/test');
    });

    it('should report mounted for paths under mount point', async () => {
      const res = await workerFetch('/isMounted', { path: '/mnt/test/some/file.txt' });
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
  // File Operations via Worker Requests
  // ============================================

  describe('file operations', () => {
    it('should write and read file through worker', async () => {
      // Write file
      const writeRes = await workerFetch('/writeFile', {
        path: '/hello.txt',
        content: 'Hello, World!',
      });
      const writeData = (await writeRes.json()) as any;
      expect(writeData.ok).toBe(true);
      expect(writeData.bytesWritten).toBe(13);

      // Read file
      const readRes = await workerFetch('/readFile', { path: '/hello.txt' });
      const readData = (await readRes.json()) as any;
      expect(readData.ok).toBe(true);
      expect(readData.content).toBe('Hello, World!');
    });

    it('should overwrite existing file', async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: 'First' });
      await workerFetch('/writeFile', { path: '/file.txt', content: 'Second' });

      const res = await workerFetch('/readFile', { path: '/file.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('Second');
    });

    it('should append to file with append option', async () => {
      await workerFetch('/writeFile', { path: '/log.txt', content: 'Line 1\n' });
      await workerFetch('/writeFile', {
        path: '/log.txt',
        content: 'Line 2\n',
        options: { append: true },
      });

      const res = await workerFetch('/readFile', { path: '/log.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('Line 1\nLine 2\n');
    });

    it('should fail with exclusive flag if file exists', async () => {
      await workerFetch('/writeFile', { path: '/exists.txt', content: 'data' });
      const res = await workerFetch('/writeFile', {
        path: '/exists.txt',
        content: 'new',
        options: { exclusive: true },
      });
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toContain('EEXIST');
    });

    it('should return error for non-existent file', async () => {
      const res = await workerFetch('/readFile', { path: '/nonexistent.txt' });
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toContain('ENOENT');
    });

    it('should handle unicode content', async () => {
      const unicodeContent = '\u{1F600}\u{1F389}\u{2764}\u{FE0F}';
      await workerFetch('/writeFile', { path: '/unicode.txt', content: unicodeContent });

      const res = await workerFetch('/readFile', { path: '/unicode.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe(unicodeContent);
    });
  });

  // ============================================
  // Stat Operations via Worker Requests
  // ============================================

  describe('stat operations', () => {
    beforeEach(async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: 'content' });
      await workerFetch('/mkdir', { path: '/dir' });
    });

    it('should return stat for file', async () => {
      const res = await workerFetch('/stat', { path: '/file.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.stat.type).toBe('file');
      expect(data.stat.size).toBe(7);
    });

    it('should return stat for directory', async () => {
      const res = await workerFetch('/stat', { path: '/dir' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.stat.type).toBe('directory');
    });

    it('should return null for non-existent path', async () => {
      const res = await workerFetch('/stat', { path: '/nonexistent' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.stat).toBeNull();
    });

    it('should follow symlinks by default', async () => {
      await workerFetch('/writeFile', { path: '/target.txt', content: 'target' });
      await workerFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

      const res = await workerFetch('/stat', { path: '/link.txt' });
      const data = (await res.json()) as any;
      expect(data.stat.type).toBe('file');
    });

    it('should not follow symlinks when option is false', async () => {
      await workerFetch('/writeFile', { path: '/target.txt', content: 'target' });
      await workerFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

      const res = await workerFetch('/stat', {
        path: '/link.txt',
        options: { followSymlinks: false },
      });
      const data = (await res.json()) as any;
      expect(data.stat.type).toBe('symlink');
    });
  });

  // ============================================
  // Directory Operations via Worker Requests
  // ============================================

  describe('directory operations', () => {
    it('should create directory', async () => {
      const res = await workerFetch('/mkdir', { path: '/newdir' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);

      const statRes = await workerFetch('/stat', { path: '/newdir' });
      const statData = (await statRes.json()) as any;
      expect(statData.stat.type).toBe('directory');
    });

    it('should create nested directories with recursive', async () => {
      const res = await workerFetch('/mkdir', { path: '/a/b/c', options: { recursive: true } });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);

      const statRes = await workerFetch('/stat', { path: '/a/b/c' });
      const statData = (await statRes.json()) as any;
      expect(statData.stat.type).toBe('directory');
    });

    it('should throw if parent does not exist without recursive', async () => {
      const res = await workerFetch('/mkdir', { path: '/x/y/z' });
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toContain('ENOENT');
    });

    it('should list directory entries', async () => {
      await workerFetch('/mkdir', { path: '/mydir' });
      await workerFetch('/writeFile', { path: '/mydir/a.txt', content: '' });
      await workerFetch('/writeFile', { path: '/mydir/b.txt', content: '' });
      await workerFetch('/mkdir', { path: '/mydir/subdir' });

      const res = await workerFetch('/readdir', { path: '/mydir' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.entries).toHaveLength(3);
      expect(data.entries.map((e: any) => e.name)).toContain('a.txt');
      expect(data.entries.map((e: any) => e.name)).toContain('b.txt');
      expect(data.entries.map((e: any) => e.name)).toContain('subdir');
    });

    it('should list directory entries with types', async () => {
      await workerFetch('/mkdir', { path: '/mydir' });
      await workerFetch('/writeFile', { path: '/mydir/file.txt', content: '' });
      await workerFetch('/mkdir', { path: '/mydir/subdir' });

      const res = await workerFetch('/readdir', { path: '/mydir' });
      const data = (await res.json()) as any;
      const fileEntry = data.entries.find((e: any) => e.name === 'file.txt');
      const dirEntry = data.entries.find((e: any) => e.name === 'subdir');

      expect(fileEntry.type).toBe('file');
      expect(dirEntry.type).toBe('directory');
    });
  });

  // ============================================
  // Remove Operations via Worker Requests
  // ============================================

  describe('remove operations', () => {
    it('should remove a file with rm', async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: 'data' });
      const rmRes = await workerFetch('/rm', { path: '/file.txt' });
      expect(((await rmRes.json()) as any).ok).toBe(true);

      const statRes = await workerFetch('/stat', { path: '/file.txt' });
      const statData = (await statRes.json()) as any;
      expect(statData.stat).toBeNull();
    });

    it('should remove non-empty directory with recursive', async () => {
      await workerFetch('/mkdir', { path: '/dir' });
      await workerFetch('/writeFile', { path: '/dir/file.txt', content: 'data' });

      const rmRes = await workerFetch('/rm', { path: '/dir', options: { recursive: true } });
      expect(((await rmRes.json()) as any).ok).toBe(true);

      const statRes = await workerFetch('/stat', { path: '/dir' });
      const statData = (await statRes.json()) as any;
      expect(statData.stat).toBeNull();
    });

    it('should not throw for non-existent path with force', async () => {
      const res = await workerFetch('/rm', { path: '/nonexistent', options: { force: true } });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it('should throw for non-empty directory without recursive', async () => {
      await workerFetch('/mkdir', { path: '/dir' });
      await workerFetch('/writeFile', { path: '/dir/file.txt', content: 'data' });

      const res = await workerFetch('/rm', { path: '/dir' });
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toContain('ENOTEMPTY');
    });

    it('should unlink a file', async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: 'data' });
      const unlinkRes = await workerFetch('/unlink', { path: '/file.txt' });
      expect(((await unlinkRes.json()) as any).ok).toBe(true);

      const statRes = await workerFetch('/stat', { path: '/file.txt' });
      const statData = (await statRes.json()) as any;
      expect(statData.stat).toBeNull();
    });

    it('should throw EISDIR when unlinking directory', async () => {
      await workerFetch('/mkdir', { path: '/dir' });
      const res = await workerFetch('/unlink', { path: '/dir' });
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toContain('EISDIR');
    });
  });

  // ============================================
  // Symlink Operations via Worker Requests
  // ============================================

  describe('symlink operations', () => {
    it('should create symlink', async () => {
      await workerFetch('/writeFile', { path: '/target.txt', content: 'target' });
      const res = await workerFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });
      expect(((await res.json()) as any).ok).toBe(true);

      const statRes = await workerFetch('/stat', {
        path: '/link.txt',
        options: { followSymlinks: false },
      });
      const statData = (await statRes.json()) as any;
      expect(statData.stat.type).toBe('symlink');
    });

    it('should read through symlink', async () => {
      await workerFetch('/writeFile', { path: '/target.txt', content: 'target content' });
      await workerFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

      const res = await workerFetch('/readFile', { path: '/link.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('target content');
    });

    it('should readlink', async () => {
      await workerFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

      const res = await workerFetch('/readlink', { path: '/link.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.target).toBe('/target.txt');
    });
  });

  // ============================================
  // Rename Operations via Worker Requests
  // ============================================

  describe('rename operations', () => {
    it('should rename a file', async () => {
      await workerFetch('/writeFile', { path: '/old.txt', content: 'content' });
      const res = await workerFetch('/rename', { oldPath: '/old.txt', newPath: '/new.txt' });
      expect(((await res.json()) as any).ok).toBe(true);

      const oldStatRes = await workerFetch('/stat', { path: '/old.txt' });
      expect(((await oldStatRes.json()) as any).stat).toBeNull();

      const readRes = await workerFetch('/readFile', { path: '/new.txt' });
      expect(((await readRes.json()) as any).content).toBe('content');
    });

    it('should rename a directory', async () => {
      await workerFetch('/mkdir', { path: '/olddir' });
      await workerFetch('/writeFile', { path: '/olddir/file.txt', content: 'data' });
      await workerFetch('/rename', { oldPath: '/olddir', newPath: '/newdir' });

      const oldStatRes = await workerFetch('/stat', { path: '/olddir' });
      expect(((await oldStatRes.json()) as any).stat).toBeNull();

      const readRes = await workerFetch('/readFile', { path: '/newdir/file.txt' });
      expect(((await readRes.json()) as any).content).toBe('data');
    });
  });

  // ============================================
  // Copy Operations via Worker Requests
  // ============================================

  describe('copy operations', () => {
    it('should copy a file', async () => {
      await workerFetch('/writeFile', { path: '/source.txt', content: 'copy me' });
      const res = await workerFetch('/cp', { src: '/source.txt', dest: '/dest.txt' });
      expect(((await res.json()) as any).ok).toBe(true);

      const srcRes = await workerFetch('/readFile', { path: '/source.txt' });
      expect(((await srcRes.json()) as any).content).toBe('copy me');

      const destRes = await workerFetch('/readFile', { path: '/dest.txt' });
      expect(((await destRes.json()) as any).content).toBe('copy me');
    });

    it('should copy a directory recursively', async () => {
      await workerFetch('/mkdir', { path: '/srcdir' });
      await workerFetch('/writeFile', { path: '/srcdir/a.txt', content: 'file a' });
      await workerFetch('/mkdir', { path: '/srcdir/sub' });
      await workerFetch('/writeFile', { path: '/srcdir/sub/b.txt', content: 'file b' });

      await workerFetch('/cp', { src: '/srcdir', dest: '/destdir', options: { recursive: true } });

      const aRes = await workerFetch('/readFile', { path: '/destdir/a.txt' });
      expect(((await aRes.json()) as any).content).toBe('file a');

      const bRes = await workerFetch('/readFile', { path: '/destdir/sub/b.txt' });
      expect(((await bRes.json()) as any).content).toBe('file b');
    });
  });

  // ============================================
  // Truncate Operations via Worker Requests
  // ============================================

  describe('truncate operations', () => {
    it('should truncate file to specified length', async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: '1234567890' });
      await workerFetch('/truncate', { path: '/file.txt', length: 5 });

      const res = await workerFetch('/readFile', { path: '/file.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('12345');
    });

    it('should truncate file to zero by default', async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: 'content' });
      await workerFetch('/truncate', { path: '/file.txt' });

      const res = await workerFetch('/readFile', { path: '/file.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('');
    });
  });

  // ============================================
  // Access Operations via Worker Requests
  // ============================================

  describe('access operations', () => {
    it('should succeed for existing file', async () => {
      await workerFetch('/writeFile', { path: '/exists.txt', content: 'data' });
      const res = await workerFetch('/access', { path: '/exists.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
    });

    it('should fail for non-existent path', async () => {
      const res = await workerFetch('/access', { path: '/nonexistent' });
      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.error).toContain('ENOENT');
    });
  });

  // ============================================
  // Full Integration: mount routing
  // ============================================

  describe('full integration: mount routing', () => {
    it('should read file using full mount path', async () => {
      // Write file first
      await workerFetch('/writeFile', { path: '/test.txt', content: 'hello from mount' });

      // Read using full path (tests that fs module routes through mount)
      const res = await workerFetch('/readFileFullPath', { fullPath: '/mnt/test/test.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('hello from mount');
    });

    it('should handle deeply nested paths with full mount path', async () => {
      await workerFetch('/mkdir', { path: '/a/b/c', options: { recursive: true } });
      await workerFetch('/writeFile', { path: '/a/b/c/deep.txt', content: 'deep content' });

      const res = await workerFetch('/readFileFullPath', {
        fullPath: '/mnt/test/a/b/c/deep.txt',
      });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('deep content');
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
      // Both requests mount to the same path - should succeed due to isolation
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
      // First request mounts and checks
      const res1 = await workerFetch('/isolation/test', { id: 'req1', action: 'mount' });
      const data1 = (await res1.json()) as any;
      expect(data1.mounted).toBe(true);

      // Second request should NOT see the first request's mount
      // (it's in its own isolated context)
      const res2 = await workerFetch('/isolation/test', { id: 'req2', action: 'check' });
      const data2 = (await res2.json()) as any;
      // The mount from req1 should NOT be visible in req2's context
      expect(data2.isMounted).toBe(false);
    });
  });

  // ============================================
  // DurableObject Filesystem Tests
  // ============================================

  describe('DurableObject filesystem', () => {
    // Helper for DO requests
    async function doFetch(endpoint: string, body?: object): Promise<Response> {
      return fetch(`http://localhost:${TEST_PORT}/do${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : JSON.stringify({}),
      });
    }

    async function doReset(doId = 'test-do'): Promise<void> {
      await doFetch('/reset', { doId });
    }

    beforeEach(async () => {
      await doReset();
    });

    describe('file operations', () => {
      it('should write and read file', async () => {
        const writeRes = await doFetch('/writeFile', {
          path: '/hello.txt',
          content: 'Hello from DO!',
        });
        const writeData = (await writeRes.json()) as any;
        expect(writeData.ok).toBe(true);

        const readRes = await doFetch('/readFile', { path: '/hello.txt' });
        const readData = (await readRes.json()) as any;
        expect(readData.ok).toBe(true);
        expect(readData.content).toBe('Hello from DO!');
      });

      it('should persist data across requests', async () => {
        await doFetch('/writeFile', { path: '/persist.txt', content: 'first' });
        await doFetch('/writeFile', {
          path: '/persist.txt',
          content: ' second',
          options: { append: true },
        });

        const res = await doFetch('/readFile', { path: '/persist.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('first second');
      });

      it('should return error for non-existent file', async () => {
        const res = await doFetch('/readFile', { path: '/nonexistent.txt' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });

      it('should fail with exclusive flag if file exists', async () => {
        await doFetch('/writeFile', { path: '/exists.txt', content: 'data' });
        const res = await doFetch('/writeFile', {
          path: '/exists.txt',
          content: 'new',
          options: { exclusive: true },
        });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('EEXIST');
      });
    });

    describe('directory operations', () => {
      it('should create and list directory', async () => {
        await doFetch('/mkdir', { path: '/mydir' });
        await doFetch('/writeFile', { path: '/mydir/file.txt', content: 'data' });

        const res = await doFetch('/readdir', { path: '/mydir' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.entries).toHaveLength(1);
        expect(data.entries[0].name).toBe('file.txt');
      });

      it('should create nested directories with recursive', async () => {
        const res = await doFetch('/mkdir', { path: '/a/b/c', options: { recursive: true } });
        expect(((await res.json()) as any).ok).toBe(true);

        const statRes = await doFetch('/stat', { path: '/a/b/c' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat.type).toBe('directory');
      });

      it('should throw ENOENT without recursive for nested path', async () => {
        const res = await doFetch('/mkdir', { path: '/x/y/z' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });
    });

    describe('stat operations', () => {
      it('should stat file', async () => {
        await doFetch('/writeFile', { path: '/file.txt', content: 'content' });

        const res = await doFetch('/stat', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.stat.type).toBe('file');
        expect(data.stat.size).toBe(7);
      });

      it('should stat directory', async () => {
        await doFetch('/mkdir', { path: '/dir' });

        const res = await doFetch('/stat', { path: '/dir' });
        const data = (await res.json()) as any;
        expect(data.stat.type).toBe('directory');
      });

      it('should return null for non-existent path', async () => {
        const res = await doFetch('/stat', { path: '/nonexistent' });
        const data = (await res.json()) as any;
        expect(data.stat).toBeNull();
      });
    });

    describe('remove operations', () => {
      it('should remove file', async () => {
        await doFetch('/writeFile', { path: '/file.txt', content: 'data' });
        await doFetch('/rm', { path: '/file.txt' });

        const statRes = await doFetch('/stat', { path: '/file.txt' });
        expect(((await statRes.json()) as any).stat).toBeNull();
      });

      it('should remove directory recursively', async () => {
        await doFetch('/mkdir', { path: '/dir' });
        await doFetch('/writeFile', { path: '/dir/file.txt', content: 'data' });
        await doFetch('/rm', { path: '/dir', options: { recursive: true } });

        const statRes = await doFetch('/stat', { path: '/dir' });
        expect(((await statRes.json()) as any).stat).toBeNull();
      });

      it('should throw ENOTEMPTY without recursive', async () => {
        await doFetch('/mkdir', { path: '/dir' });
        await doFetch('/writeFile', { path: '/dir/file.txt', content: 'data' });

        const res = await doFetch('/rm', { path: '/dir' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOTEMPTY');
      });

      it('should unlink file', async () => {
        await doFetch('/writeFile', { path: '/file.txt', content: 'data' });
        await doFetch('/unlink', { path: '/file.txt' });

        const statRes = await doFetch('/stat', { path: '/file.txt' });
        expect(((await statRes.json()) as any).stat).toBeNull();
      });

      it('should throw EISDIR when unlinking directory', async () => {
        await doFetch('/mkdir', { path: '/dir' });
        const res = await doFetch('/unlink', { path: '/dir' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('EISDIR');
      });
    });

    describe('rename operations', () => {
      it('should rename file', async () => {
        await doFetch('/writeFile', { path: '/old.txt', content: 'content' });
        await doFetch('/rename', { oldPath: '/old.txt', newPath: '/new.txt' });

        const oldStatRes = await doFetch('/stat', { path: '/old.txt' });
        expect(((await oldStatRes.json()) as any).stat).toBeNull();

        const readRes = await doFetch('/readFile', { path: '/new.txt' });
        expect(((await readRes.json()) as any).content).toBe('content');
      });

      it('should rename directory with contents', async () => {
        await doFetch('/mkdir', { path: '/olddir' });
        await doFetch('/writeFile', { path: '/olddir/file.txt', content: 'data' });
        await doFetch('/rename', { oldPath: '/olddir', newPath: '/newdir' });

        const readRes = await doFetch('/readFile', { path: '/newdir/file.txt' });
        expect(((await readRes.json()) as any).content).toBe('data');
      });
    });

    describe('copy operations', () => {
      it('should copy file', async () => {
        await doFetch('/writeFile', { path: '/source.txt', content: 'copy me' });
        await doFetch('/cp', { src: '/source.txt', dest: '/dest.txt' });

        const srcRes = await doFetch('/readFile', { path: '/source.txt' });
        const destRes = await doFetch('/readFile', { path: '/dest.txt' });

        expect(((await srcRes.json()) as any).content).toBe('copy me');
        expect(((await destRes.json()) as any).content).toBe('copy me');
      });

      it('should copy directory recursively', async () => {
        await doFetch('/mkdir', { path: '/srcdir' });
        await doFetch('/writeFile', { path: '/srcdir/a.txt', content: 'file a' });
        await doFetch('/mkdir', { path: '/srcdir/sub' });
        await doFetch('/writeFile', { path: '/srcdir/sub/b.txt', content: 'file b' });

        await doFetch('/cp', { src: '/srcdir', dest: '/destdir', options: { recursive: true } });

        const aRes = await doFetch('/readFile', { path: '/destdir/a.txt' });
        const bRes = await doFetch('/readFile', { path: '/destdir/sub/b.txt' });

        expect(((await aRes.json()) as any).content).toBe('file a');
        expect(((await bRes.json()) as any).content).toBe('file b');
      });
    });

    describe('symlink operations', () => {
      it('should create and read symlink', async () => {
        await doFetch('/writeFile', { path: '/target.txt', content: 'target' });
        await doFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const statRes = await doFetch('/stat', {
          path: '/link.txt',
          options: { followSymlinks: false },
        });
        expect(((await statRes.json()) as any).stat.type).toBe('symlink');
      });

      it('should read through symlink', async () => {
        await doFetch('/writeFile', { path: '/target.txt', content: 'symlink content' });
        await doFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await doFetch('/readFile', { path: '/link.txt' });
        expect(((await res.json()) as any).content).toBe('symlink content');
      });

      it('should readlink', async () => {
        await doFetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await doFetch('/readlink', { path: '/link.txt' });
        expect(((await res.json()) as any).target).toBe('/target.txt');
      });
    });

    describe('truncate operations', () => {
      it('should truncate file', async () => {
        await doFetch('/writeFile', { path: '/file.txt', content: '1234567890' });
        await doFetch('/truncate', { path: '/file.txt', length: 5 });

        const res = await doFetch('/readFile', { path: '/file.txt' });
        expect(((await res.json()) as any).content).toBe('12345');
      });
    });

    describe('access operations', () => {
      it('should succeed for existing file', async () => {
        await doFetch('/writeFile', { path: '/exists.txt', content: 'data' });
        const res = await doFetch('/access', { path: '/exists.txt' });
        expect(((await res.json()) as any).ok).toBe(true);
      });

      it('should fail for non-existent path', async () => {
        const res = await doFetch('/access', { path: '/nonexistent' });
        expect(res.status).toBe(500);
        expect(((await res.json()) as any).error).toContain('ENOENT');
      });
    });

    describe('multiple DO instances', () => {
      it('should isolate data between different DO IDs', async () => {
        // Write to first DO
        await doFetch('/writeFile', { doId: 'do-1', path: '/file.txt', content: 'DO 1 data' });

        // Write to second DO
        await doFetch('/writeFile', { doId: 'do-2', path: '/file.txt', content: 'DO 2 data' });

        // Read from first DO
        const res1 = await doFetch('/readFile', { doId: 'do-1', path: '/file.txt' });
        expect(((await res1.json()) as any).content).toBe('DO 1 data');

        // Read from second DO
        const res2 = await doFetch('/readFile', { doId: 'do-2', path: '/file.txt' });
        expect(((await res2.json()) as any).content).toBe('DO 2 data');
      });
    });
  });

  // ============================================
  // R2 Filesystem Tests
  // ============================================

  describe('R2 filesystem', () => {
    // Helper for R2 requests
    async function r2Fetch(endpoint: string, body?: object): Promise<Response> {
      return fetch(`http://localhost:${TEST_PORT}/r2${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : JSON.stringify({}),
      });
    }

    async function r2Reset(): Promise<void> {
      await r2Fetch('/reset', {});
    }

    beforeEach(async () => {
      await r2Reset();
    });

    describe('file operations', () => {
      it('should write and read file', async () => {
        const writeRes = await r2Fetch('/writeFile', {
          path: '/hello.txt',
          content: 'Hello from R2!',
        });
        const writeData = (await writeRes.json()) as any;
        expect(writeData.ok).toBe(true);

        const readRes = await r2Fetch('/readFile', { path: '/hello.txt' });
        const readData = (await readRes.json()) as any;
        expect(readData.ok).toBe(true);
        expect(readData.content).toBe('Hello from R2!');
      });

      it('should overwrite existing file', async () => {
        await r2Fetch('/writeFile', { path: '/file.txt', content: 'First' });
        await r2Fetch('/writeFile', { path: '/file.txt', content: 'Second' });

        const res = await r2Fetch('/readFile', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('Second');
      });

      it('should append to file with append option', async () => {
        await r2Fetch('/writeFile', { path: '/log.txt', content: 'Line 1\n' });
        await r2Fetch('/writeFile', {
          path: '/log.txt',
          content: 'Line 2\n',
          options: { append: true },
        });

        const res = await r2Fetch('/readFile', { path: '/log.txt' });
        const data = (await res.json()) as any;
        expect(data.content).toBe('Line 1\nLine 2\n');
      });

      it('should fail with exclusive flag if file exists', async () => {
        await r2Fetch('/writeFile', { path: '/exists.txt', content: 'data' });
        const res = await r2Fetch('/writeFile', {
          path: '/exists.txt',
          content: 'new',
          options: { exclusive: true },
        });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('EEXIST');
      });

      it('should return error for non-existent file', async () => {
        const res = await r2Fetch('/readFile', { path: '/nonexistent.txt' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });
    });

    describe('directory operations', () => {
      it('should create and list directory', async () => {
        await r2Fetch('/mkdir', { path: '/mydir' });
        await r2Fetch('/writeFile', { path: '/mydir/file.txt', content: 'data' });

        const res = await r2Fetch('/readdir', { path: '/mydir' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        expect(data.entries).toHaveLength(1);
        expect(data.entries[0].name).toBe('file.txt');
      });

      it('should create nested directories with recursive', async () => {
        const res = await r2Fetch('/mkdir', { path: '/a/b/c', options: { recursive: true } });
        expect(((await res.json()) as any).ok).toBe(true);

        const statRes = await r2Fetch('/stat', { path: '/a/b/c' });
        const statData = (await statRes.json()) as any;
        expect(statData.stat.type).toBe('directory');
      });

      it('should throw ENOENT without recursive for nested path', async () => {
        const res = await r2Fetch('/mkdir', { path: '/x/y/z' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOENT');
      });

      it('should list root directory', async () => {
        await r2Fetch('/writeFile', { path: '/root-file.txt', content: 'data' });
        await r2Fetch('/mkdir', { path: '/root-dir' });

        const res = await r2Fetch('/readdir', { path: '/' });
        const data = (await res.json()) as any;
        expect(data.ok).toBe(true);
        const names = data.entries.map((e: any) => e.name);
        expect(names).toContain('root-file.txt');
        expect(names).toContain('root-dir');
      });
    });

    describe('stat operations', () => {
      it('should stat file', async () => {
        await r2Fetch('/writeFile', { path: '/file.txt', content: 'content' });

        const res = await r2Fetch('/stat', { path: '/file.txt' });
        const data = (await res.json()) as any;
        expect(data.stat.type).toBe('file');
        expect(data.stat.size).toBe(7);
      });

      it('should stat directory', async () => {
        await r2Fetch('/mkdir', { path: '/dir' });

        const res = await r2Fetch('/stat', { path: '/dir' });
        const data = (await res.json()) as any;
        expect(data.stat.type).toBe('directory');
      });

      it('should return null for non-existent path', async () => {
        const res = await r2Fetch('/stat', { path: '/nonexistent' });
        const data = (await res.json()) as any;
        expect(data.stat).toBeNull();
      });
    });

    describe('remove operations', () => {
      it('should remove file', async () => {
        await r2Fetch('/writeFile', { path: '/file.txt', content: 'data' });
        await r2Fetch('/rm', { path: '/file.txt' });

        const statRes = await r2Fetch('/stat', { path: '/file.txt' });
        expect(((await statRes.json()) as any).stat).toBeNull();
      });

      it('should remove directory recursively', async () => {
        await r2Fetch('/mkdir', { path: '/dir' });
        await r2Fetch('/writeFile', { path: '/dir/file.txt', content: 'data' });
        await r2Fetch('/rm', { path: '/dir', options: { recursive: true } });

        const statRes = await r2Fetch('/stat', { path: '/dir' });
        expect(((await statRes.json()) as any).stat).toBeNull();
      });

      it('should throw ENOTEMPTY without recursive', async () => {
        await r2Fetch('/mkdir', { path: '/dir' });
        await r2Fetch('/writeFile', { path: '/dir/file.txt', content: 'data' });

        const res = await r2Fetch('/rm', { path: '/dir' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('ENOTEMPTY');
      });

      it('should unlink file', async () => {
        await r2Fetch('/writeFile', { path: '/file.txt', content: 'data' });
        await r2Fetch('/unlink', { path: '/file.txt' });

        const statRes = await r2Fetch('/stat', { path: '/file.txt' });
        expect(((await statRes.json()) as any).stat).toBeNull();
      });

      it('should throw EISDIR when unlinking directory', async () => {
        await r2Fetch('/mkdir', { path: '/dir' });
        const res = await r2Fetch('/unlink', { path: '/dir' });
        expect(res.status).toBe(500);
        const data = (await res.json()) as any;
        expect(data.error).toContain('EISDIR');
      });
    });

    describe('rename operations', () => {
      it('should rename file', async () => {
        await r2Fetch('/writeFile', { path: '/old.txt', content: 'content' });
        await r2Fetch('/rename', { oldPath: '/old.txt', newPath: '/new.txt' });

        const oldStatRes = await r2Fetch('/stat', { path: '/old.txt' });
        expect(((await oldStatRes.json()) as any).stat).toBeNull();

        const readRes = await r2Fetch('/readFile', { path: '/new.txt' });
        expect(((await readRes.json()) as any).content).toBe('content');
      });

      it('should rename directory with contents', async () => {
        await r2Fetch('/mkdir', { path: '/olddir' });
        await r2Fetch('/writeFile', { path: '/olddir/file.txt', content: 'data' });
        await r2Fetch('/rename', { oldPath: '/olddir', newPath: '/newdir' });

        const readRes = await r2Fetch('/readFile', { path: '/newdir/file.txt' });
        expect(((await readRes.json()) as any).content).toBe('data');
      });
    });

    describe('copy operations', () => {
      it('should copy file', async () => {
        await r2Fetch('/writeFile', { path: '/source.txt', content: 'copy me' });
        await r2Fetch('/cp', { src: '/source.txt', dest: '/dest.txt' });

        const srcRes = await r2Fetch('/readFile', { path: '/source.txt' });
        const destRes = await r2Fetch('/readFile', { path: '/dest.txt' });

        expect(((await srcRes.json()) as any).content).toBe('copy me');
        expect(((await destRes.json()) as any).content).toBe('copy me');
      });

      it('should copy directory recursively', async () => {
        await r2Fetch('/mkdir', { path: '/srcdir' });
        await r2Fetch('/writeFile', { path: '/srcdir/a.txt', content: 'file a' });
        await r2Fetch('/mkdir', { path: '/srcdir/sub' });
        await r2Fetch('/writeFile', { path: '/srcdir/sub/b.txt', content: 'file b' });

        await r2Fetch('/cp', { src: '/srcdir', dest: '/destdir', options: { recursive: true } });

        const aRes = await r2Fetch('/readFile', { path: '/destdir/a.txt' });
        const bRes = await r2Fetch('/readFile', { path: '/destdir/sub/b.txt' });

        expect(((await aRes.json()) as any).content).toBe('file a');
        expect(((await bRes.json()) as any).content).toBe('file b');
      });
    });

    describe('symlink operations', () => {
      it('should create and read symlink', async () => {
        await r2Fetch('/writeFile', { path: '/target.txt', content: 'target' });
        await r2Fetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const statRes = await r2Fetch('/stat', {
          path: '/link.txt',
          options: { followSymlinks: false },
        });
        expect(((await statRes.json()) as any).stat.type).toBe('symlink');
      });

      it('should read through symlink', async () => {
        await r2Fetch('/writeFile', { path: '/target.txt', content: 'symlink content' });
        await r2Fetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await r2Fetch('/readFile', { path: '/link.txt' });
        expect(((await res.json()) as any).content).toBe('symlink content');
      });

      it('should readlink', async () => {
        await r2Fetch('/symlink', { linkPath: '/link.txt', targetPath: '/target.txt' });

        const res = await r2Fetch('/readlink', { path: '/link.txt' });
        expect(((await res.json()) as any).target).toBe('/target.txt');
      });
    });

    describe('truncate operations', () => {
      it('should truncate file', async () => {
        await r2Fetch('/writeFile', { path: '/file.txt', content: '1234567890' });
        await r2Fetch('/truncate', { path: '/file.txt', length: 5 });

        const res = await r2Fetch('/readFile', { path: '/file.txt' });
        expect(((await res.json()) as any).content).toBe('12345');
      });
    });

    describe('access operations', () => {
      it('should succeed for existing file', async () => {
        await r2Fetch('/writeFile', { path: '/exists.txt', content: 'data' });
        const res = await r2Fetch('/access', { path: '/exists.txt' });
        expect(((await res.json()) as any).ok).toBe(true);
      });

      it('should fail for non-existent path', async () => {
        const res = await r2Fetch('/access', { path: '/nonexistent' });
        expect(res.status).toBe(500);
        expect(((await res.json()) as any).error).toContain('ENOENT');
      });
    });

    describe('edge cases', () => {
      it('should handle deeply nested paths', async () => {
        await r2Fetch('/mkdir', { path: '/a/b/c/d/e', options: { recursive: true } });
        await r2Fetch('/writeFile', { path: '/a/b/c/d/e/deep.txt', content: 'deep content' });

        const res = await r2Fetch('/readFile', { path: '/a/b/c/d/e/deep.txt' });
        expect(((await res.json()) as any).content).toBe('deep content');
      });

      it('should handle unicode content', async () => {
        const unicodeContent = '\u{1F600}\u{1F389}\u{2764}\u{FE0F}';
        await r2Fetch('/writeFile', { path: '/unicode.txt', content: unicodeContent });

        const res = await r2Fetch('/readFile', { path: '/unicode.txt' });
        expect(((await res.json()) as any).content).toBe(unicodeContent);
      });
    });
  });

  // ============================================
  // Edge Cases
  // ============================================

  describe('edge cases', () => {
    it('should handle root directory listing', async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: '' });
      await workerFetch('/mkdir', { path: '/dir' });

      const res = await workerFetch('/readdir', { path: '/' });
      const data = (await res.json()) as any;
      expect(data.entries.some((e: any) => e.name === 'file.txt')).toBe(true);
      expect(data.entries.some((e: any) => e.name === 'dir')).toBe(true);
    });

    it('should handle deeply nested paths', async () => {
      await workerFetch('/mkdir', { path: '/a/b/c/d/e/f/g', options: { recursive: true } });
      await workerFetch('/writeFile', { path: '/a/b/c/d/e/f/g/file.txt', content: 'deep' });

      const res = await workerFetch('/readFile', { path: '/a/b/c/d/e/f/g/file.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('deep');
    });

    it('should handle special characters in filenames', async () => {
      const specialName = 'file with spaces & special!@#.txt';
      await workerFetch('/writeFile', { path: `/${specialName}`, content: 'special' });

      const res = await workerFetch('/readFile', { path: `/${specialName}` });
      const data = (await res.json()) as any;
      expect(data.content).toBe('special');
    });

    it('should persist data across multiple requests', async () => {
      // Write in one request
      await workerFetch('/writeFile', { path: '/persist.txt', content: 'first' });

      // Append in another request
      await workerFetch('/writeFile', {
        path: '/persist.txt',
        content: ' second',
        options: { append: true },
      });

      // Read in third request
      const res = await workerFetch('/readFile', { path: '/persist.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('first second');
    });
  });
});
