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

    it('should find mount for paths under mount point', async () => {
      const res = await workerFetch('/findMount', { path: '/mnt/test/some/file.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.match).not.toBeNull();
      expect(data.match.mountPath).toBe('/mnt/test');
      expect(data.match.relativePath).toBe('/some/file.txt');
    });

    it('should not find mount for paths outside mount point', async () => {
      const res = await workerFetch('/findMount', { path: '/other/path' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.match).toBeNull();
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
  // Chunked Operations via Worker Requests
  // ============================================

  describe('chunked operations', () => {
    beforeEach(async () => {
      await workerFetch('/writeFile', { path: '/file.txt', content: '0123456789' });
    });

    it('should read chunk at offset', async () => {
      const res = await workerFetch('/read', { path: '/file.txt', offset: 3, length: 4 });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('3456');
    });

    it('should write at offset', async () => {
      await workerFetch('/write', { path: '/file.txt', content: 'XXX', offset: 3 });

      const res = await workerFetch('/readFile', { path: '/file.txt' });
      const data = (await res.json()) as any;
      expect(data.content).toBe('012XXX6789');
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
  // Full Integration: findMount + stub.readFile
  // ============================================

  describe('full integration: findMount and stub calls', () => {
    it('should read file via findMount pattern', async () => {
      // Write file first
      await workerFetch('/writeFile', { path: '/test.txt', content: 'hello from mount' });

      // Read via findMount (this simulates what fs-promises.ts does)
      const res = await workerFetch('/readFileViaFindMount', { fullPath: '/mnt/test/test.txt' });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('hello from mount');
    });

    it('should compute correct relative paths', async () => {
      await workerFetch('/mkdir', { path: '/a/b/c', options: { recursive: true } });
      await workerFetch('/writeFile', { path: '/a/b/c/deep.txt', content: 'deep content' });

      const res = await workerFetch('/readFileViaFindMount', {
        fullPath: '/mnt/test/a/b/c/deep.txt',
      });
      const data = (await res.json()) as any;
      expect(data.ok).toBe(true);
      expect(data.content).toBe('deep content');
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
