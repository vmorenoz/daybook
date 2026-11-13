import { readFile } from 'node:fs/promises';

// Refuse to step past a partially published release: it requires human recovery.
const [tags, releases] = await Promise.all(process.argv.slice(2).map(async (path) =>
  JSON.parse(await readFile(path, 'utf8')).flat()));
const versions = tags.map(({ name }) => name).filter((name) => /^v\d+\.\d+\.\d+$/.test(name));
for (const tag of versions) {
  if (!/^v1\.0\.(0|[1-9]\d*)$/.test(tag)) throw new Error(`Unexpected stable tag: ${tag}`);
  const release = releases.find((item) => item.tag_name === tag);
  if (!release || release.draft || release.prerelease ||
      !release.assets.some((asset) => asset.name === `vicodev-daybook-${tag.slice(1)}.tgz` && asset.state === 'uploaded')) {
    throw new Error(`Incomplete release for ${tag}; resolve it manually before retrying.`);
  }
}
for (const release of releases) {
  if (/^v\d+\.\d+\.\d+$/.test(release.tag_name) && !versions.includes(release.tag_name)) {
    throw new Error(`Release without a matching tag: ${release.tag_name}`);
  }
}
const patches = versions.map((tag) => Number(tag.slice(5)));
if (patches.some((patch) => !Number.isSafeInteger(patch))) throw new Error('Patch number is too large.');
patches.sort((a, b) => a - b);
if (patches.some((patch, index) => patch !== index)) throw new Error('Release patch sequence has a gap.');
console.log(`1.0.${patches.length}`);
