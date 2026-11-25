/**
 * Tests for scripts/lib/install-lifecycle.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildDoctorReport,
      repairInstalledStates,
  uninstallInstalledStates,
} = require('../../scripts/lib/install-lifecycle');
const {
  createInstallState,
  readInstallState,
  writeInstallState,
} = require('../../scripts/lib/install-state');
const {
  assertClaudeSettingsPath,
  materializeManagedHooks,
} = require('../../scripts/lib/install/claude-settings');
const { readHooksConfig } = require('../../scripts/lib/hooks-config');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CURRENT_PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')
).version;
const CURRENT_MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'manifests', 'install-modules.json'), 'utf8')
).version;

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

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeState(filePath, options) {
  const state = createInstallState(options);
  writeInstallState(filePath, state);
  return state;
}



function writeClaudeState(homeDir, overrides = {}) {
  const targetRoot = overrides.targetRoot || path.join(homeDir, '.claude');
  const installStatePath = overrides.installStatePath
    || path.join(targetRoot, 'ecc', 'install-state.json');
  const options = {
    adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
    targetRoot,
    installStatePath,
    request: {
      profile: null,
      modules: [],
      includeComponents: [],
      excludeComponents: [],
      legacyLanguages: [],
      legacyMode: true,
      hookConsent: 'enabled',
      ...(overrides.request || {}),
    },
    resolution: {
      selectedModules: ['legacy-claude-install'],
      skippedModules: [],
      ...(overrides.resolution || {}),
    },
    operations: overrides.operations || [],
    source: {
      repoVersion: CURRENT_PACKAGE_VERSION,
      repoCommit: 'abc123',
      manifestVersion: CURRENT_MANIFEST_VERSION,
      ...(overrides.source || {}),
    },
  };

  writeState(installStatePath, options);
  return {
    targetRoot,
    installStatePath,
    state: options,
  };
}

function managedHookEntry(id, command) {
  return {
    id,
    matcher: '.*',
    hooks: [{ type: 'command', command }],
  };
}

function currentManagedHooks(targetRoot) {
  return materializeManagedHooks(
    readHooksConfig(path.join(REPO_ROOT, 'hooks', 'hooks.json')),
    targetRoot
  );
}




// These race fixtures read public source as inert bytes into a private source
// tree. Fake payload construction must never move/write repository build output.

function withTemporarilyMovedPath(filePath, callback) {
  if (!fs.existsSync(filePath)) {
    try {
      return callback(null);
    } finally {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    }
  }

  const backupPath = `${filePath}.backup-${process.pid}-${Date.now()}`;
  fs.renameSync(filePath, backupPath);

  try {
    return callback(backupPath);
  } finally {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { recursive: true, force: true });
    }
    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, filePath);
    }
  }
}

function managedOperation(kind, destinationPath, overrides = {}) {
  const operation = {
    kind,
    moduleId: kind === 'update-claude-settings' ? 'hooks-runtime' : 'test-module',
    sourceRelativePath: kind === 'update-claude-settings'
      ? 'hooks/hooks.json'
      : 'rules/common/coding-style.md',
    destinationPath,
    strategy: kind,
    ownership: 'managed',
    scaffoldOnly: false,
    ...overrides,
  };
  if (
    kind === 'copy-file'
    && !Object.prototype.hasOwnProperty.call(overrides, 'contentSha256')
  ) {
    let descriptor;
    try {
      descriptor = fs.openSync(
        destinationPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      const openedStat = fs.fstatSync(descriptor, { bigint: true });
      const finalPathStat = fs.lstatSync(destinationPath, { bigint: true });
      const identityMatches = openedStat.ino === finalPathStat.ino
        && (!openedStat.dev || !finalPathStat.dev || openedStat.dev === finalPathStat.dev);
      if (
        openedStat.isFile()
        && finalPathStat.isFile()
        && !finalPathStat.isSymbolicLink()
        && identityMatches
      ) {
        operation.contentSha256 = crypto.createHash('sha256')
          .update(fs.readFileSync(descriptor))
          .digest('hex');
      }
    } catch (error) {
      if (!['ENOENT', 'ELOOP'].includes(error.code)) {
        throw error;
      }
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
    }
  }
  return operation;
}

function runTests() {
  console.log('\n=== Testing install-lifecycle.js ===\n');

  let passed = 0;
  let failed = 0;

  if (test('managed-operation digest never follows a final symlink', () => {
    const tempDir = createTempDir('install-lifecycle-symlink-digest-');
    const victimPath = path.join(tempDir, 'victim.md');
    const symlinkPath = path.join(tempDir, 'managed.md');
    try {
      fs.writeFileSync(victimPath, 'user content\n');
      try {
        fs.symlinkSync(victimPath, symlinkPath, 'file');
      } catch {
        console.log('    (file symlink unsupported on this platform; skipping)');
        return;
      }
      const operation = managedOperation('copy-file', symlinkPath);
      assert.strictEqual(operation.contentSha256, undefined);
    } finally {
      cleanup(tempDir);
    }
  })) passed++; else failed++;

  if (test('doctor reports a healthy legacy install when managed files are present', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const statePath = path.join(targetRoot, 'ecc', 'install-state.json');
      const managedFile = path.join(targetRoot, 'rules', 'common', 'coding-style.md');
      const sourceContent = fs.readFileSync(path.join(REPO_ROOT, 'rules', 'common', 'coding-style.md'), 'utf8');
      fs.mkdirSync(path.dirname(managedFile), { recursive: true });
      fs.writeFileSync(managedFile, sourceContent);

      writeState(statePath, {
        adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-claude-rules'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'copy-file',
            moduleId: 'legacy-claude-rules',
            sourceRelativePath: 'rules/common/coding-style.md',
            destinationPath: managedFile,
            strategy: 'preserve-relative-path',
            ownership: 'managed',
            scaffoldOnly: false,
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(report.results.length, 1);
      assert.strictEqual(report.results[0].status, 'ok');
      assert.strictEqual(report.results[0].issues.length, 0);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('Claude repair and dry-run preserve user-owned flat skills during legacy migration', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const installStatePath = path.join(targetRoot, 'ecc', 'install-state.json');
      const flatSkillPath = path.join(targetRoot, 'skills', 'tdd-workflow', 'SKILL.md');
      const legacySkillPath = path.join(
        targetRoot,
        'skills',
        'ecc',
        'tdd-workflow',
        'SKILL.md'
      );
      fs.mkdirSync(path.dirname(flatSkillPath), { recursive: true });
      fs.mkdirSync(path.dirname(legacySkillPath), { recursive: true });
      fs.writeFileSync(flatSkillPath, '# User-owned flat skill\n');
      fs.writeFileSync(legacySkillPath, '# Previously managed nested skill\n');

      writeState(installStatePath, {
        adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
        targetRoot,
        installStatePath,
        request: {
          profile: null,
          modules: ['workflow-quality'],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs', 'workflow-quality'],
          skippedModules: [],
        },
        operations: [{
          kind: 'copy-file',
          moduleId: 'workflow-quality',
          sourcePath: path.join(REPO_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'),
          sourceRelativePath: path.join('skills', 'tdd-workflow', 'SKILL.md'),
          destinationPath: legacySkillPath,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        }],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const dryRun = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
        dryRun: true,
      });
      assert.ok(!dryRun.results[0].plannedRepairs.includes(flatSkillPath));
      assert.ok(dryRun.results[0].warnings.some(warning => warning.includes('user-owned')));
      assert.strictEqual(fs.readFileSync(flatSkillPath, 'utf8'), '# User-owned flat skill\n');
      assert.strictEqual(
        fs.readFileSync(legacySkillPath, 'utf8'),
        '# Previously managed nested skill\n'
      );

      const repaired = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(repaired.results[0].status, 'repaired');
      assert.ok(repaired.results[0].warnings.some(warning => warning.includes('user-owned')));
      assert.strictEqual(fs.readFileSync(flatSkillPath, 'utf8'), '# User-owned flat skill\n');
      assert.strictEqual(
        fs.readFileSync(legacySkillPath, 'utf8'),
        fs.readFileSync(
          path.join(REPO_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'),
          'utf8'
        )
      );
      const repairedState = JSON.parse(fs.readFileSync(installStatePath, 'utf8'));
      assert.ok(repairedState.operations.some(operation => (
        operation.destinationPath === legacySkillPath
      )));
      assert.ok(!repairedState.operations.some(operation => (
        operation.destinationPath === flatSkillPath
      )));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('Claude repair migration derives roots from the adapter and removes only the managed legacy file', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');
    const outsideRoot = createTempDir('install-lifecycle-outside-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const adapterStatePath = path.join(targetRoot, 'ecc', 'install-state.json');
      const recordedStatePath = path.join(outsideRoot, 'recorded-state.json');
      const flatSkillPath = path.join(targetRoot, 'skills', 'tdd-workflow', 'SKILL.md');
      const legacySkillPath = path.join(
        targetRoot,
        'skills',
        'ecc',
        'tdd-workflow',
        'SKILL.md'
      );
      fs.mkdirSync(path.dirname(legacySkillPath), { recursive: true });
      fs.writeFileSync(legacySkillPath, '# Previously managed nested skill\n');

      writeState(adapterStatePath, {
        adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
        targetRoot: outsideRoot,
        installStatePath: recordedStatePath,
        request: {
          profile: null,
          modules: ['workflow-quality'],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs', 'workflow-quality'],
          skippedModules: [],
        },
        operations: [{
          kind: 'copy-file',
          moduleId: 'workflow-quality',
          sourcePath: path.join(REPO_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'),
          sourceRelativePath: path.join('skills', 'tdd-workflow', 'SKILL.md'),
          destinationPath: legacySkillPath,
          strategy: 'preserve-relative-path',
          ownership: 'managed',
          scaffoldOnly: false,
        }],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });
      fs.writeFileSync(recordedStatePath, 'outside sentinel\n');

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      assert.strictEqual(
        fs.readFileSync(flatSkillPath, 'utf8'),
        fs.readFileSync(
          path.join(REPO_ROOT, 'skills', 'tdd-workflow', 'SKILL.md'),
          'utf8'
        )
      );
      assert.ok(!fs.existsSync(legacySkillPath));
      assert.strictEqual(fs.readFileSync(recordedStatePath, 'utf8'), 'outside sentinel\n');
      const refreshedState = readInstallState(adapterStatePath);
      assert.strictEqual(refreshedState.target.root, targetRoot);
      assert.strictEqual(refreshedState.target.installStatePath, adapterStatePath);
      assert.ok(refreshedState.operations.some(operation => (
        operation.destinationPath === flatSkillPath
      )));
      assert.ok(!refreshedState.operations.some(operation => (
        operation.destinationPath === legacySkillPath
      )));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
      cleanup(outsideRoot);
    }
  })) passed++; else failed++;

  if (test('withTemporarilyMovedPath cleans up newly created paths when nothing was pre-existing', () => {
    const filePath = path.join(REPO_ROOT, '.opencode', 'dist');
    const backupPath = `${filePath}.backup-${process.pid}-test`;

    try {
      fs.rmSync(filePath, { recursive: true, force: true });
      fs.rmSync(backupPath, { recursive: true, force: true });

      const result = withTemporarilyMovedPath(filePath, receivedBackupPath => {
        assert.strictEqual(receivedBackupPath, null);
        fs.mkdirSync(path.join(filePath, 'plugins'), { recursive: true });
        fs.mkdirSync(path.join(filePath, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(filePath, 'index.js'), '// temp build\n');
        return 'callback-result';
      });

      assert.strictEqual(result, 'callback-result');
      assert.ok(!fs.existsSync(filePath), 'Temporary path should be removed after the callback');
    } finally {
      fs.rmSync(filePath, { recursive: true, force: true });
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
  })) passed++; else failed++;

  if (test('repair restores render-template outputs from recorded rendered content', () => {
    const homeDir = createTempDir('install-lifecycle-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const statePath = path.join(targetRoot, 'ecc', 'install-state.json');
      const destinationPath = path.join(targetRoot, 'plugin.json');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, '{"drifted":true}\n');

      writeState(statePath, {
        adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: null,
          modules: [],
          legacyLanguages: ['typescript'],
          legacyMode: true,
        },
        resolution: {
          selectedModules: ['legacy-claude-rules'],
          skippedModules: [],
        },
        operations: [
          {
            kind: 'render-template',
            moduleId: 'platform-configs',
            sourceRelativePath: '.claude-plugin/plugin.json.template',
            destinationPath,
            strategy: 'render-template',
            ownership: 'managed',
            scaffoldOnly: false,
            renderedContent: '{"ok":true}\n',
          },
        ],
        source: {
          repoVersion: CURRENT_PACKAGE_VERSION,
          repoCommit: 'abc123',
          manifestVersion: CURRENT_MANIFEST_VERSION,
        },
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      assert.strictEqual(fs.readFileSync(destinationPath, 'utf8'), '{"ok":true}\n');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall restores rendered template files from recorded previous content', () => {
    const tempDir = createTempDir('install-lifecycle-');

    try {
      const targetRoot = path.join(tempDir, '.claude');
      const statePath = path.join(targetRoot, 'ecc', 'install-state.json');
      const destinationPath = path.join(targetRoot, 'plugin.json');
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.writeFileSync(destinationPath, '{"generated":true}\n');

      writeInstallState(statePath, createInstallState({
        adapter: { id: 'claude-home', target: 'claude', kind: 'home' },
        targetRoot,
        installStatePath: statePath,
        request: {
          profile: 'core',
          modules: ['platform-configs'],
          includeComponents: [],
          excludeComponents: [],
          legacyLanguages: [],
          legacyMode: false,
        },
        resolution: {
          selectedModules: ['platform-configs'],
          skippedModules: [],
        },
        source: {
          repoVersion: '1.8.0',
          repoCommit: 'abc123',
          manifestVersion: 1,
        },
        operations: [
          {
            kind: 'render-template',
            moduleId: 'platform-configs',
            sourceRelativePath: '.claude/plugin.json.template',
            destinationPath,
            strategy: 'render-template',
            ownership: 'managed',
            scaffoldOnly: false,
            renderedContent: '{"generated":true}\n',
            previousContent: '{"existing":true}\n',
          },
        ],
      }));

      const result = uninstallInstalledStates({
        homeDir: tempDir,
        projectRoot: tempDir,
        targets: ['claude'],
      });

      assert.strictEqual(result.summary.uninstalledCount, 1);
      assert.strictEqual(fs.readFileSync(destinationPath, 'utf8'), '{"existing":true}\n');
      assert.ok(!fs.existsSync(statePath));
    } finally {
      cleanup(tempDir);
    }
  })) passed++; else failed++;

  if (test('doctor inspects update-claude-settings hooks by event and id', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const managedHooks = currentManagedHooks(targetRoot);
      const stopEntry = managedHooks.Stop[0];
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: {
          Stop: [
            { id: 'user:stop', matcher: 'Bash', hooks: [{ type: 'command', command: 'user' }] },
            ...managedHooks.Stop,
          ],
          ...Object.fromEntries(Object.entries(managedHooks).filter(([event]) => event !== 'Stop')),
        },
      }));
      writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      let report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(report.results[0].status, 'ok');

      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: {
          ...managedHooks,
          Stop: [
            { id: 'user:stop', matcher: 'Bash', hooks: [{ type: 'command', command: 'user' }] },
            { ...stopEntry, description: 'drifted' },
            ...managedHooks.Stop.slice(1),
          ],
        },
      }));
      report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(report.results[0].status, 'warning');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'drifted-managed-files'));

      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: {
          ...managedHooks,
          Stop: managedHooks.Stop.filter(entry => entry.id !== stopEntry.id),
        },
      }));
      report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(report.results[0].status, 'error');
      assert.ok(report.results[0].issues.some(issue => issue.code === 'missing-managed-files'));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('doctor and repair surface malformed Claude settings errors', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const managedHooks = currentManagedHooks(targetRoot);
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(settingsPath, '{ invalid json\n');
      writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      const report = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      const issue = report.results[0].issues.find(candidate => (
        candidate.code === 'invalid-claude-settings'
      ));
      assert.strictEqual(report.results[0].status, 'error');
      assert.ok(issue, 'doctor should report an invalid Claude settings issue');
      assert.match(issue.message, /Failed to inspect Claude settings/);

      const repair = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      assert.strictEqual(repair.results[0].status, 'error');
      assert.match(repair.results[0].error, /Failed to inspect Claude settings/);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{ invalid json\n');
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair restores managed Claude hooks while preserving user settings and hooks', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const userHook = {
        id: 'user:stop',
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'user-command' }],
      };
      const managedHooks = currentManagedHooks(targetRoot);
      const stopEntry = managedHooks.Stop[0];
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: {
          ...managedHooks,
          Stop: [
            userHook,
            { ...stopEntry, description: 'drifted' },
            ...managedHooks.Stop.slice(1),
          ],
        },
      }));
      writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      assert.ok(result.results[0].repairedPaths.includes(settingsPath));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
        theme: 'dark',
        hooks: {
          ...managedHooks,
          Stop: [userHook, ...managedHooks.Stop],
        },
      });
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair creates missing Claude settings with private permissions', () => {
    if (process.platform === 'win32') {
      console.log('    (POSIX file modes unsupported on this platform; skipping)');
      return;
    }
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const managedHooks = currentManagedHooks(targetRoot);
      fs.mkdirSync(targetRoot, { recursive: true });
      writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      const descriptor = fs.openSync(settingsPath, 'r');
      try {
        assert.strictEqual(fs.fstatSync(descriptor).mode & 0o777, 0o600);
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(descriptor, 'utf8')).hooks, managedHooks);
      } finally {
        fs.closeSync(descriptor);
      }
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('repair removes retired managed hooks using the recorded ownership snapshot', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const currentHooks = currentManagedHooks(targetRoot);
      const retiredHook = managedHookEntry('ecc:retired', 'node retired.js');
      const recordedHooks = {
        ...currentHooks,
        Stop: [...currentHooks.Stop, retiredHook],
      };
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: recordedHooks,
      }));
      writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            managedHooks: recordedHooks,
          }),
        ],
      });

      const result = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'repaired');
      const repaired = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(!repaired.hooks.Stop.some(entry => entry.id === 'ecc:retired'));
      assert.deepStrictEqual(repaired.hooks, currentHooks);
      const state = readInstallState(path.join(targetRoot, 'ecc', 'install-state.json'));
      const settingsOperation = state.operations.find(operation => (
        operation.kind === 'update-claude-settings'
      ));
      assert.deepStrictEqual(settingsOperation.managedHooks, currentHooks);
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall removes only unchanged managed Claude hooks and reports drift as partial', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const managedHooks = {
        SessionStart: [managedHookEntry('ecc:start', 'node managed-start.js')],
        Stop: [managedHookEntry('ecc:stop', 'node managed-stop.js')],
      };
      const userHook = {
        id: 'user:stop',
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'user-command' }],
      };
      const driftedHook = managedHookEntry('ecc:stop', 'node user-edited-stop.js');
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: {
          SessionStart: managedHooks.SessionStart,
          Stop: [userHook, driftedHook],
        },
      }));
      const { installStatePath } = writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'partial');
      assert.deepStrictEqual(result.results[0].retainedPaths, [settingsPath]);
      assert.ok(fs.existsSync(installStatePath));
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
        theme: 'dark',
        hooks: {
          Stop: [userHook, driftedHook],
        },
      });
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('uninstall clears empty hook containers but preserves unrelated Claude settings', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const managedHooks = {
        Stop: [managedHookEntry('ecc:stop', 'node managed-stop.js')],
      };
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(settingsPath, formatJson({
        theme: 'dark',
        hooks: managedHooks,
      }));
      const { installStatePath } = writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      const result = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(result.results[0].status, 'uninstalled');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), {
        theme: 'dark',
      });
      assert.ok(!fs.existsSync(installStatePath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('Claude settings lifecycle refuses a final-symlink destination', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const victimPath = path.join(targetRoot, 'victim.json');
      const settingsPath = path.join(targetRoot, 'settings.json');
      const managedHooks = {
        Stop: [managedHookEntry('ecc:stop', 'node managed-stop.js')],
      };
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(victimPath, formatJson({ sentinel: true, hooks: managedHooks }));
      try {
        fs.symlinkSync(victimPath, settingsPath, 'file');
      } catch {
        console.log('    (file symlink unsupported on this platform; skipping)');
        return;
      }
      writeClaudeState(homeDir, {
        operations: [
          managedOperation('update-claude-settings', settingsPath, {
            sourceRelativePath: 'hooks/hooks.json',
            strategy: 'update-claude-settings',
            managedHooks,
          }),
        ],
      });

      const doctor = buildDoctorReport({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      const repair = repairInstalledStates({
        repoRoot: REPO_ROOT,
        homeDir,
        projectRoot,
        targets: ['claude'],
      });
      const uninstall = uninstallInstalledStates({
        homeDir,
        projectRoot,
        targets: ['claude'],
      });

      assert.strictEqual(doctor.results[0].status, 'error');
      assert.ok(doctor.results[0].issues.some(issue => (
        issue.code === 'unsafe-managed-destination'
      )));
      assert.strictEqual(repair.results[0].status, 'error');
      assert.match(repair.results[0].error, /final symlink/);
      assert.strictEqual(uninstall.results[0].status, 'error');
      assert.match(uninstall.results[0].error, /final symlink/);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(victimPath, 'utf8')), {
        sentinel: true,
        hooks: managedHooks,
      });
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  if (test('Claude settings path validation refuses a non-canonical destination', () => {
    const homeDir = createTempDir('install-lifecycle-claude-home-');
    const projectRoot = createTempDir('install-lifecycle-project-');

    try {
      const targetRoot = path.join(homeDir, '.claude');
      const destinationPath = path.join(targetRoot, 'settings.local.json');
      fs.mkdirSync(targetRoot, { recursive: true });
      assert.throws(
        () => assertClaudeSettingsPath(destinationPath, targetRoot),
        /outside the canonical settings file/
      );
      assert.ok(!fs.existsSync(destinationPath));
    } finally {
      cleanup(homeDir);
      cleanup(projectRoot);
    }
  })) passed++; else failed++;

  console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
