#!/usr/bin/env node

/**
 * Publish script that uses npm directly for OIDC trusted publishing support.
 * pnpm doesn't support OIDC, so we use npm publish which automatically
 * handles OIDC authentication when running in GitHub Actions.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGES = ['packages/worker-fs-mount', 'packages/r2-fs', 'packages/durable-object-fs'];

function getPackageInfo(dir) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  return { name: pkg.name, version: pkg.version };
}

function isPublished(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function publish(dir) {
  const { name, version } = getPackageInfo(dir);

  if (isPublished(name, version)) {
    console.log(`⏭️  ${name}@${version} already published, skipping`);
    return;
  }

  console.log(`📦 Publishing ${name}@${version}...`);
  const staging = mkdtempSync(join(tmpdir(), 'worker-fs-publish-'));
  try {
    // pnpm resolves workspace: dependencies in the packed manifest. npm handles
    // OIDC publishing, but publishing the source directory preserves workspace:*.
    execFileSync('pnpm', ['pack', '--pack-destination', staging], { cwd: dir, stdio: 'inherit' });
    const archives = readdirSync(staging).filter((name) => name.endsWith('.tgz'));
    if (archives.length !== 1) throw new Error(`Expected one package archive for ${dir}`);
    execFileSync(
      'npm',
      ['publish', join(staging, archives[0]), '--access', 'public', '--provenance'],
      {
        stdio: 'inherit',
      }
    );
    console.log(`✅ Published ${name}@${version}`);
  } catch {
    console.error(`❌ Failed to publish ${name}@${version}`);
    process.exitCode = 1;
    throw new Error(`Publishing ${name}@${version} failed`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

console.log('🚀 Publishing packages with npm (OIDC enabled)\n');

for (const pkg of PACKAGES) {
  publish(pkg);
}

console.log('\n✨ Done!');
