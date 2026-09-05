---
"worker-fs-mount": minor
---

Add an optional Emscripten NODERAWFS integration. The module helper retains a
filesystem context across JavaScript calls and async callbacks. A companion
Emscripten library supplies public file constants, per-module working directories,
console callbacks, stdio metadata, and synchronous fd_sync in Workers.
