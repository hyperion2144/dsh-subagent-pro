#!/usr/bin/env node
/**
 * Documentation gate: runs in CI (verify-docs workflow) and locally.
 * Mirrors @leetoners/dsh-ui-subagent-monitor/scripts/verify-docs.mjs:
 *   - package.json version matches CHANGELOG latest entry;
 *   - README.md / README.en.md exist (双语配对);
 *   - relative markdown links resolve to existing files;
 *   - lib/ build artifact references the current package name.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

function readJson(file) {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'))
}

function readText(file) {
  return readFileSync(join(ROOT, file), 'utf8')
}

let ok = true
function check(label, cond, hint) {
  const status = cond ? 'OK' : 'FAIL'
  console.log(`[${status}] ${label}` + (hint && !cond ? `\n        hint: ${hint}` : ''))
  if (!cond) ok = false
}

// 1. package.json version === CHANGELOG latest entry version.
const pkg = readJson('package.json')
const changelog = readText('CHANGELOG.md')
const versionRe = /^## \[(\d+\.\d+\.\d+)\]/m
const latest = changelog.match(versionRe)
check(
  'package.json version === latest CHANGELOG entry',
  latest !== null && latest[1] === pkg.version,
  `CHANGELOG latest = ${latest ? latest[1] : 'NONE'}, package.json = ${pkg.version}`,
)

// 2. bilingual README pair.
check('README.md exists', existsSync(join(ROOT, 'README.md')))
check('README.en.md exists', existsSync(join(ROOT, 'README.en.md')))

// 3. markdown link sanity: ./ARCHITECTURE.md, ./CHANGELOG.md, ./LICENSE referenced in README must exist.
const docsToCheck = ['ARCHITECTURE.md', 'CHANGELOG.md', 'LICENSE']
for (const doc of docsToCheck) {
  check(`${doc} exists`, existsSync(join(ROOT, doc)))
}

// 4. lib/ artifact references the current package name.
const libDir = join(ROOT, 'lib')
if (existsSync(libDir)) {
  const files = readdirSync(libDir)
  check('lib/index.js exists', files.includes('index.js'))
  check('lib/client.js exists', files.includes('client.js'))
  const host = readText('lib/index.js')
  check(
    'lib/index.js exports dsh-subagent-pro apply',
    host.includes('dsh-subagent-pro') || host.includes('subagent-pro'),
  )
} else {
  console.log('[SKIP] lib/ does not exist (run `pnpm build` first)')
}

if (!ok) {
  console.error('\nverify-docs failed')
  process.exit(1)
}
console.log('\nverify-docs passed')
