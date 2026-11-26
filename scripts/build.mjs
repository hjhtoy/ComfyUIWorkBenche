import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const skill = join(dist, 'comfyui-api-workbench');
const assets = join(skill, 'assets');
const builder = join(skill, 'scripts', 'workbench.py');
const python = process.env.PYTHON || 'python3';

async function bundle(entry, output) {
  const { outputFiles } = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    charset: 'utf8',
    write: false,
    target: 'es2022',
  });
  // The script is delivered inline in the final HTML.
  const script = outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  await writeFile(output, script);
}

function runPython(args) {
  const result = spawnSync(python, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error('Python command failed: ' + args.join(' '));
}

await mkdir(assets, { recursive: true });
await cp(join(root, 'skill'), skill, { recursive: true });
await mkdir(join(skill, 'scripts'), { recursive: true });
await cp(join(root, 'scripts', 'workbench.py'), builder);

const [shell, baseCSS, themes, favicon] = await Promise.all(
  ['page.html', 'base.css', 'themes.css', 'frameform.ico'].map((file) =>
    readFile(join(root, 'src', 'ui', file)),
  ),
);
const html = shell
  .toString('utf8')
  .replace('APP_CSS', () => baseCSS.toString('utf8') + themes.toString('utf8'))
  .replace('APP_FAVICON', () => favicon.toString('base64'));
await Promise.all([
  writeFile(join(assets, 'workbench.html'), html),
  bundle('src/main.js', join(assets, 'workbench.js')),
]);

if (process.argv.includes('--test')) {
  const testDir = join(dist, 'tests');
  await mkdir(testDir, { recursive: true });
  await bundle('tests/browser-entry.js', join(testDir, 'workbench.js'));
  const cases = [
    ['workflows/pika-h3', 'Frameform.html'],
    ['tests/fixtures/video', 'video.html'],
    ['tests/fixtures/image', 'image.html'],
    ['tests/fixtures/resize', 'resize.html'],
  ];
  for (const [input, output] of cases) {
    runPython([
      builder,
      'build',
      input + '.api.json',
      input + '.profile.json',
      join(testDir, output),
      '--app',
      join(testDir, 'workbench.js'),
    ]);
  }
}

const desktop = join(dist, 'Frameform.html');
const libraryBundle = join(dist, '.workflow-library.js');
await bundle('src/library/panel.js', libraryBundle);

runPython([
  builder,
  'build',
  'workflows/pika-h3.api.json',
  'workflows/pika-h3.profile.json',
  desktop,
]);

const [standalone, toolbar, libraryStyles, libraryScript] = await Promise.all([
  readFile(desktop, 'utf8'),
  readFile(join(root, 'src/library/panel.html'), 'utf8'),
  readFile(join(root, 'src/library/panel.css'), 'utf8'),
  readFile(libraryBundle, 'utf8'),
]);
if (process.argv.includes('--test')) {
  const standaloneDir = join(dist, 'tests', 'standalone');
  await mkdir(standaloneDir, { recursive: true });
  await writeFile(join(standaloneDir, 'Frameform.html'), standalone);
}
const shellJSON = JSON.stringify(html).replace(/</g, '\\u003c');
const integrated = standalone
  .replace(
    '<html lang="zh-CN">',
    '<html lang="zh-CN" data-workbench-id="pika-h3">',
  )
  .replace(
    '</head>',
    () =>
      '<style id="workflowLibraryStyles">\n' +
      libraryStyles +
      '</style></head>',
  )
  .replace(
    '<body>',
    () =>
      '<body class="workbench-unified">\n' +
      toolbar +
      '<div id="builtinWorkbench">',
  )
  .replace(
    '</body>',
    () =>
      '</div>\n<script type="application/json" id="workflowWorkspaceTemplate">' +
      shellJSON +
      '</script>\n<script>\n' +
      libraryScript +
      '</script>\n</body>',
  );
await writeFile(desktop, integrated);
await unlink(libraryBundle);
runPython([join(root, 'scripts', 'package_skill.py'), skill]);
