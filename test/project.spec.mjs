/** Pure behaviour: route matching, the projection, counters, and fail-open. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGuard, matchPattern, matchesRoute, normalizeRoutes, projectRequest } from '../lib/index.js'
import { addition, recordedRequest, removal, user } from './fixtures/history.mjs'

test('matchPattern treats * as the only wildcard and anchors both ends', () => {
  assert.equal(matchPattern('claude-*', 'claude-opus-4-8'), true)
  assert.equal(matchPattern('claude-*', 'clode-opus'), false)
  assert.equal(matchPattern('claude-*-v1', 'claude-3-v1'), true)
  assert.equal(matchPattern('claude-*-v1', 'claude-3-v1x'), false)
  assert.equal(matchPattern('*opus*', 'claude-opus-4-8'), true)
  assert.equal(matchPattern('exact', 'exact'), true)
  assert.equal(matchPattern('exact', 'exactly'), false)
  assert.equal(matchPattern('a.b', 'axb'), false)
  assert.equal(matchPattern('', 'anything'), false)
  assert.equal(matchPattern('*', 'anything'), true)
  assert.equal(matchPattern('claude', undefined), false)
})

test('matchesRoute constrains only the fields an entry names', () => {
  const routes = normalizeRoutes([{ provider: 'anthropic' }, { model: 'claude-*' }, { provider: 'proxy', model: 'x*' }])
  assert.equal(matchesRoute(routes, 'anthropic', 'anything'), true)
  assert.equal(matchesRoute(routes, 'other', 'claude-opus-4-8'), true)
  assert.equal(matchesRoute(routes, 'proxy', 'xyz'), true)
  assert.equal(matchesRoute(routes, 'proxy', 'abc'), false)
  assert.equal(matchesRoute([], 'proxy', 'abc'), false)
})

test('normalizeRoutes drops entries that constrain nothing', () => {
  assert.deepEqual(normalizeRoutes([{}, { provider: '' }, { model: 'm' }, null, 'x']), [{ model: 'm' }])
  assert.deepEqual(normalizeRoutes(undefined), [])
})

test('projectRequest removes developer messages and clears deferred declarations', () => {
  const request = recordedRequest()
  const projected = projectRequest(request)
  assert.equal(projected.changed, true)
  assert.equal(projected.additions, 1)
  assert.equal(projected.removals, 0)
  assert.equal(projected.deferred, 1)
  assert.equal(projected.messages.some(message => message.role === 'developer'), false)
  assert.equal(projected.tools.some(tool => tool.deferLoading === true), false)
})

test('projectRequest counts every tool-change block, including removals', () => {
  const remove = removal('read')
  const request = {
    provider: 'guarded',
    model: 'declaring',
    messages: [user('first'), addition(), remove],
    tools: undefined,
    toolHistory: { tools: [], updates: [] },
  }
  const projected = projectRequest(request)
  assert.equal(projected.changed, true)
  assert.equal(projected.additions, 1)
  assert.equal(projected.removals, 1)
  assert.equal(projected.deferred, 0)
})

test('projectRequest reports no change for a history without tool updates', () => {
  const request = { provider: 'guarded', model: 'declaring', messages: [user('only')], tools: [] }
  const projected = projectRequest(request)
  assert.equal(projected.changed, false)
  assert.equal(projected.messages, request.messages)
  assert.equal(projected.tools, request.tools)
})

test('the guard passes unmatched routes through untouched', () => {
  const guard = createGuard({ routes: [{ provider: 'other' }] })
  const request = recordedRequest()
  let continued = false
  const stream = guard.handle(() => assert.fail('must not redispatch'), request, () => {
    continued = true
    return 'original'
  })
  assert.equal(stream, 'original')
  assert.equal(continued, true)
  assert.equal(guard.stats.projected, 0)
})

test('the guard redispatches a matched projected request exactly once', () => {
  const guard = createGuard({ routes: [{ provider: 'guarded' }] })
  const request = recordedRequest()
  const dispatched = []
  const result = guard.handle((replacement) => {
    dispatched.push(replacement)
    return 'projected'
  }, request, () => 'original')
  assert.equal(result, 'projected')
  assert.equal(dispatched.length, 1)
  assert.equal(guard.stats.projected, 1)
  assert.equal(guard.stats.additions, 1)
})

test('a redispatched request is not projected again', () => {
  const guard = createGuard({ routes: [{ provider: 'guarded' }] })
  const request = recordedRequest()
  let inner = null
  guard.handle((replacement) => {
    inner = replacement
    return 'projected'
  }, request, () => 'original')
  let continued = false
  guard.handle(() => assert.fail('must not redispatch twice'), inner, () => {
    continued = true
    return 'second'
  })
  assert.equal(continued, true)
})

test('a redispatch that loops back through the waterfall is counted once', () => {
  const guard = createGuard({ routes: [{ provider: 'guarded' }] })
  const dispatches = []
  // `stream` stands in for `ctx.llm.stream`, which re-enters this same listener
  // with the replacement: the second pass must be recognised, not reprojected.
  const stream = request => {
    dispatches.push(request)
    return guard.handle(stream, request, () => ({ dispatched: false }))
  }
  guard.handle(stream, recordedRequest(), () => assert.fail('expected a replacement'))
  assert.equal(dispatches.length, 1, 'exactly one redispatch may reach the transport')
  assert.equal(guard.stats.requests, 1, 'the looped-back request must not be counted twice')
  assert.equal(guard.stats.projected, 1, 'the looped-back request must not be projected twice')
})

test('the replacement omits a tool list the original did not carry', () => {
  const guard = createGuard({ routes: [{ provider: 'guarded' }] })
  const request = { provider: 'guarded', model: 'declaring', messages: [user('first'), addition()], toolHistory: { tools: [], updates: [] } }
  let replacement
  guard.handle(candidate => {
    replacement = candidate
    return 'projected'
  }, request, () => assert.fail('expected a replacement'))
  assert.equal(replacement.messages.length, 1)
  assert.equal('tools' in replacement, false, 'an absent tool list must stay absent')
  assert.equal('tools' in request, false, 'the original request must not grow one either')
})

test('audit mode reports without changing the request', () => {
  const warnings = []
  const guard = createGuard({ routes: [{ provider: 'guarded' }], audit: true }, { warn: message => warnings.push(message) })
  const request = recordedRequest()
  const result = guard.handle(() => assert.fail('audit must not redispatch'), request, () => 'original')
  assert.equal(result, 'original')
  assert.equal(guard.stats.projected, 1)
  assert.equal(warnings.length, 1)
})

test('a warning is emitted once per route', () => {
  const warnings = []
  const guard = createGuard({ routes: [{ provider: 'guarded' }], audit: true }, { warn: message => warnings.push(message) })
  guard.handle(() => 'x', recordedRequest(), () => 'original')
  guard.handle(() => 'x', recordedRequest(), () => 'original')
  assert.equal(warnings.length, 1)
})

test('a projection failure leaves the request alone', () => {
  const guard = createGuard({ routes: [{ provider: 'guarded' }] })
  let continued = false
  const result = guard.handle(() => assert.fail('must not redispatch'), { provider: 'guarded', model: 'm' }, () => {
    continued = true
    return 'original'
  })
  assert.equal(result, 'original')
  assert.equal(continued, true)
  assert.equal(guard.stats.projected, 0)
})
