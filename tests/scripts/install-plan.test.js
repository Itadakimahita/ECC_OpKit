/**
 * Tests for scripts/install-plan.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install-plan.js');

function run(args = [], options = {}) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: options.cwd,
      timeout: 10000,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      code: error.status || 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
    return true;
  } catch (error) {
    console.log(`  \u2717 ${name}`);
    console.log(`    Error: ${error.message}`);
    return false;
  }
}

function runTests() {
  console.log('\n=== Testing install-plan.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('shows help with no arguments', () => {
    const result = run();
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Inspect ECC selective-install manifests'));
  })) passed++; else failed++;

  if (test('lists install profiles', () => {
    const result = run(['--list-profiles']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Install profiles'));
    assert.ok(result.stdout.includes('core'));
  })) passed++; else failed++;

  if (test('lists install modules', () => {
    const result = run(['--list-modules']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Install modules'));
    assert.ok(result.stdout.includes('rules-core'));
  })) passed++; else failed++;

  if (test('lists install components', () => {
    const result = run(['--list-components', '--family', 'language']);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.includes('Install components'));
    assert.ok(result.stdout.includes('lang:typescript'));
    assert.ok(!result.stdout.includes('capability:security'));
  })) passed++; else failed++;

  if (test('emits JSON for --skills without pulling parent module', () => {
    const result = run([
      '--skills', 'continuous-learning-v2',
      '--target', 'claude',
      '--json',
    ]);
    assert.strictEqual(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.deepStrictEqual(parsed.includedComponentIds, ['skill:continuous-learning-v2']);
    assert.deepStrictEqual(parsed.selectedModuleIds, ['skill-continuous-learning-v2']);
    assert.ok(parsed.operations.some(operation => operation.sourceRelativePath === 'skills/continuous-learning-v2'));
    assert.ok(!parsed.operations.some(operation => operation.sourceRelativePath === 'skills/tdd-workflow'));
  })) passed++; else failed++;

  if (test('config component selections produce the same operations as CLI flags', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-plan-config-'));
    const configPath = path.join(configDir, 'selections.json');
    const include = ['agent:planner', 'skill:continuous-learning-v2', 'locale:ja'];
    const exclude = ['skill:security-review'];

    try {
      fs.writeFileSync(configPath, JSON.stringify({
        version: 1, target: 'claude', profile: 'developer', include, exclude,
      }));
      const cli = run([
        '--target', 'claude', '--profile', 'developer',
        ...include.flatMap(id => ['--with', id]),
        ...exclude.flatMap(id => ['--without', id]), '--json',
      ], { cwd: configDir });
      const configured = run(['--config', configPath, '--json'], { cwd: configDir });
      assert.strictEqual(cli.code, 0, cli.stderr);
      assert.strictEqual(configured.code, 0, configured.stderr);
      const expected = JSON.parse(cli.stdout);
      const actual = JSON.parse(configured.stdout);
      assert.deepStrictEqual(actual.includedComponentIds, include);
      assert.deepStrictEqual(actual.excludedComponentIds, exclude);
      assert.deepStrictEqual(actual.selectedModuleIds, expected.selectedModuleIds);
      assert.deepStrictEqual(actual.operations, expected.operations);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('fails on unknown arguments', () => {
    const result = run(['--unknown-flag']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown argument'));
  })) passed++; else failed++;

  if (test('fails on invalid install target', () => {
    const result = run(['--profile', 'core', '--target', 'not-a-target']);
    assert.strictEqual(result.code, 1);
    assert.ok(result.stderr.includes('Unknown install target'));
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
