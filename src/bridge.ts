import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { StateReporter } from './reporter.ts'
import { DshStateTracker, unresolvedApprovals } from './state.ts'

interface ApprovalEvent {
  readonly type: 'approval/asked' | 'approval/decided'
  readonly data: { readonly id: unknown }
}

export class DshHerdrBridge {
  readonly #reporter: StateReporter
  readonly #tracker = new DshStateTracker()
  #scheduled = false
  #disposed = false

  constructor(reporter: StateReporter) {
    this.#reporter = reporter
  }

  /** Claim the pane as soon as the plugin loads, before any agent exists. */
  announce(): void {
    this.#changed()
  }

  setRootSession(sessionId: string | undefined): void {
    this.#tracker.setRootSession(sessionId)
    this.#changed()
  }

  upsert(agent: Agent): void {
    this.#tracker.upsert(String(agent.id), agent.status, unresolvedApprovals(agent.session.snapshotEvents()))
    this.#changed()
  }

  setStatus(agentId: unknown, status: AgentStatus): void {
    this.#tracker.setStatus(String(agentId), status)
    this.#changed()
  }

  sessionEvent(sessionId: unknown, event: SessionEvent): void {
    const type = event.type as string
    if (type !== 'approval/asked' && type !== 'approval/decided') return
    const approval = event as unknown as ApprovalEvent
    if (type === 'approval/asked') {
      this.#tracker.approvalAsked(String(sessionId), String(approval.data.id))
    } else {
      this.#tracker.approvalDecided(String(sessionId), String(approval.data.id))
    }
    this.#changed()
  }

  remove(agentId: unknown): void {
    this.#tracker.dispose(String(agentId))
    this.#changed()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#reporter.close !== undefined) await this.#reporter.close()
    else await this.#reporter.release()
  }

  #changed(): void {
    if (this.#disposed || this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      if (!this.#disposed) this.#reporter.update(this.#tracker.snapshot())
    })
  }
}
