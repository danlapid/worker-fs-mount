#!/usr/bin/env node

/**
 * Publish script that uses npm directly for OIDC trusted publishing support.
 * pnpm doesn't support OIDC, so we use npm publish which automatically
 * handles OIDC authentication when running in GitHub Actions.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PACKAGES = ['packages/worker-fs-mount', 'packages/r2-fs', 'packages/durable-object-fs'];

function getPackageInfo(dir) {
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  return { name: pkg.name, version: pkg.version };
}

function isPublished(name, version) {
  try {
    execSync(`npm view ${name}@${version} version`, { stdio: 'pipe' });
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
  try {
    execSync('npm publish --access public', {
      cwd: dir,
      stdio: 'inherit',
    });
    console.log(`✅ Published ${name}@${version}`);
  } catch {
    console.error(`❌ Failed to publish ${name}@${version}`);
    process.exit(1);
  }
}

console.log('🚀 Publishing packages with npm (OIDC enabled)\n');

for (const pkg of PACKAGES) {
  publish(pkg);
}

console.log('\n✨ Done!');
