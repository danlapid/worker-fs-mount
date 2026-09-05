---
"durable-object-fs": patch
"r2-fs": patch
---

Pack with pnpm before npm's OIDC publish step so workspace peer dependencies are
converted into published versions. This lets npm consumers install the packages
without a workspace-protocol override.
