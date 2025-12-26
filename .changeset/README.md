# Changesets

This repository uses [Changesets](https://github.com/changesets/changesets) to manage versions and changelogs.

## Adding a changeset

When you make a change that should be released, run:

```bash
pnpm changeset
```

This will prompt you to:
1. Select which packages are affected
2. Choose the semver bump type (patch/minor/major)
3. Write a summary of the change

The changeset file will be committed with your PR.

## How releases work

When PRs with changesets are merged to `main`:
1. A "Version Packages" PR is automatically created/updated
2. This PR bumps versions and updates CHANGELOGs
3. When that PR is merged, packages are automatically published to npm

## Packages managed by changesets

- `worker-fs-mount` - Core mounting system
- `r2-fs` - R2-backed filesystem
- `durable-object-fs` - Durable Object filesystem

## Ignored packages (not published)

- `memory-fs` - Demo/testing only
- `worker-fs-mount-tests` - Internal tests
- Example packages
