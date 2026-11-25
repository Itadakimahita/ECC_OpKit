/**
 * Tests for scripts/uninstall.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'install-apply.js');
const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'uninstall.js');
// Windows CI file I/O is several times slower, and these cases run two full
// CLI passes (install, then uninstall) over hundreds of files. install-apply
// tests already scale their timeout the same way.
const CLI_TIMEOUT_MS = process.platform === 'win32' ? 90000 : 30000;
const {
  beginLegacySyncState,
  recordLegacySyncPath,
  finalizeLegacySyncState,
} = require('../../scripts/lib/codex-legacy-sync');

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}


function run(args = [], options = {}) {
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== 'ECC_DRY_RUN' && key !== 'CODEX_HOME')
  );
  const homeEnv = options.homeDir
    ? { HOME: options.homeDir, USERPROFILE: options.homeDir, CODEX_HOME: path.join(options.homeDir, '.codex') }
    : {};
  const env = { ...inheritedEnv, ...(options.env || {}), ...homeEnv };

  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], {
      cwd: options.cwd,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CLI_TIMEOUT_MS,
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
  console.log('\n=== Testing uninstall.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('uninstall removes every managed hook when two modules share settings.json', () => {
    const homeDir = createTempDir('uninstall-shared-settings-home-');
    const projectRoot = createTempDir('uninstall-shared-settings-project-');
    const claudeRoot = path.join(homeDir, '.claude');
    const settingsPath = path.join(claudeRoot, 'settings.json');
    const statePath = path.join(claudeRoot, 'ecc', 'install-state.json');

    try {
      execFileSync(
        'node',
        [INSTALL_SCRIPT, '--target', 'claude', '--modules', 'hooks-runtime,config-health', '--enable-hooks'],
        {
          cwd: projectRoot,
          env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: CLI_TIMEOUT_MS,
        }
      );
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const settingsOperations = state.operations.filter(operation => (
        operation.kind === 'update-claude-settings'
      ));
      // Each module's settings contribution must keep its own record; keyed by
      // destination alone, one overwrites the other and its hooks leak.
      assert.strictEqual(settingsOperations.length, 2,
        `expected one settings record per hook-shipping module, got ${JSON.stringify(
          settingsOperations.map(operation => operation.moduleId)
        )}`);
      const managedIds = new Set(settingsOperations
        .flatMap(operation => Object.values(operation.managedHooks || {}))
        .flat()
        .map(entry => entry.id));
      assert.ok(managedIds.has('config-health:session-start'),
        'the config-health hook must be recorded');
      assert.ok(managedIds.has('session:start'),
        'the runtime SessionStart hook must be recorded');

      const uninstallResult = run(['--target', 'claude'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.ok(!fs.existsSync(statePath), 'uninstall must remove the install-state record');

      const settings = fs.existsSync(settingsPath)
        ? JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        : {};
      const remainingIds = Object.values(settings.hooks || {})
        .flat()
        .map(entry => entry.id);
      const leaked = remainingIds.filter(id => managedIds.has(id));
      assert.deepStrictEqual(leaked, [],
        `uninstall left managed hooks behind in settings.json: ${leaked.join(', ')}`);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstalls the project hook module boundary and preserves user Claude package data', () => {
    const homeDir = createTempDir('uninstall-claude-project-esm-home-');
    const projectRoot = createTempDir('uninstall-claude-project-esm-');
    const claudeRoot = path.join(projectRoot, '.claude');
    const userPackagePath = path.join(claudeRoot, 'package.json');
    const scriptsPackagePath = path.join(claudeRoot, 'scripts', 'package.json');
    const hooksPackagePath = path.join(claudeRoot, 'scripts', 'hooks', 'package.json');
    const libPackagePath = path.join(claudeRoot, 'scripts', 'lib', 'package.json');
    const statePath = path.join(claudeRoot, 'ecc', 'install-state.json');
    const userPackage = '{"name":"user-claude-config","type":"module"}\n';
    const userScriptsPackage = '{"name":"user-claude-scripts","type":"module"}\n';

    try {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"type":"module"}\n');
      fs.mkdirSync(path.dirname(scriptsPackagePath), { recursive: true });
      fs.writeFileSync(userPackagePath, userPackage);
      fs.writeFileSync(scriptsPackagePath, userScriptsPackage);

      execFileSync(
        'node',
        [INSTALL_SCRIPT, '--target', 'claude-project', '--modules', 'hooks-runtime', '--enable-hooks'],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
          },
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: CLI_TIMEOUT_MS,
        }
      );
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(hooksPackagePath, 'utf8')), { type: 'commonjs' });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(libPackagePath, 'utf8')), { type: 'commonjs' });
      assert.strictEqual(fs.readFileSync(scriptsPackagePath, 'utf8'), userScriptsPackage);

      const uninstallResult = run(['--target', 'claude-project'], {
        cwd: projectRoot,
        homeDir,
      });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.strictEqual(fs.readFileSync(userPackagePath, 'utf8'), userPackage);
      assert.strictEqual(fs.readFileSync(scriptsPackagePath, 'utf8'), userScriptsPackage);
      assert.ok(!fs.existsSync(hooksPackagePath));
      assert.ok(!fs.existsSync(libPackagePath));
      assert.ok(!fs.existsSync(statePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  // #2952: the global `ecc --dry-run uninstall` prefix sets ECC_DRY_RUN=1.
  // The uninstaller must honor it exactly like the subcommand-level flag.

  if (test('auto-detects legacy sync-ecc-to-codex.sh install and removes artifacts without touching conversations or unrelated config keys', () => {
    const homeDir = createTempDir('uninstall-legacy-codex-home-');
    const projectRoot = createTempDir('uninstall-legacy-codex-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const configPath = path.join(codexHome, 'config.toml');
      const agentsPath = path.join(codexHome, 'AGENTS.md');
      const promptPath = path.join(codexHome, 'prompts', 'ecc-plan.md');
      const conversationPath = path.join(codexHome, 'conversations', 'keep-me.md');
      const userFilePath = path.join(codexHome, 'user-owned.txt');

      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(configPath, 'model = "user"\n');
      fs.writeFileSync(agentsPath, '# User instructions\n');
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });

      const statePath = beginLegacySyncState({
        codexHome,
        backupDir: path.join(codexHome, 'backups', 'ecc-test'),
      });
      recordLegacySyncPath({ statePath, filePath: configPath });
      recordLegacySyncPath({ statePath, filePath: agentsPath });
      recordLegacySyncPath({ statePath, filePath: promptPath });

      fs.writeFileSync(configPath, 'model = "user"\napproval_policy = "on-request"\n');
      fs.writeFileSync(
        agentsPath,
        '# User instructions\n\n<!-- BEGIN ECC -->\n# ECC managed\n<!-- END ECC -->\n'
      );
      fs.writeFileSync(promptPath, '# ECC generated prompt\n');
      finalizeLegacySyncState({ statePath });

      fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
      fs.writeFileSync(conversationPath, 'conversation history');
      fs.writeFileSync(userFilePath, 'unrelated');

      const uninstallResult = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.ok(!uninstallResult.stdout.includes('No ECC install-state files found'), uninstallResult.stdout);
      assert.ok(uninstallResult.stdout.includes('Legacy Codex sync cleanup summary'), uninstallResult.stdout);
      assert.ok(!fs.existsSync(promptPath));
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), 'model = "user"\n');
      assert.strictEqual(fs.readFileSync(agentsPath, 'utf8'), '# User instructions\n');
      assert.strictEqual(fs.readFileSync(conversationPath, 'utf8'), 'conversation history');
      assert.strictEqual(fs.readFileSync(userFilePath, 'utf8'), 'unrelated');
      assert.ok(!fs.existsSync(statePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('global dry-run environment previews legacy Codex cleanup without removing artifacts', () => {
    const homeDir = createTempDir('uninstall-legacy-codex-dry-run-home-');
    const projectRoot = createTempDir('uninstall-legacy-codex-dry-run-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const promptPath = path.join(codexHome, 'prompts', 'ecc-plan.md');
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });

      const statePath = beginLegacySyncState({
        codexHome,
        backupDir: path.join(codexHome, 'backups', 'ecc-test'),
      });
      recordLegacySyncPath({ statePath, filePath: promptPath });
      fs.writeFileSync(promptPath, '# ECC generated prompt\n');
      finalizeLegacySyncState({ statePath });

      const uninstallResult = run(['--legacy-codex-sync'], {
        cwd: projectRoot,
        homeDir,
        env: { ECC_DRY_RUN: '1' },
      });

      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.match(uninstallResult.stdout, /Status: PLANNED/);
      assert.match(uninstallResult.stdout, /Planned changes:/);
      assert.doesNotMatch(uninstallResult.stdout, /Status: UNINSTALLED|Removed paths:/);
      assert.ok(fs.existsSync(promptPath), 'global dry-run must preserve legacy artifacts');
      assert.ok(fs.existsSync(statePath), 'global dry-run must preserve legacy state');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('rejects an invalid global dry-run value before legacy cleanup', () => {
    const homeDir = createTempDir('uninstall-legacy-codex-invalid-dry-run-home-');
    const projectRoot = createTempDir('uninstall-legacy-codex-invalid-dry-run-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const promptPath = path.join(codexHome, 'prompts', 'ecc-plan.md');
      fs.mkdirSync(path.dirname(promptPath), { recursive: true });

      const statePath = beginLegacySyncState({
        codexHome,
        backupDir: path.join(codexHome, 'backups', 'ecc-test'),
      });
      recordLegacySyncPath({ statePath, filePath: promptPath });
      fs.writeFileSync(promptPath, '# ECC generated prompt\n');
      finalizeLegacySyncState({ statePath });

      const uninstallResult = run(['--legacy-codex-sync'], {
        cwd: projectRoot,
        homeDir,
        env: { ECC_DRY_RUN: 'true' },
      });

      assert.strictEqual(uninstallResult.code, 1);
      assert.match(uninstallResult.stderr, /ECC_DRY_RUN must be "1" or "0" when set/);
      assert.ok(fs.existsSync(promptPath), 'invalid dry-run input must preserve legacy artifacts');
      assert.ok(fs.existsSync(statePath), 'invalid dry-run input must preserve legacy state');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('does not misclassify a clean Codex home as a legacy install', () => {
    const homeDir = createTempDir('uninstall-clean-codex-home-');
    const projectRoot = createTempDir('uninstall-clean-codex-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const configPath = path.join(codexHome, 'config.toml');
      const conversationPath = path.join(codexHome, 'conversations', 'keep-me.md');

      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(configPath, 'model = "user"\n');
      fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
      fs.writeFileSync(conversationPath, 'conversation history');

      const uninstallResult = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.ok(uninstallResult.stdout.includes('No ECC install-state files found'), uninstallResult.stdout);
      assert.ok(!uninstallResult.stdout.includes('Legacy Codex sync cleanup summary'), uninstallResult.stdout);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), 'model = "user"\n');
      assert.strictEqual(fs.readFileSync(conversationPath, 'utf8'), 'conversation history');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('explicit --legacy-codex-sync on a clean home reports not-found without removing files', () => {
    const homeDir = createTempDir('uninstall-legacy-clean-home-');
    const projectRoot = createTempDir('uninstall-legacy-clean-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const configPath = path.join(codexHome, 'config.toml');

      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(configPath, 'model = "user"\n');

      const uninstallResult = run(['--legacy-codex-sync', '--json'], { cwd: projectRoot, homeDir });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      const parsed = JSON.parse(uninstallResult.stdout);
      assert.strictEqual(parsed.status, 'not-found');
      assert.deepStrictEqual(parsed.plannedRemovals, []);
      assert.deepStrictEqual(parsed.retainedPaths, []);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), 'model = "user"\n');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('does not auto-fallback to a marker-only AGENTS.md without a legacy ownership manifest', () => {
    const homeDir = createTempDir('uninstall-marker-only-codex-home-');
    const projectRoot = createTempDir('uninstall-marker-only-codex-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const configPath = path.join(codexHome, 'config.toml');
      const agentsPath = path.join(codexHome, 'AGENTS.md');
      const conversationPath = path.join(codexHome, 'conversations', 'keep-me.md');

      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(configPath, 'model = "user"\n');
      fs.writeFileSync(
        agentsPath,
        '# User instructions\n\n<!-- BEGIN ECC -->\n# ECC managed\n<!-- END ECC -->\n'
      );
      fs.mkdirSync(path.dirname(conversationPath), { recursive: true });
      fs.writeFileSync(conversationPath, 'conversation history');

      const uninstallResult = run([], { cwd: projectRoot, homeDir });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.ok(uninstallResult.stdout.includes('No ECC install-state files found'), uninstallResult.stdout);
      assert.ok(!uninstallResult.stdout.includes('Legacy Codex sync cleanup summary'), uninstallResult.stdout);
      assert.strictEqual(fs.readFileSync(agentsPath, 'utf8'), '# User instructions\n\n<!-- BEGIN ECC -->\n# ECC managed\n<!-- END ECC -->\n');
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), 'model = "user"\n');
      assert.strictEqual(fs.readFileSync(conversationPath, 'utf8'), 'conversation history');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('explicit --legacy-codex-sync removes a marker-only AGENTS.md block', () => {
    const homeDir = createTempDir('uninstall-explicit-marker-codex-home-');
    const projectRoot = createTempDir('uninstall-explicit-marker-codex-project-');

    try {
      const codexHome = path.join(homeDir, '.codex');
      const agentsPath = path.join(codexHome, 'AGENTS.md');

      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(
        agentsPath,
        '# User instructions\n\n<!-- BEGIN ECC -->\n# ECC managed\n<!-- END ECC -->\n'
      );

      const uninstallResult = run(['--legacy-codex-sync'], { cwd: projectRoot, homeDir });
      assert.strictEqual(uninstallResult.code, 0, uninstallResult.stderr);
      assert.ok(uninstallResult.stdout.includes('Legacy Codex sync cleanup summary'), uninstallResult.stdout);
      assert.ok(uninstallResult.stdout.includes('Status: UNINSTALLED'), uninstallResult.stdout);
      assert.strictEqual(fs.readFileSync(agentsPath, 'utf8'), '# User instructions\n\n');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
