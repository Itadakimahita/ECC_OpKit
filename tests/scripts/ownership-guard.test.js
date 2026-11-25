'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createManifestInstallPlan } = require('../../scripts/lib/install/plan');
const { applyInstallPlan, previewInstallPlan } = require('../../scripts/lib/install/apply');
const { listInstallTargetAdapters } = require('../../scripts/lib/install-targets/registry');
const { uninstallInstalledStates } = require('../../scripts/lib/install-lifecycle');

let passed = 0;
let failed = 0;
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-ownership-'));
  try {
    const projectRoot = path.join(root, 'project');
    const homeDir = path.join(root, 'home');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(homeDir);
    fn({ projectRoot, homeDir, env: {} });
    passed++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}: ${error.stack}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function readState(plan) {
  return JSON.parse(fs.readFileSync(plan.installStatePath, 'utf8'));
}

for (const adapter of listInstallTargetAdapters()) {
  test(`${adapter.target}: preserve user files through preview, install, reinstall and uninstall`, context => {
    const nativeTarget = ['codex', 'gemini', 'opencode'].includes(adapter.target);
    const moduleId = adapter.target === 'mistral-vibe'
      ? 'skill-tdd-workflow'
      : adapter.target === 'copilot'
        ? 'agents-core'
        : (nativeTarget ? 'platform-configs' : 'rules-core');
    const resolved = createManifestInstallPlan({
      ...context, target: adapter.target,
      moduleIds: [moduleId],
      // This test exercises ownership of source files, not plugin compilation.
      exemptValidationCodes: ['opencode-plugin-not-built'],
    });
    const operation = resolved.operations.find(item => item.kind === 'copy-file');
    assert.ok(operation, 'target must produce a real copy operation');
    const plan = {
      ...resolved, operations: [operation],
      statePreview: { ...resolved.statePreview, operations: [operation] },
    };
    const destination = operation.destinationPath;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'User-authored content\n');
    const preview = previewInstallPlan(plan);
    assert.ok(preview.skippedOperations.some(item => item.destinationPath === destination));
    assert.ok(!preview.statePreview.operations.some(item => item.destinationPath === destination));
    assert.ok(!fs.existsSync(plan.installStatePath), 'preview must not create state');
    for (let attempt = 0; attempt < 2; attempt++) {
      const installed = applyInstallPlan(plan);
      assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'User-authored content\n');
      assert.ok(installed.warnings.some(warning => warning.includes('Skipped user-owned file')));
      assert.ok(!readState(plan).operations.some(item => item.destinationPath === destination));
    }
    const result = uninstallInstalledStates({ ...context, targets: [adapter.target] });
    assert.strictEqual(result.summary.errorCount, 0);
    assert.strictEqual(fs.readFileSync(destination, 'utf8'), 'User-authored content\n');
    assert.ok(!fs.existsSync(plan.installStatePath));
  });
}

console.log(`Results: Passed: ${passed}, Failed: ${failed}`);
process.exitCode = failed ? 1 : 0;
