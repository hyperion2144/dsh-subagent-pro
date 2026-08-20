import test from 'node:test'
import assert from 'node:assert/strict'

import {
  _internal,
  fileIdFromPath,
  lastSegment,
  stripMdExt,
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
