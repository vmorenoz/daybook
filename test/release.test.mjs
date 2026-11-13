import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
