import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { DshHerdrBridge } from './bridge.ts'
import { HerdrReporter, reporterConfigFromEnv } from './reporter.ts'

export * from './bridge.ts'
export * from './reporter.ts'
export * from './state.ts'

export const name = 'integration-herdr'
export const inject = ['agents']

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

  for (const agent of ctx.agents.list()) bridge.upsert(agent)

  ctx.on('agent/created', ({ agent }) => bridge.upsert(agent))
  ctx.on('agent/status', ({ agent, status }) => bridge.setStatus(agent.id, status))
  ctx.on('agent/disposed', ({ agent }) => bridge.remove(agent.id))
  ctx.on('session/event', (session, event) => {
    bridge.sessionEvent(session.id, event as SessionEvent)
  })
}
