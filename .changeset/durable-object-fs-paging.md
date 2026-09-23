---
"durable-object-fs": minor
"worker-fs-mount": minor
---

durable-object-fs: `LocalDOFilesystem` accepts options for a configurable page size per
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
