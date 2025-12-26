# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-12-26

### Added

#### worker-fs-mount
- Initial release of the core mounting system
- `mount()` and `unmount()` functions for managing virtual filesystem mounts
- `withMounts()` for request-scoped mounts with automatic cleanup
- `isMounted()` and `isInMountContext()` utility functions
- Drop-in replacement for `node:fs/promises` via wrangler alias
- Support for mounting WorkerEntrypoints, service bindings, and Durable Object stubs
- Full `node:fs/promises` API compatibility including:
  - File operations: `readFile`, `writeFile`, `appendFile`, `truncate`, `rm`, `unlink`
  - Directory operations: `mkdir`, `readdir`, `rmdir`
  - Metadata: `stat`, `lstat`, `access`
  - Symlinks: `symlink`, `readlink`
  - Copy/move: `copyFile`, `cp`, `rename`
- Stream-first `WorkerFilesystem` interface for implementations
- Proper Node.js-style error handling with `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `EXDEV`

#### r2-fs
- Initial release of R2-backed filesystem implementation
- Implements `WorkerFilesystem` interface for R2 buckets
- Directory emulation using marker objects
- Efficient streaming for large files
- Support for all core filesystem operations

#### durable-object-fs
- Initial release of Durable Object filesystem implementation
- SQLite-backed persistent storage
- ACID-compliant file operations
- Per-user or per-session isolated filesystems
- Automatic schema migrations
