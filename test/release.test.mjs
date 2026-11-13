import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('release sequence starts at 1.0.0 and requires scoped tarball assets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'daybook-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (tags, releases) => {
    const tagsPath = join(dir, 'tags.json');
    const releasesPath = join(dir, 'releases.json');
    writeFileSync(tagsPath, JSON.stringify([tags]));
    writeFileSync(releasesPath, JSON.stringify([releases]));
    return spawnSync(process.execPath, ['scripts/next-release.mjs', tagsPath, releasesPath], { encoding: 'utf8' });
  };
  assert.equal(run([], []).stdout.trim(), '1.0.0');
  const tags = [{ name: 'v1.0.0' }];
  const release = { tag_name: 'v1.0.0', draft: false, prerelease: false, assets: [{ name: 'vmorenoz-daybook-1.0.0.tgz', state: 'uploaded' }] };
  assert.equal(run(tags, [release]).stdout.trim(), '1.0.1');
  release.assets[0].name = 'alba-daybook-1.0.0.tgz';
  const incomplete = run(tags, [release]);
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Incomplete release/);
});

test('workflow version command packs matching initial and subsequent versions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'daybook-version-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const command = workflow.split('\n').find(line => line.trim().startsWith('npm version '));
  assert.ok(command);
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'package-lock.json'), readFileSync('package-lock.json'));
  mkdirSync(join(dir, 'releases'));
  for (const version of ['1.0.0', '1.0.1']) {
    const run = spawnSync('bash', ['-euo', 'pipefail', '-c', command.trim()], { cwd: dir, env: { ...process.env, VERSION: version }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', 'releases'], { cwd: dir, encoding: 'utf8' });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = join(dir, 'releases', `vmorenoz-daybook-${version}.tgz`);
    const extracted = spawnSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(JSON.parse(extracted.stdout).version, version);
    assert.equal(JSON.parse(readFileSync(join(dir, 'package-lock.json'))).version, version);
  }
  const invalid = spawnSync('bash', ['-euo', 'pipefail', '-c', command.trim()], { cwd: dir, env: { ...process.env, VERSION: 'not-a-version' }, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
});

test('workflow cleanup removes only its isolated directories after artifact use', t => {
  const root = mkdtempSync(join(tmpdir(), 'daybook-cleanup-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.ok(workflow.indexOf('- name: Transfer verified tarball') < workflow.indexOf('- name: Clean transferred build artifact'));
  assert.ok(workflow.indexOf('- name: Create tag and publish release') < workflow.indexOf('- name: Clean validation files'));
  for (const [name, variable, prefix] of [['Clean isolated build files', 'BUILD_DIR', 'daybook-build'], ['Clean transferred build artifact', 'ARTIFACT_DIR', 'daybook-artifacts'], ['Clean validation files', 'VALIDATE_DIR', 'daybook-validate']]) {
    const step = workflow.split(`- name: ${name}\n`)[1];
    assert.match(step.split('        run: |\n')[0], /if: always\(\)/);
    const block = step.split('        run: |\n')[1].split(/\n(?=      - name:|  \w+:)/)[0];
    const script = block.split('\n').map(line => line.replace(/^          /, '')).join('\n');
    const owned = join(root, `${prefix}.0123456789`);
    const outside = join(root, 'preexisting');
    const artifacts = join(root, 'artifacts');
    mkdirSync(owned); mkdirSync(outside, { recursive: true }); mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'release.tgz'), 'keep');
    writeFileSync(join(owned, 'temporary.tgz'), 'remove');
    symlinkSync(artifacts, join(owned, 'releases'));
    const run = path => spawnSync('bash', ['-c', script], { env: { ...process.env, RUNNER_TEMP: root, [variable]: path }, encoding: 'utf8' });
    assert.notEqual(run(outside).status, 0);
    assert.ok(existsSync(outside));
    const result = run(owned);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(owned), false);
    assert.ok(existsSync(join(artifacts, 'release.tgz')));
    symlinkSync(outside, owned);
    assert.notEqual(run(owned).status, 0);
    assert.ok(existsSync(outside));
  }
});

test('publish commands specify the repository without a Git checkout', t => {
  const dir = mkdtempSync(join(tmpdir(), 'daybook-publish-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const step = workflow.split('- name: Create tag and publish release\n')[1];
  assert.ok(step);
  const block = step.split('        run: |\n')[1].split(/\n(?=      - name:|  \w+:)/)[0];
  const script = block.split('\n').map(line => line.replace(/^          /, '')).join('\n');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$GH_CALLS"\nif [[ "$1 $2" == "api repos/$GITHUB_REPOSITORY/git/ref/heads/main" ]]; then echo "$GITHUB_SHA"; fi\n`);
  chmodSync(gh, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_CALLS: join(dir, 'calls'), GITHUB_REPOSITORY: 'owner/project', GITHUB_SHA: 'abcdef', VERSION: '1.0.1', VALIDATE_DIR: dir };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  assert.notEqual(spawnSync('git', ['rev-parse', '--git-dir'], { cwd: dir, env }).status, 0);
  const result = spawnSync('bash', ['-c', script], { cwd: dir, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(env.GH_CALLS, 'utf8').trim().split('\n');
  assert.deepEqual(calls, [
    'api repos/owner/project/git/ref/heads/main --jq .object.sha',
    'api --method POST repos/owner/project/git/refs -f ref=refs/tags/v1.0.1 -f sha=abcdef',
    `release create v1.0.1 ${dir}/release-artifact/vmorenoz-daybook-1.0.1.tgz --repo owner/project --verify-tag --draft --title v1.0.1 --generate-notes`,
    'release edit v1.0.1 --repo owner/project --draft=false',
  ]);
});
