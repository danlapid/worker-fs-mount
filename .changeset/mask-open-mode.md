---
"worker-fs-mount": patch
---

Mask numeric `mode` arguments to their permission bits in `openSync` and `fchmodSync`, as Node does, instead of rejecting a full `st_mode` such as `S_IFREG | 0o644` with `ERR_OUT_OF_RANGE`.
