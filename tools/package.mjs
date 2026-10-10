// Builds the Foundry release files: dist/module.json and dist/table-talk.zip (module.json at the
// zip's root, as Foundry expects). Uses bsdtar (Windows, macOS) or zip (Linux), no npm packages.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mod = join(root, 'foundry-module')
const dist = join(root, 'dist')
const manifest = JSON.parse(readFileSync(join(mod, 'module.json'), 'utf8'))
const plugin = JSON.parse(readFileSync(join(root, 'claude-plugin', '.claude-plugin', 'plugin.json'), 'utf8'))
if (manifest.version !== plugin.version) {
  console.error(`version mismatch: module ${manifest.version}, plugin ${plugin.version}`)
  process.exit(1)
}
rmSync(dist, { recursive: true, force: true })
mkdirSync(dist)
const zip = join(dist, 'table-talk.zip')
const parts = ['module.json', 'scripts', 'styles', 'lang']
if (process.platform === 'linux') execFileSync('zip', ['-r', '-q', zip, ...parts], { cwd: mod, stdio: 'inherit' })
else {
  // On Windows, Git Bash's GNU tar can come first on PATH and can't write zips; use the system bsdtar.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-a', '-c', '-f', zip, '-C', mod, ...parts], { stdio: 'inherit' })
}
copyFileSync(join(mod, 'module.json'), join(dist, 'module.json'))
console.log(`built ${manifest.id} ${manifest.version}: dist/module.json, dist/table-talk.zip`)
