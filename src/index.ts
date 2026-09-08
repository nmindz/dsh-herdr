import { basename } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { DshHerdrBridge } from './bridge.ts'
import {
  type ContextPressure,
  formatContextPressure,
  formatTokenTotal,
  type TokenUsage,
} from './display.ts'
import { HerdrReporter, reporterConfigFromEnv } from './reporter.ts'

export * from './bridge.ts'
export * from './display.ts'
export * from './reporter.ts'
export * from './state.ts'

export const name = 'integration-herdr'
export const inject = ['agents']

interface ModelSelection {
  readonly model?: string
  readonly reasoningEffort?: string
}

const PROJECTION_KEYS = ['modelSelection', 'title', 'tokenUsage', 'contextPressure'] as const

/** Structural view of the session projections the sidebar draws from. */
interface SessionProjections {
  snapshot(session: unknown, keys: readonly string[]): {
    readonly values?: {
      readonly modelSelection?: { readonly next?: ModelSelection | null }
      readonly title?: string | null
      readonly tokenUsage?: TokenUsage | null
      readonly contextPressure?: ContextPressure | null
    }
  }
}

function modelLabel(selection: ModelSelection | null | undefined): string | undefined {
  const model = selection?.model
  if (model === undefined || model === '') return undefined
  const effort = selection?.reasoningEffort
  return effort === undefined || effort === '' ? model : `${model} · ${effort}`
}

/**
 * Title, usage and context live in session projections rather than on the
 * agent, so they are readable before the first agent exists. The service is
 * optional and read defensively: a profile that never loads it — or a DSH that
 * renames a projection — must not take the whole rollup down with it.
 */
function syncSessionDisplay(ctx: Context, session: unknown, bridge: DshHerdrBridge): void {
  try {
    const projections = (ctx as unknown as { sessionProjections?: SessionProjections }).sessionProjections
    if (projections === undefined) return
    const values = projections.snapshot(session, PROJECTION_KEYS).values
    if (values === undefined) return
    const title = values.title
    bridge.setDisplay({
      ...(modelLabel(values.modelSelection?.next) === undefined
        ? {}
        : { model: modelLabel(values.modelSelection?.next) }),
      ...(title === null || title === undefined || title === '' ? {} : { title }),
      ...(formatTokenTotal(values.tokenUsage) === undefined
        ? {}
        : { limit: formatTokenTotal(values.tokenUsage) }),
      ...(formatContextPressure(values.contextPressure) === undefined
        ? {}
        : { context: formatContextPressure(values.contextPressure) }),
    })
  } catch {
    // A projection shape change must not break state reporting.
  }
}

export function apply(ctx: Context): void {
  const config = reporterConfigFromEnv()
  if (config === undefined) return

  const logger = ctx.logger('dsh-herdr')
  const reporter = new HerdrReporter(config, undefined, error => {
    logger.warn('Herdr state report failed: %s', error instanceof Error ? error.message : String(error))
  })
  const bridge = new DshHerdrBridge(reporter)

  // Register cleanup first so event listeners unwind before the final release.
  ctx.effect(() => async () => bridge.dispose(), 'dsh-herdr reporter')

  // Registration order: the first top-level agent owns the resumable session.
  const syncRootSession = (): void => {
    const root = ctx.agents.roots()[0]
    bridge.setRootSession(root === undefined ? undefined : String(root.id))
  }

  for (const agent of ctx.agents.list()) bridge.upsert(agent)
  syncRootSession()
  bridge.setDisplay({ title: basename(process.cwd()) })
  bridge.announce()

  ctx.on('agent/created', ({ agent }) => {
    bridge.upsert(agent)
    syncRootSession()
  })
  ctx.on('agent/status', ({ agent, status }) => bridge.setStatus(agent.id, status))
  ctx.on('agent/disposed', ({ agent }) => {
    bridge.remove(agent.id)
    syncRootSession()
  })
  ctx.on('session/event', (session, event) => {
    bridge.sessionEvent(session.id, event as SessionEvent)
    syncSessionDisplay(ctx, session, bridge)
  })
}
