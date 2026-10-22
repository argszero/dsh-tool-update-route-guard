/**
 * Deny mid-conversation tool-update blocks on the routes an operator names.
 *
 * The harness records tool-registry changes as `developer` messages and sends
 * them to a route only when that route declares `toolUpdate`. The declaration
 * belongs to the model entry, not to the endpoint it is pointed at, so a
 * session repointed at an endpoint that does not honour mid-conversation tool
 * changes keeps sending `tool_addition` / `tool_removal` blocks. Because the
 * blocks are durable history, every later request resends them and the session
 * fails permanently.
 *
 * This plugin projects exactly those requests through the harness's own
 * unsupported-route shape (`projectToolUpdates(..., undefined, ...)`) before
 * dispatch. Durable history is untouched; only the outgoing request changes,
 * so a session already recorded under a capability the endpoint lacks becomes
 * usable again.
 *
 * @module dsh-tool-update-route-guard
 */

import { isAgentLoopRequest, markAgentLoopRequest, projectToolUpdates } from '@deepseek-ai/dsh-llm'

/** Plugin name reported by the loader. */
export const name = '@argszero/dsh-tool-update-route-guard'

/**
 * Hard requirement: the seam is dispatched on the LLM runtime, so an absent
 * instance must leave this plugin pending rather than loaded and inert.
 */
export const inject = ['llm']

const TOOL_CHANGE_TYPES = new Set(['tool-addition', 'tool-removal'])

/**
 * Match one glob pattern, where `*` is the only wildcard and every other
 * character stands for itself.
 * @param pattern - configured pattern; an empty string matches nothing.
 * @param value - provider or model id being routed.
 * @returns whether the whole value matches the whole pattern.
 */
export function matchPattern(pattern, value) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false
  if (typeof value !== 'string') return false
  if (!pattern.includes('*')) return pattern === value
  const body = pattern
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*')
  return new RegExp(`^${body}$`, 'u').test(value)
}

/**
 * Test one route list against the route a request is dispatched to.
 * An entry constrains only the fields it names, so `{ model: 'claude-*' }`
 * matches that model on every provider.
 * @param routes - normalized route entries.
 * @param provider - route key of the request.
 * @param model - exact model id of the request.
 * @returns whether any entry matches.
 */
export function matchesRoute(routes, provider, model) {
  return routes.some((route) => {
    if (route.provider !== undefined && !matchPattern(route.provider, provider)) return false
    if (route.model !== undefined && !matchPattern(route.model, model)) return false
    return true
  })
}

/**
 * Count the durable tool-change blocks a request would have sent.
 * They are legal only inside `developer` messages, so the count is exact.
 * @param messages - request history.
 * @returns additions and removals carried by the request.
 */
function toolChangeCounts(messages) {
  let additions = 0
  let removals = 0
  for (const message of messages) {
    if (message.role !== 'developer') continue
    for (const block of message.content) {
      if (block.type === 'tool-addition') additions += 1
      else if (block.type === 'tool-removal') removals += 1
    }
  }
  return { additions, removals }
}

/**
 * Project one request onto the harness's unsupported-route shape.
 * Delegates to the core projection so the result is byte-for-byte what the
 * harness already sends to a route that declares no tool updates.
 * @param options - the fully assembled request.
 * @returns whether the request changes, and the projected messages and tools.
 */
export function projectRequest(options) {
  const projected = projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)
  const changed = projected.messages !== options.messages || projected.tools !== options.tools
  if (!changed) return { changed: false, messages: options.messages, tools: options.tools, additions: 0, removals: 0, deferred: 0 }
  const counts = toolChangeCounts(options.messages)
  const deferred = projected.tools === options.tools
    ? 0
    : (options.tools ?? []).filter(tool => tool.deferLoading === true).length
  return { changed: true, messages: projected.messages, tools: projected.tools, ...counts, deferred }
}

/**
 * Build the replacement request envelope.
 * The adapter contract elsewhere in the harness observes a deep-frozen request,
 * so the envelope and its arrays are frozen here; the message objects are the
 * originals, which the loop already froze.
 * @param options - original request.
 * @param messages - projected history.
 * @param tools - projected declarations.
 * @returns a frozen request the runtime can dispatch as-is.
 */
function replacedRequest(options, messages, tools) {
  const copy = { ...options, messages: Object.isFrozen(messages) ? messages : Object.freeze([...messages]) }
  if (tools === undefined) delete copy.tools
  else copy.tools = Object.isFrozen(tools) ? tools : Object.freeze([...tools])
  Object.freeze(copy)
  if (isAgentLoopRequest(options)) markAgentLoopRequest(copy)
  return copy
}

/**
 * Normalize configured routes, dropping entries that constrain nothing.
 * A catch-all entry is spelled `{}` only if the operator means it; an entry
 * with neither field would silently deny every route, so it is rejected.
 * @param routes - configured value.
 * @returns normalized entries, or an empty list when the value is unusable.
 */
export function normalizeRoutes(routes) {
  if (!Array.isArray(routes)) return []
  return routes
    .filter(route => route !== null && typeof route === 'object')
    .map(route => ({
      ...typeof route.provider === 'string' && route.provider.length > 0 ? { provider: route.provider } : {},
      ...typeof route.model === 'string' && route.model.length > 0 ? { model: route.model } : {},
    }))
    .filter(route => route.provider !== undefined || route.model !== undefined)
}

/**
 * Create the guard used by one plugin instance.
 * @param config - plugin configuration.
 * @param logger - optional cordis logger; warnings are emitted once per route.
 * @returns the handler, plus the counters a test or an operator can read.
 */
export function createGuard(config, logger) {
  const routes = normalizeRoutes(config?.routes)
  const audit = config?.audit === true
  const dispatched = new WeakSet()
  const reported = new Set()
  const stats = { requests: 0, projected: 0, additions: 0, removals: 0, deferred: 0 }

  /**
   * Handle one `llm/stream` dispatch.
   * @param stream - the runtime's public stream entry point, used to redispatch.
   * @param options - request as assembled by the caller.
   * @param next - continuation bound to the original request; it cannot carry a
   *   replacement, which is why a projected request is redispatched instead.
   * @returns the chunk stream for the request that actually goes out.
   */
  function handle(stream, options, next) {
    if (dispatched.has(options)) return next()
    stats.requests += 1
    let projected
    try {
      if (!matchesRoute(routes, options.provider, options.model)) return next()
      projected = projectRequest(options)
      if (!projected.changed) return next()
      if (audit) {
        stats.projected += 1
        stats.additions += projected.additions
        stats.removals += projected.removals
        stats.deferred += projected.deferred
        warnOnce(options)
        return next()
      }
      const replacement = replacedRequest(options, projected.messages, projected.tools)
      dispatched.add(replacement)
      stats.projected += 1
      stats.additions += projected.additions
      stats.removals += projected.removals
      stats.deferred += projected.deferred
      warnOnce(options)
      return stream(replacement)
    } catch (_projectionFailed) {
      // The guard must never decide whether a request runs: any failure here
      // leaves the assembled request exactly as the caller built it.
      return next()
    }
  }

  function warnOnce(options) {
    if (typeof logger?.warn !== 'function') return
    const key = `${String(options.provider)}\u0000${String(options.model)}`
    if (reported.has(key)) return
    reported.add(key)
    logger.warn(
      `${name}: provider "${String(options.provider)}" model "${String(options.model)}" cannot carry mid-conversation tool updates; `
      + 'projected developer tool-change messages out of its requests. Durable history is unchanged.',
    )
  }

  return { handle, stats, routes, audit }
}

/**
 * Mount the guard on one context.
 * @param ctx - plugin context providing the `llm` service.
 * @param config - plugin configuration.
 */
export function apply(ctx, config) {
  const guard = createGuard(config, ctx.logger)
  // A mounted guard with no usable route is inert, which is indistinguishable
  // from a guard that is working and never matching. Say so once, because the
  // usual cause is a misspelt or empty `routes` entry.
  if (guard.routes.length === 0 && config?.routes !== undefined) {
    ctx.logger?.warn(
      `${name}: every configured route entry was rejected, so the guard changes nothing; `
      + 'each entry needs a non-empty "provider" or "model" pattern.',
    )
  }
  ctx.on('llm/stream', (options, next) => guard.handle(request => ctx.llm.stream(request), options, next), { prepend: true })
}

export default { name, inject, apply }
