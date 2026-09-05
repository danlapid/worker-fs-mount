import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
// Exercise Wrangler's node:fs alias, including its default export.
import fs from 'node:fs';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { type DurableObjectFilesystem, LocalDOFilesystem } from 'durable-object-fs';
import { mount, unmount, withMounts } from 'worker-fs-mount';
import { createEmscriptenModule } from 'worker-fs-mount/emscripten';

const PAGE = 64 * 1024;
const LARGE = 3 * 1024 * 1024 + 123;
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => i % 251);

export async function descriptorScenario(
  scenario: string,
  storage: DurableObjectStorage,
  remote: DurableObjectFilesystem
): Promise<void> {
  const local = new LocalDOFilesystem(storage);
  await withMounts(async () => {
    mount('/volume', local);
    const path = '/volume/file';

    switch (scenario) {
      case 'module-scope': {
        const module = await createEmscriptenModule('/module', local, async (options) => {
          assert.equal(options.cwd, '/module');
          await Promise.resolve();
          const fd = options.nodeFs.openSync('/module/module.txt', 'w+');
          options.nodeFs.writeSync(fd, 'module');
          return {
            read: () => {
              const bytes = Buffer.alloc(6);
              options.nodeFs.readSync(fd, bytes, 0, 6, 0);
              return bytes.toString();
            },
            close: () => options.nodeFs.closeSync(fd),
          };
        });
        assert.throws(() => module.instance.read(), { code: 'EBADF' });
        assert.equal(
          module.run(() => module.instance.read()),
          'module'
        );
        await Promise.resolve();
        assert.equal(
          module.run(() => module.instance.read()),
          'module'
        );
        module.run(() => module.instance.close());
        break;
      }
      case 'descriptors': {
        assert.throws(() => fs.openSync(path, 'r'), { code: 'ENOENT' });
        const fd = fs.openSync(new URL('file:///volume/file'), 'wx+', 0o640);
        assert.equal(fs.fstatSync(fd).mode & 0o170000, 0o100000);
        assert.equal(fs.fstatSync(fd).mode & 0o777, 0o640);
        assert.equal(fs.fstatSync(fd, { bigint: true }).size, 0n);
        assert.throws(() => fs.openSync(path, 'wx'), { code: 'EEXIST' });
        assert.equal(fs.writeSync(fd, 'abcdef'), 6);
        assert.equal(fs.writeSync(fd, 'XY', 1), 2);
        fs.writeFileSync(fd, 'g');
        fs.appendFileSync(fd, 'h');
        assert.equal(fs.readFileSync(path, 'utf8'), 'aXYdefgh');
        const bytes = new Uint8Array(12).fill(42);
        const view = new DataView(bytes.buffer, 2, 8);
        assert.equal(fs.readSync(fd, view, { offset: 1, length: 4, position: 0 }), 4);
        assert.deepEqual([...bytes.slice(3, 7)], [...Buffer.from('aXYd')]);
        assert.equal(bytes[2], 42);
        assert.equal(bytes[7], 42);
        assert.equal(fs.readSync(fd, bytes), 0); // Positional reads do not move the cursor.
        fs.fsyncSync(fd);
        fs.fdatasyncSync(fd);
        fs.fchmodSync(fd, '600');
        assert.equal(fs.statSync(path).mode & 0o777, 0o600);
        assert.throws(() => fs.readSync(fd, bytes, -1, 1, 0), { code: 'ERR_OUT_OF_RANGE' });
        assert.throws(() => fs.writeSync(fd, bytes, 0, 13, 0), { code: 'ERR_OUT_OF_RANGE' });
        assert.throws(() => fs.ftruncateSync(fd, -1), { code: 'ERR_OUT_OF_RANGE' });
        fs.closeSync(fd);
        assert.throws(() => fs.closeSync(fd), { code: 'EBADF' });
        assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
        assert.throws(() => fs.writeSync(fd, ''), { code: 'EBADF' });
        const readOnly = fs.openSync(Buffer.from(path), 'r');
        assert.throws(() => fs.writeSync(readOnly, 'x'), { code: 'EBADF' });
        assert.throws(() => fs.ftruncateSync(readOnly, 0), { code: 'EBADF' });
        assert.equal(fs.readSync(readOnly, bytes, 0, 2, null), 2);
        assert.equal(fs.readFileSync(readOnly, 'utf8'), 'Ydefgh');
        fs.closeSync(readOnly);
        const writeOnly = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_APPEND);
        assert.throws(() => fs.readSync(writeOnly, bytes), { code: 'EBADF' });
        assert.equal(fs.writeSync(writeOnly, 'é', 0), 2); // O_APPEND overrides a position.
        fs.closeSync(writeOnly);
        assert.equal(fs.readFileSync(path, 'utf8'), 'aXYdefghé');
        const truncated = fs.openSync(path, 'w');
        assert.equal(fs.fstatSync(truncated).size, 0);
        fs.closeSync(truncated);
        const dir = fs.openSync('/volume', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
        assert.equal(fs.fstatSync(dir).mode & 0o170000, 0o040000);
        assert.throws(() => fs.readSync(dir, bytes), { code: 'EISDIR' });
        fs.closeSync(dir);
        assert.throws(() => fs.openSync('/volume', 'w'), { code: 'EISDIR' });
        assert.throws(() => fs.openSync(path, fs.constants.O_DIRECTORY), { code: 'ENOTDIR' });
        fs.symlinkSync('/file', '/volume/link');
        assert.equal(fs.lstatSync('/volume/link').mode & 0o170000, 0o120000);
        assert.throws(() => fs.openSync('/volume/link', fs.constants.O_NOFOLLOW), {
          code: 'ELOOP',
        });
        const link = fs.openSync('/volume/link', 'r');
        assert.equal(fs.fstatSync(link).ino, fs.statSync(path).ino);
        fs.closeSync(link);
        fs.mkdirSync('/volume/directory');
        fs.writeFileSync('/volume/directory/child', 'child');
        fs.symlinkSync('/directory', '/volume/dir-link');
        assert.equal(fs.lstatSync('/volume/dir-link/child').isFile(), true);
        const throughParent = fs.openSync('/volume/dir-link/child', 'r');
        assert.equal(fs.readFileSync(throughParent, 'utf8'), 'child');
        fs.closeSync(throughParent);
        assert.throws(() => fs.openSync(path, 'invalid'), { code: 'ERR_INVALID_ARG_VALUE' });
        assert.throws(() => fs.openSync(path, 'r', '600x'), { code: 'ERR_INVALID_ARG_VALUE' });
        assert.throws(() => fs.openSync('/volume/file/child', 'w'), { code: 'ENOTDIR' });
        const native = fs.openSync('/tmp/descriptor-test', 'w+');
        fs.writeSync(native, 'native');
        assert.equal(fs.fstatSync(native).size, 6);
        fs.closeSync(native);
        fs.unlinkSync('/tmp/descriptor-test');
        break;
      }
      case 'scopes': {
        const fd = fs.openSync(path, 'w+');
        fs.writeSync(fd, 'original');
        await withMounts(async () => {
          mount('/volume', local);
          assert.throws(() => fs.fstatSync(fd), { code: 'EBADF' });
          const nested = fs.openSync(path, 'r');
          await Promise.resolve();
          assert.equal(fs.readFileSync(nested, 'utf8'), 'original');
          fs.closeSync(nested);
        });
        await Promise.all(
          [0, 1].map(() =>
            withMounts(async () => {
              mount('/volume', local);
              const own = fs.openSync(path, 'r');
              await Promise.resolve();
              assert.throws(() => fs.closeSync(fd), { code: 'EBADF' });
              assert.equal(fs.readFileSync(own, 'utf8'), 'original');
              fs.closeSync(own);
            })
          )
        );
        unmount('/volume');
        mount('/volume', remote); // An async-only replacement must not redirect an open fd.
        assert.throws(() => fs.openSync(path, 'r'), { code: 'ENOSYS' });
        const bytes = Buffer.alloc(8);
        fs.readSync(fd, bytes, 0, 8, 0);
        assert.equal(bytes.toString(), 'original');
        fs.closeSync(fd);
        break;
      }
      case 'lifetime': {
        fs.rmSync('/volume/missing/child', { recursive: true, force: true });
        fs.writeFileSync(path, 'source');
        fs.writeFileSync('/volume/target', 'target');
        const fd = fs.openSync(path, 'r+');
        const second = fs.openSync(path, 'r+');
        const replaced = fs.openSync('/volume/target', 'r+');
        const ino = fs.fstatSync(fd).ino;
        fs.renameSync(path, '/volume/target');
        assert.equal(fs.statSync('/volume/target').ino, ino);
        assert.equal(fs.readFileSync(replaced, 'utf8'), 'target');
        assert.equal(fs.fstatSync(replaced).nlink, 0);
        fs.unlinkSync('/volume/target');
        fs.writeFileSync('/volume/target', 'new inode');
        assert.notEqual(fs.statSync('/volume/target').ino, ino);
        fs.writeSync(fd, 'X', 0);
        assert.equal(fs.readFileSync(second, 'utf8'), 'Xource');
        assert.equal(fs.fstatSync(fd).nlink, 0);
        fs.ftruncateSync(fd, 3);
        fs.ftruncateSync(fd, 5);
        const bytes = Buffer.alloc(5);
        fs.readSync(second, bytes, 0, 5, 0);
        assert.deepEqual([...bytes], [...Buffer.from('Xou'), 0, 0]);
        for (const handle of [fd, second, replaced]) fs.closeSync(handle);
        fs.mkdirSync('/volume/tree/sub', { recursive: true });
        fs.writeFileSync('/volume/tree/sub/file', 'child');
        const child = fs.openSync('/volume/tree/sub/file', 'r');
        fs.renameSync('/volume/tree', '/volume/moved');
        assert.equal(fs.statSync('/volume/moved/sub/file').ino, fs.fstatSync(child).ino);
        fs.rmSync('/volume/moved', { recursive: true });
        assert.equal(fs.readFileSync(child, 'utf8'), 'child');
        fs.closeSync(child);
        assert.throws(() => fs.renameSync('/volume', '/volume/other'), { code: 'EBUSY' });
        assert.throws(() => fs.rmSync('/volume', { recursive: true }), { code: 'EBUSY' });
        break;
      }
      case 'pages': {
        const expected = pattern(LARGE);
        fs.writeFileSync(path, expected);
        assert.deepEqual(fs.readFileSync(path), Buffer.from(expected));
        const fd = fs.openSync(path, 'r+');
        fs.writeSync(fd, 'boundary', PAGE - 3);
        expected.set(Buffer.from('boundary'), PAGE - 3);
        assert.deepEqual(fs.readFileSync(path), Buffer.from(expected));
        fs.ftruncateSync(fd, PAGE + 7);
        fs.ftruncateSync(fd, PAGE * 3);
        const zeros = Buffer.alloc(PAGE * 2 - 7, 1);
        assert.equal(fs.readSync(fd, zeros, 0, zeros.length, PAGE + 7), zeros.length);
        assert.ok(zeros.every((value) => value === 0));
        const sparse = 2 ** 32 + 7;
        fs.writeSync(fd, 'Z', sparse);
        assert.equal(fs.fstatSync(fd).size, sparse + 1);
        const tail = Buffer.alloc(4, 1);
        fs.readSync(fd, tail, 0, 4, sparse - 3);
        assert.deepEqual([...tail], [0, 0, 0, 90]);
        assert.equal(fs.writeSync(fd, Buffer.alloc(0), 0, 0, sparse + 100), 0);
        assert.equal(fs.fstatSync(fd).size, sparse + 1);
        fs.closeSync(fd);
        const row = storage.sql
          .exec<{ largest: number; pages: number }>(
            'SELECT max(length(content)) AS largest, count(*) AS pages FROM file_pages'
          )
          .one();
        assert.ok(row.largest <= PAGE);
        assert.ok(row.pages <= 4); // The multi-gigabyte hole has no allocated pages.
        const unlinked = fs.openSync(path, 'r+');
        fs.unlinkSync(path);
        fs.readSync(unlinked, tail, 0, 4, sparse - 3);
        assert.deepEqual([...tail], [0, 0, 0, 90]);
        fs.writeSync(unlinked, 'Y', sparse + 1);
        fs.ftruncateSync(unlinked, sparse);
        fs.ftruncateSync(unlinked, sparse + 2);
        const removedTail = Buffer.alloc(2, 1);
        fs.readSync(unlinked, removedTail, 0, 2, sparse);
        assert.deepEqual([...removedTail], [0, 0]);
        fs.closeSync(unlinked);
        break;
      }
      case 'legacy': {
        const legacy = new LocalDOFilesystem(storage.sql);
        const bytes = pattern(PAGE + 10);
        legacy.writeFileSync('/file', bytes);
        // Restore the 0.1.2 schema, then let the new instance upgrade it on first access.
        storage.sql.exec('DROP TRIGGER delete_file_pages');
        storage.sql.exec('DROP TRIGGER inline_file_pages');
        storage.sql.exec('DROP TABLE file_pages');
        storage.sql.exec('ALTER TABLE entries DROP COLUMN mode');
        assert.deepEqual(fs.readFileSync(path), Buffer.from(bytes));
        const old = legacy.openFileSync('/file', { read: true, write: false });
        const fd = fs.openSync(path, 'r+');
        fs.writeSync(fd, 'changed', PAGE - 3);
        bytes.set(Buffer.from('changed'), PAGE - 3);
        assert.deepEqual(legacy.readFileSync('/file'), bytes);
        assert.equal(
          storage.sql
            .exec<{ content: ArrayBuffer | null }>(
              'SELECT content FROM entries WHERE path = ?',
              '/file'
            )
            .one().content,
          null
        );
        const buffer = new Uint8Array(bytes.length);
        old.read(buffer, 0);
        assert.deepEqual(buffer, bytes);
        old.close();
        fs.closeSync(fd);
        legacy.writeFileSync('/file', Buffer.from('inline again'));
        assert.equal(fs.readFileSync(path, 'utf8'), 'inline again');
        assert.equal(
          storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM file_pages').one()
            .count,
          0
        );
        assert.throws(() => legacy.openFileSync('/file', { read: true, write: true }), {
          code: 'ENOSYS',
        });
        assert.throws(() => legacy.writeFileSync('/large', pattern(LARGE)), { code: 'ENOSYS' });
        break;
      }
      case 'rollback': {
        const expected = pattern(PAGE * 3);
        fs.writeFileSync(path, expected);
        const fd = fs.openSync(path, 'r+');
        const before = fs.fstatSync(fd);
        storage.sql.exec(`CREATE TRIGGER fail_page BEFORE INSERT ON file_pages
          WHEN NEW.page_index = 1 BEGIN SELECT RAISE(ABORT, 'injected page failure'); END`);
        try {
          assert.throws(() => fs.writeSync(fd, Buffer.alloc(PAGE * 3, 7)), /injected page failure/);
          assert.deepEqual(fs.readFileSync(path), Buffer.from(expected));
          assert.equal(fs.fstatSync(fd).mtimeMs, before.mtimeMs);
          assert.throws(() => fs.writeFileSync('/volume/new', expected), /injected page failure/);
          assert.equal(fs.existsSync('/volume/new'), false);
          assert.throws(
            () => fs.writeFileSync(path, Buffer.alloc(PAGE * 3, 9)),
            /injected page failure/
          );
          assert.deepEqual(fs.readFileSync(path), Buffer.from(expected));
        } finally {
          storage.sql.exec('DROP TRIGGER fail_page');
          fs.closeSync(fd);
        }
        assert.throws(
          () =>
            storage.transactionSync(() => {
              fs.writeFileSync(path, 'rolled back');
              throw new Error('outer rollback');
            }),
          /outer rollback/
        );
        assert.deepEqual(fs.readFileSync(path), Buffer.from(expected));
        break;
      }
      case 'streams': {
        const writer = (await remote.createWriteStream('/file')).getWriter();
        for (let i = 0; i < 50; i++) await writer.write(pattern(PAGE + 1));
        await writer.close();
        assert.equal(fs.statSync(path).size, 50 * (PAGE + 1));
        const reader = (await remote.createReadStream('/file')).getReader();
        let total = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          assert.ok(value.length <= PAGE);
          for (const byte of value) assert.equal(byte, (total++ % (PAGE + 1)) % 251);
        }
        assert.equal(total, 50 * (PAGE + 1));
        const append = (await remote.createWriteStream('/file', { flags: 'a' })).getWriter();
        await append.write(Buffer.from('tail'));
        await append.close();
        const range = await remote.createReadStream('/file', { start: total - 1, end: total + 3 });
        assert.deepEqual(
          new Uint8Array(await new Response(range).arrayBuffer()),
          Uint8Array.from([PAGE % 251, ...Buffer.from('tail')])
        );
        const cancel = (await remote.createReadStream('/file')).getReader();
        await cancel.read();
        await cancel.cancel();
        const empty = (await remote.createWriteStream('/empty')).getWriter();
        await empty.close();
        assert.equal(fs.statSync('/volume/empty').size, 0);
        const partial = (await remote.createWriteStream('/partial')).getWriter();
        await partial.write(Buffer.from('retained'));
        await partial.abort();
        assert.equal(fs.readFileSync('/volume/partial', 'utf8'), 'retained');
        const sparse = (await remote.createWriteStream('/sparse', { start: PAGE + 1 })).getWriter();
        await sparse.write(Buffer.from('end'));
        await sparse.close();
        assert.equal(fs.statSync('/volume/sparse').size, PAGE + 4);
        assert.ok(
          (fs.readFileSync('/volume/sparse') as Buffer)
            .subarray(0, PAGE + 1)
            .every((value) => value === 0)
        );
        break;
      }
      case 'persist-write':
        fs.writeFileSync(path, pattern(LARGE));
        break;
      case 'persist-read':
        assert.deepEqual(fs.readFileSync(path), Buffer.from(pattern(LARGE)));
        break;
      default:
        throw new Error(`Unknown scenario: ${scenario}`);
    }
  });
}
