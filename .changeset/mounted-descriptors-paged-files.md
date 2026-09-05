---
"worker-fs-mount": minor
"durable-object-fs": minor
---

Add mount-aware synchronous file descriptors for local backends, including positional
I/O, append flags, truncation, sync, and POSIX stat mode bits for Emscripten NODERAWFS.
Descriptors are isolated by mount context and remain attached to their original files
across unmount, local rename, and unlink.

Store SQLite file contents in 64 KiB pages to support large files, sparse writes, and
incremental streams without exceeding the SQLite row limit. Existing inline BLOBs
migrate on mutation. Construct LocalDOFilesystem with the full DurableObjectStorage
object to enable transactional paged writes and writable descriptors; the existing
SqlStorage constructor retains small inline writes and can read both formats.
