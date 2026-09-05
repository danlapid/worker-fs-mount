// Emscripten's Node loader uses createRequire at runtime, so Wrangler's build-time
// aliases cannot replace its fs object. Supply the mounted node:fs implementation
// to each factory, with a cwd that does not change the isolate's process.cwd.
addToLibrary({
  // Workers exposes public fs.constants, but not Node's internal process.binding.
  $NODEFS__postset: `
    NODEFS.isWindows = false;
    NODEFS.flagsForNodeMap = Object.fromEntries([
      [{{{ cDefs.O_APPEND }}}, 'O_APPEND'],
      [{{{ cDefs.O_CREAT }}}, 'O_CREAT'],
      [{{{ cDefs.O_EXCL }}}, 'O_EXCL'],
      [{{{ cDefs.O_NOCTTY }}}, 'O_NOCTTY'],
      [{{{ cDefs.O_RDONLY }}}, 'O_RDONLY'],
      [{{{ cDefs.O_RDWR }}}, 'O_RDWR'],
      [{{{ cDefs.O_DSYNC }}}, 'O_SYNC'],
      [{{{ cDefs.O_TRUNC }}}, 'O_TRUNC'],
      [{{{ cDefs.O_WRONLY }}}, 'O_WRONLY'],
      [{{{ cDefs.O_NOFOLLOW }}}, 'O_NOFOLLOW'],
    ].map(([flag, name]) => [flag, fs.constants[name]]));
  `,

  $workerFilesystem__deps: ['$FS', '$PATH_FS', '$TTY'],
  $workerFilesystem__postset: () => addAtPreRun('workerFilesystem()'),
  $workerFilesystem: () => {
    // biome-ignore lint/complexity/useLiteralKeys: preserve the external Emscripten property name
    fs = Module['nodeFs'];
    // biome-ignore lint/complexity/useLiteralKeys: preserve the external Emscripten property name
    let workerCwd = Module['cwd'];
    FS.cwd = () => workerCwd;
    // Keep standard output on Emscripten's console callbacks, including printErr
    // so the host can record Rust panics. Native Worker fds are not stdio handles.
    const consoles = [
      null,
      { output: [], ops: TTY.default_tty_ops },
      { output: [], ops: TTY.default_tty1_ops },
    ];
    // NODERAWFS's stdio streams have no nodes; expose character-device metadata
    // without asking the native Workers filesystem about those descriptor numbers.
    const fstat = FS.fstat;
    FS.fstat = (fd) => {
      const stream = FS.getStreamChecked(fd);
      if (stream.nfd === 0 || stream.nfd === 1 || stream.nfd === 2) {
        return {
          dev: 0,
          ino: stream.nfd,
          mode: 0o020666,
          nlink: 1,
          uid: 0,
          gid: 0,
          rdev: 0,
          size: 0,
          blksize: 4096,
          blocks: 0,
          atime: new Date(0),
          mtime: new Date(0),
          ctime: new Date(0),
        };
      }
      return fstat(fd);
    };
    const write = FS.write;
    FS.write = (stream, buffer, offset, length, position) => {
      const tty = consoles[stream.nfd];
      if (!tty) return write(stream, buffer, offset, length, position);
      for (let i = offset; i < offset + length; i++) tty.ops.put_char(tty, buffer[i]);
      return length;
    };
    // Non-*at syscalls can pass relative paths directly to NODERAWFS. Resolve
    // those against this wasm instance, not the shared Node process directory.
    for (const name of [
      'lookupPath',
      'stat',
      'chmod',
      'chown',
      'truncate',
      'utime',
      'open',
      'mkdir',
      'rmdir',
      'readdir',
      'unlink',
      'readlink',
    ]) {
      const operation = FS[name];
      FS[name] = (path, ...args) => operation(PATH_FS.resolve(path), ...args);
    }
    const rename = FS.rename;
    FS.rename = (from, to) => rename(PATH_FS.resolve(from), PATH_FS.resolve(to));
    const symlink = FS.symlink;
    FS.symlink = (target, path) => symlink(target, PATH_FS.resolve(path));
    FS.chdir = (path) => {
      path = PATH_FS.resolve(path);
      if (!FS.isDir(FS.stat(path).mode)) throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
      workerCwd = path;
    };
  },

  // SQLite operations are synchronous. Checkpoint completion separately awaits
  // storage.sync(); ordinary Rust File::sync_all must not suspend a sync export.
  fd_sync__deps: ['$FS', '$workerFilesystem'],
  fd_sync__async: false,
  fd_sync: (fd) => {
    try {
      const stream = FS.getStreamChecked(fd);
      if (typeof stream.nfd === 'number') fs.fsyncSync(stream.nfd);
      else stream.stream_ops?.fsync?.(stream);
      return 0;
    } catch (error) {
      if (typeof error.errno === 'number') return error.errno;
      if (error.code) return ERRNO_CODES[error.code];
      throw error;
    }
  },
});
