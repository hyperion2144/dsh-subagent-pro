import test from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  _internal,
  fileIdFromPath,
  lastSegment,
  stripMdExt,
  loadAgentMdRolesAcrossWorkspaces,
} from '../agents-md.js'

const { parseFrontmatter, parseModel, parseTools, isKebabCase } = _internal

test('isKebabCase accepts valid ids', () => {
  assert.equal(isKebabCase('code-reviewer'), true)
  assert.equal(isKebabCase('translator'), true)
  assert.equal(isKebabCase('r2d2-c3po'), true)
})

test('isKebabCase rejects invalid ids', () => {
  assert.equal(isKebabCase('CodeReviewer'), false)
  assert.equal(isKebabCase('code_reviewer'), false)
  assert.equal(isKebabCase('-leading-hyphen'), false)
  assert.equal(isKebabCase('trailing-hyphen-'), false)
})

test('stripMdExt strips suffix', () => {
  assert.equal(stripMdExt('foo.md'), 'foo')
  assert.equal(stripMdExt('foo'), 'foo')
  assert.equal(stripMdExt('foo.MD'), 'foo.MD')
})

test('lastSegment handles both separators', () => {
  assert.equal(lastSegment('/a/b/c.md'), 'c.md')
  assert.equal(lastSegment('C:\\a\\b\\c.md'), 'c.md')
  assert.equal(lastSegment('plain.md'), 'plain.md')
  assert.equal(lastSegment(''), '')
})

test('fileIdFromPath composes correctly', () => {
  assert.equal(fileIdFromPath('/home/u/.dsh/agents/code-reviewer.md'), 'code-reviewer')
  assert.equal(fileIdFromPath('./tester.md'), 'tester')
})

test('parseFrontmatter: full frontmatter', () => {
  const raw = '---\nname: 代码审查员\ndescription: 审查代码\ntools: Read Grep\nmodel: sonnet\n---\n我是审查员。'
  const { fm, body, warnings } = parseFrontmatter(raw)
  assert.equal(fm.name, '代码审查员')
  assert.equal(fm.description, '审查代码')
  assert.equal(fm.tools, 'Read Grep')
  assert.equal(fm.model, 'sonnet')
  assert.equal(body, '我是审查员。')
  assert.equal(warnings.length, 0)
})

test('parseFrontmatter: no frontmatter returns raw body', () => {
  const raw = 'just a plain markdown body'
  const { fm, body, warnings } = parseFrontmatter(raw)
  assert.deepEqual(fm, {})
  assert.equal(body, raw)
  assert.equal(warnings.length, 0)
})

test('parseFrontmatter: unterminated frontmatter returns warning', () => {
  const raw = '---\nname: foo'
  const { warnings } = parseFrontmatter(raw)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /unterminated/)
})

test('parseModel splits provider and model', () => {
  assert.deepEqual(parseModel('anthropic/sonnet'), { provider: 'anthropic', model: 'sonnet' })
  assert.deepEqual(parseModel('sonnet'), { model: 'sonnet' })
  assert.deepEqual(parseModel(undefined), {})
  assert.deepEqual(parseModel(''), {})
})

test('parseTools splits whitespace', () => {
  assert.deepEqual(parseTools('Read Grep Glob'), ['Read', 'Grep', 'Glob'])
  assert.deepEqual(parseTools('Read'), ['Read'])
  assert.equal(parseTools(''), undefined)
  assert.equal(parseTools(undefined), undefined)
})

// ---- mergeRoles: project wins, altPaths records loser ----

const { mergeRoles } = _internal

test('mergeRoles: project always wins on the role payload', () => {
  const projectRole = {
    displayName: 'Project Copy',
    description: 'project description',
    source: 'project-md' as const,
    filePath: '/ws/foo/.dsh/agents/tester.md',
  }
  const globalRole = {
    displayName: 'Global Copy',
    description: 'global description',
    source: 'global-md' as const,
    filePath: '/home/.dsh/agents/tester.md',
  }
  const merged = mergeRoles([globalRole], [projectRole])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.displayName, 'Project Copy')
  assert.equal(merged[0]!.source, 'project-md')
  assert.equal(merged[0]!.isOverride, true)
  assert.deepEqual(merged[0]!.altPaths, ['/home/.dsh/agents/tester.md'])
})

test('mergeRoles: global-only roles flow through without altPaths', () => {
  const globalRole = {
    displayName: 'Solo',
    description: 'only in global',
    source: 'global-md' as const,
    filePath: '/home/.dsh/agents/solo.md',
  }
  const merged = mergeRoles([globalRole], [])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]!.displayName, 'Solo')
  assert.equal(merged[0]!.source, 'global-md')
  assert.equal(merged[0]!.isOverride, undefined)
  assert.equal(merged[0]!.altPaths, undefined)
})

// ---- loadAgentMdRolesAcrossWorkspaces: reads every workspace ----

function writeRoleMd(dir: string, id: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, id + '.md'), body)
}

const ROLE_FM = (name: string, desc: string): string =>
  '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n'

test('loadAgentMdRolesAcrossWorkspaces merges global + every workspace project', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-md-'))
  try {
    const globalDir = join(root, 'global')
    const wsADir = join(root, 'wsA', '.dsh', 'agents')
    const wsBDir = join(root, 'wsB', '.dsh', 'agents')

    writeRoleMd(globalDir, 'onboard-guide', ROLE_FM('Onboard Guide', 'global-only'))
    writeRoleMd(wsADir, 'code-reviewer', ROLE_FM('Code Reviewer A', 'project A only'))
    writeRoleMd(wsBDir, 'tester', ROLE_FM('Tester B', 'project B only'))
    writeRoleMd(wsBDir, 'onboard-guide', ROLE_FM('Onboard Guide B', 'project B override'))

    const ctx = {
      workspaceRegistry: {
        list: () => [
          { path: join(root, 'wsA') },
          { path: join(root, 'wsB') },
        ],
      },
    }
    const result = loadAgentMdRolesAcrossWorkspaces(
      ctx,
      globalDir,
      '.dsh/agents',
    )
    assert.equal(result.warnings.length, 0)

    const byId = new Map(
      result.roles.map((r) => [
        (r.filePath ?? '').split('/').pop()!.replace('.md', ''),
        r,
      ]),
    )
    assert.equal(byId.size, 3, 'three distinct ids')

    const codeReviewer = byId.get('code-reviewer')!
    assert.equal(codeReviewer.source, 'project-md')
    assert.equal(codeReviewer.displayName, 'Code Reviewer A')
    assert.equal(codeReviewer.isOverride, undefined)
    assert.equal(codeReviewer.altPaths, undefined)

    const tester = byId.get('tester')!
    assert.equal(tester.source, 'project-md')
    assert.equal(tester.displayName, 'Tester B')
    assert.equal(tester.isOverride, undefined)

    const onboardGuide = byId.get('onboard-guide')!
    assert.equal(onboardGuide.source, 'project-md', 'project wins over global on shared id')
    assert.equal(onboardGuide.displayName, 'Onboard Guide B')
    assert.equal(onboardGuide.isOverride, true)
    assert.deepEqual(onboardGuide.altPaths, [join(globalDir, 'onboard-guide.md')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadAgentMdRolesAcrossWorkspaces falls back to shell cwd when registry absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-md-cwd-'))
  try {
    const globalDir = join(root, 'global')
    const cwd = join(root, 'cwd')
    writeRoleMd(globalDir, 'solo', ROLE_FM('Solo', 'only global'))
    writeRoleMd(join(cwd, '.dsh', 'agents'), 'cwd-role', ROLE_FM('Cwd Role', 'from cwd'))

    // No workspaceRegistry at all — the loader must still scan the shell cwd
    // (documented fallback), so headless profiles keep project md roles.
    const ctx = {
      get: (name: string) => (name === 'shell' ? { cwd } : undefined),
    }
    const result = loadAgentMdRolesAcrossWorkspaces(ctx, globalDir, '.dsh/agents')
    const ids = new Set(
      result.roles.map((r) => (r.filePath ?? '').split('/').pop()!.replace('.md', '')),
    )
    assert.equal(result.roles.length, 2, 'global + cwd project roles')
    assert.equal(ids.has('cwd-role'), true)
    assert.equal(ids.has('solo'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadAgentMdRolesAcrossWorkspaces falls back to no workspaces gracefully', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-md-empty-'))
  try {
    const globalDir = join(root, 'global')
    writeRoleMd(globalDir, 'solo', ROLE_FM('Solo', 'only global'))

    // workspaceRegistry.list throws — should not break the load.
    const ctx = {
      workspaceRegistry: {
        list: () => {
          throw new Error('boom')
        },
      },
    }
    const result = loadAgentMdRolesAcrossWorkspaces(
      ctx,
      globalDir,
      '.dsh/agents',
    )
    assert.equal(result.roles.length, 1)
    assert.equal(
      (result.roles[0]!.filePath ?? '').split('/').pop()!.replace('.md', ''),
      'solo',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
