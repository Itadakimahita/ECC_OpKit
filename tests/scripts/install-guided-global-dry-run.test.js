'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

test('invalid global dry-run input is rejected before guided planning', () => {
  const child = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/install-guided.js'),
    '--harness', 'codex', '--yes', '--json'], {
    encoding: 'utf8', env: { ...process.env, ECC_DRY_RUN: 'yes' },
  });
  assert.equal(child.status, 1);
  assert.match(JSON.parse(child.stderr).error.message, /ECC_DRY_RUN must be "1" or "0"/);
});
