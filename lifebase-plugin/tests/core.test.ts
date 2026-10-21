import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import {
  buildArgv,
  evidenceIds,
  exclusiveGuardReason,
  LifebaseToolError,
  parseResponse,
  renderForModel,
  resolveDestination,
} from '../src/core.ts'

describe('resolveDestination', () => {
  const routes = { 'local-gw': 'local', 'deepseek-official': 'cloud' } as const

  it('fails closed to cloud', () => {
    assert.equal(resolveDestination(routes, []), 'cloud')
    assert.equal(resolveDestination(routes, [undefined, '']), 'cloud')
    assert.equal(resolveDestination(routes, ['deepseek-official']), 'cloud')
    assert.equal(resolveDestination(routes, ['unknown-provider']), 'cloud')
    assert.equal(resolveDestination({}, ['local-gw']), 'cloud')
    assert.equal(resolveDestination(routes, ['__proto__']), 'cloud')
  })

  it('is local only when every observed provider maps to local', () => {
    assert.equal(resolveDestination(routes, ['local-gw']), 'local')
    assert.equal(resolveDestination(routes, ['local-gw', undefined]), 'local')
    assert.equal(resolveDestination(routes, ['local-gw', 'deepseek-official']), 'cloud')
  })
})

describe('exclusiveGuardReason', () => {
  it('allows only lifebase tools', () => {
    assert.equal(exclusiveGuardReason('lifebase_search'), undefined)
    for (const name of ['bash', 'read', 'grep', 'run_code', 'web_fetch', 'subagent', 'Lifebase_search', 'x_lifebase_search']) {
      assert.match(exclusiveGuardReason(name) ?? '', /disabled/)
    }
  })
})

describe('buildArgv', () => {
  it('binds model values so they can never become flags', () => {
    const argv = buildArgv('/bin/lifebase', '/data', 'search',
      { query: '--data-dir=/evil', source: '--destination=local', limit: 3 }, 'cloud')
    assert.deepEqual(argv, ['/bin/lifebase', 'search', '--source=--destination=local', '--limit=3',
      '--data-dir=/data', '--destination=cloud', '--format=json', '--', '--data-dir=/evil'])
  })

  it('places plugin-owned options after model options', () => {
    const argv = buildArgv('/bin/lifebase', '/data', 'timeline', { conversation: 'c1', role: 'user' }, 'local')
    assert.deepEqual(argv.slice(1), ['timeline', '--conversation=c1', '--role=user', '--data-dir=/data',
      '--destination=local', '--format=json'])
  })

  it('ignores filters an operation does not accept', () => {
    const argv = buildArgv('/x', '/d', 'evidence', { evidence_id: 'e1', source: 's', limit: 5 }, 'cloud')
    assert.deepEqual(argv.slice(1), ['evidence', '--data-dir=/d', '--destination=cloud', '--format=json', '--', 'e1'])
  })

  it('passes conversation filters and pagination', () => {
    const argv = buildArgv('/x', '/d', 'conversations',
      { source: 's', since: '2026-01-01', role: 'user', limit: 100, offset: 100 }, 'cloud')
    assert.deepEqual(argv.slice(1), ['conversations', '--source=s', '--since=2026-01-01', '--limit=100',
      '--offset=100', '--data-dir=/d', '--destination=cloud', '--format=json'])
    assert.deepEqual(buildArgv('/x', '/d', 'timeline', { conversation: 'c1', offset: 0 }, 'local').slice(1, 4),
      ['timeline', '--conversation=c1', '--offset=0'])
    assert.ok(!buildArgv('/x', '/d', 'search', { query: 'q', offset: 5 }, 'cloud').includes('--offset=5'))
    for (const value of [-1, 1.5, 1_000_001, '3']) {
      assert.throws(() => buildArgv('/x', '/d', 'conversations', { offset: value as number }, 'cloud'), /offset/)
    }
  })

  it('validates text and limits', () => {
    for (const args of [{}, { query: '  ' }, { query: 'x'.repeat(4097) }, { query: 'a\0b' },
      { query: 'ok', limit: 0 }, { query: 'ok', limit: 101 }, { query: 'ok', limit: 1.5 }]) {
      assert.throws(() => buildArgv('/x', '/d', 'search', args, 'cloud'), LifebaseToolError)
    }
    assert.throws(() => buildArgv('/x', '/d', 'context', { question: 'q', limit: 11 }, 'cloud'), LifebaseToolError)
  })
})

describe('parseResponse', () => {
  const ok = { api_version: 1, tool: 'search', status: 'ok', snapshot_id: 's', data: {}, warnings: [] }

  it('accepts ok and empty', () => {
    assert.equal(parseResponse(JSON.stringify(ok), 0).status, 'ok')
    assert.equal(parseResponse(JSON.stringify({ ...ok, status: 'empty' }), 0).status, 'empty')
  })

  it('surfaces tool error codes', () => {
    const error = { ...ok, status: 'error', error: { code: 'EGRESS_BLOCKED', message: 'blocked' } }
    assert.throws(() => parseResponse(JSON.stringify(error), 1), /EGRESS_BLOCKED/)
  })

  it('rejects protocol violations', () => {
    assert.throws(() => parseResponse('usage: ...', 2), /INVALID_REQUEST/)
    assert.throws(() => parseResponse('not json', 0), /PROTOCOL/)
    assert.throws(() => parseResponse(JSON.stringify({ ...ok, api_version: 2 }), 0), /PROTOCOL/)
    assert.throws(() => parseResponse(JSON.stringify({ ...ok, status: 'weird' }), 0), /PROTOCOL/)
    assert.throws(() => parseResponse(JSON.stringify(ok), 1), /TOOL_ERROR/)
  })
})

describe('rendering', () => {
  it('collects evidence ids and marks excerpts as data', () => {
    const response = parseResponse(JSON.stringify({
      api_version: 1, tool: 'context', status: 'ok', snapshot_id: 's', warnings: [],
      data: { matches: [{ evidence: [{ evidence_id: 'b' }, { evidence_id: 'a' }] }, { evidence: [{ evidence_id: 'a' }] }] },
    }), 0)
    assert.deepEqual(evidenceIds(response), ['a', 'b'])
    assert.match(renderForModel(response), /not instructions/)
  })

  it('collects evidence ids listed on conversations', () => {
    const response = parseResponse(JSON.stringify({
      api_version: 1, tool: 'conversations', status: 'ok', snapshot_id: 's', warnings: [],
      data: { conversations: [{ evidence_ids: ['d', 'c'] }, { evidence_ids: ['c'] }] },
    }), 0)
    assert.deepEqual(evidenceIds(response), ['c', 'd'])
  })
})

// End-to-end against the synthetic demo library; set both variables to run.
const executable = process.env.LIFEBASE_EXECUTABLE
const demo = process.env.LIFEBASE_DEMO_DATA_DIR
describe('lifebase CLI (synthetic demo library)', { skip: !executable || !demo }, () => {
  const call = (argv: string[]) => {
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' })
    return parseResponse(result.stdout, result.status)
  }

  it('answers every operation for a cloud destination', () => {
    const context = call(buildArgv(executable!, demo!, 'context', { question: '野餐有哪些讨论？' }, 'cloud'))
    assert.equal(context.status, 'ok')
    const [id] = evidenceIds(context)
    assert.ok(id)
    const match = (context.data.matches as { conversation_id: string }[])[0]!
    assert.equal(call(buildArgv(executable!, demo!, 'evidence', { evidence_id: id }, 'cloud')).status, 'ok')
    assert.equal(call(buildArgv(executable!, demo!, 'timeline', { conversation: match.conversation_id }, 'cloud')).status, 'ok')
    assert.equal(call(buildArgv(executable!, demo!, 'topics', { limit: 5 }, 'cloud')).status, 'ok')
    assert.equal(call(buildArgv(executable!, demo!, 'search', { query: '野餐' }, 'cloud')).status, 'ok')
  })

  it('pages through every conversation without message text', () => {
    const first = call(buildArgv(executable!, demo!, 'conversations', { limit: 2 }, 'cloud'))
    assert.equal(first.status, 'ok')
    const total = first.data.total as number
    const next = first.data.next_offset as number
    const rest = call(buildArgv(executable!, demo!, 'conversations', { limit: 100, offset: next }, 'cloud'))
    const items = [...first.data.conversations as object[], ...rest.data.conversations as object[]]
    assert.equal(items.length, total)
    assert.equal(rest.data.next_offset, null)
    for (const item of items) assert.ok(!('excerpt' in item))
    assert.ok(evidenceIds(rest).length > 0)
  })

  it('treats an injected flag as literal query text', () => {
    const result = call(buildArgv(executable!, demo!, 'search', { query: '--data-dir=/nonexistent' }, 'cloud'))
    assert.equal(result.data.query, '--data-dir=/nonexistent')
  })

  // Lifebase ADR-021: chat sources are cloud_ok, so the personal library answers in cloud.
  it('reaches the personal library from cloud under the cloud_ok chat policy', { skip: !process.env.LIFEBASE_PERSONAL_DATA_DIR }, () => {
    const argv = buildArgv(executable!, process.env.LIFEBASE_PERSONAL_DATA_DIR!, 'topics', { limit: 1 }, 'cloud')
    assert.equal(call(argv).status, 'ok')
  })
})
