# durable-object-fs

## 1.0.0

### Minor Changes

- [#5](https://github.com/danlapid/worker-fs-mount/pull/5) [`127ad2d`](https://github.com/danlapid/worker-fs-mount/commit/127ad2df2343db7e2e1e04165fbcf92eeb1b2b5d) Thanks [@danlapid](https://github.com/danlapid)! - Add mount-aware synchronous file descriptors for local backends, including positional
  I/O, append flags, truncation, sync, and POSIX stat mode bits for Emscripten NODERAWFS.
  Descriptors are isolated by mount context and remain attached to their original files
  across unmount, local rename, and unlink.

  Store SQLite file contents in 64 KiB pages to support large files, sparse writes, and
  incremental streams without exceeding the SQLite row limit. Existing inline BLOBs
  migrate on mutation. Construct LocalDOFilesystem with the full DurableObjectStorage
  object to enable transactional paged writes and writable descriptors; the existing
  SqlStorage constructor retains small inline writes and can read both formats.

### Patch Changes

- Updated dependencies [[`127ad2d`](https://github.com/danlapid/worker-fs-mount/commit/127ad2df2343db7e2e1e04165fbcf92eeb1b2b5d)]:
  - worker-fs-mount@0.2.0

## 0.1.2

### Patch Changes

- [#2](https://github.com/danlapid/worker-fs-mount/pull/2) [`2e79e3f`](https://github.com/danlapid/worker-fs-mount/commit/2e79e3fdcaf0b7b70619c88dd01f5a3bb54052b3) Thanks [@danlapid](https://github.com/danlapid)! - Add synchronous node:fs support for Durable Objects via LocalDOFilesystem

- Updated dependencies [[`2e79e3f`](https://github.com/danlapid/worker-fs-mount/commit/2e79e3fdcaf0b7b70619c88dd01f5a3bb54052b3)]:
  - worker-fs-mount@0.1.2

## 0.1.1

### Patch Changes

- [`af70714`](https://github.com/danlapid/worker-fs-mount/commit/af70714700961eb936e3e896d3eeccd27344e18a) Thanks [@danlapid](https://github.com/danlapid)! - Use CI to publish

- Updated dependencies [[`af70714`](https://github.com/danlapid/worker-fs-mount/commit/af70714700961eb936e3e896d3eeccd27344e18a)]:
  - worker-fs-mount@0.1.1
