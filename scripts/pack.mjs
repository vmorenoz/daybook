import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function runNpm(args, env) {
  const npmPath = env.npm_execpath;
  const hasNpmPath = Boolean(npmPath && isAbsolute(npmPath) && await stat(npmPath).then((entry) => entry.isFile(), () => false));
  const command = hasNpmPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const commandArgs = hasNpmPath ? [npmPath, ...args] : args;
  await new Promise((fulfill, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: packageRoot,
      env,
      stdio: 'inherit',
      // Windows .cmd fallback requires a shell; all arguments here are fixed literals.
      shell: !hasNpmPath && process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) fulfill();
      else reject(Object.assign(new Error(`npm ${args.join(' ')} failed (${signal || code}).`), { exitCode: code || 1 }));
    });
  });
}

export async function pack({ env = process.env } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Daybook requires Node.js >=24.');
  const buildEnv = { ...env, DAYBOOK_SKIP_SETUP: '1' };
  await runNpm(['run', 'build'], buildEnv);
  await mkdir(resolve(packageRoot, 'releases'), { recursive: true });
  await runNpm(['pack', '--ignore-scripts', '--pack-destination', 'releases'], buildEnv);
  console.log('Package created in releases/. No global installation or MCP configuration changes were performed.');
  console.log('The .tgz does not bundle dependencies: npm needs registry access or a complete cache to install them.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await pack();
  } catch (error) {
    console.error(`Could not package Daybook: ${error.message}`);
    process.exitCode = error.exitCode || 1;
  }
}
