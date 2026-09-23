# durable-object-fs

## 2.0.0

### Minor Changes

- [#9](https://github.com/danlapid/worker-fs-mount/pull/9) [`1508873`](https://github.com/danlapid/worker-fs-mount/commit/15088731676602ae0d0c5644aa606469a93d4dc1) Thanks [@danlapid](https://github.com/danlapid)! - durable-object-fs: `LocalDOFilesystem` accepts options for a configurable page size per
  file (`pageSize`, a number or a function of the path, stored in `entries.page_size`),
  opt-in write-back buffering flushed on `fsync`/`close`/`flush()` (`writeBack`), a shared
  LRU page cache (`readCacheBytes`), and page I/O metrics (`onPageIO`, `stats()`). Writes
  covering whole pages no longer read them first. New databases create `file_pages`
  `WITHOUT ROWID`, halving rows written per page. `LocalDOFilesystem` implements
  `statfsSync` from the storage quota. Defaults are unchanged, and existing databases
  upgrade in place.

  worker-fs-mount: `createMountScope()` creates a mount context whose mounts and
  descriptors persist across calls (one per Durable Object). `statfsSync` is routed to
  mounts that implement the new optional `SyncWorkerFilesystem.statfsSync`, and
  `truncateSync` on descriptor-capable mounts truncates in place.

### Patch Changes

- [#7](https://github.com/danlapid/worker-fs-mount/pull/7) [`19852eb`](https://github.com/danlapid/worker-fs-mount/commit/19852ebde9340e346c9435281eda97f168c4fb87) Thanks [@danlapid](https://github.com/danlapid)! - Pack with pnpm before npm's OIDC publish step so workspace peer dependencies are
  converted into published versions. This lets npm consumers install the packages
  without a workspace-protocol override.
- Updated dependencies [[`1508873`](https://github.com/danlapid/worker-fs-mount/commit/15088731676602ae0d0c5644aa606469a93d4dc1)]:
  - worker-fs-mount@0.3.0

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
