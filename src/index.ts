import { basename } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { DshHerdrBridge } from './bridge.ts'
import { HerdrReporter, reporterConfigFromEnv } from './reporter.ts'


export * from './bridge.ts'
export * from './reporter.ts'
export * from './state.ts'

export const name = 'integration-herdr'
export const inject = ['agents']

interface ModelSelection {
  readonly model?: string
  readonly reasoningEffort?: string
}

/** Structural view of the `modelSelection` session projection. */
interface SessionProjections {
  snapshot(session: unknown, keys: readonly string[]): {
    readonly values?: { readonly modelSelection?: { readonly next?: ModelSelection | null } }
  }
}

/**
 * Model and effort live in a session projection, not the agent registry. The
 * service is optional: reading it defensively keeps a profile that never loads
 * it — or a DSH that renames it — from taking the whole rollup down with it.
 */
function syncModelSelection(ctx: Context, session: unknown, bridge: DshHerdrBridge): void {
  try {
    const projections = (ctx as unknown as { sessionProjections?: SessionProjections }).sessionProjections
    if (projections === undefined) return
    const selection = projections.snapshot(session, ['modelSelection']).values?.modelSelection?.next
    const model = selection?.model
    if (model === undefined || model === '') return
    const effort = selection?.reasoningEffort
    bridge.setDisplay({ model: effort === undefined || effort === '' ? model : `${model} · ${effort}` })
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
    syncModelSelection(ctx, session, bridge)
  })
}
