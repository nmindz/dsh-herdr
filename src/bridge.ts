import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { MetadataSnapshot, StateReporter } from './reporter.ts'
import { DshStateTracker, unresolvedApprovals, type StateSnapshot } from './state.ts'

/** Sidebar fields DSH owns but the rollup cannot derive on its own. */
export interface DshDisplay {
  readonly title?: string
  readonly model?: string
}

interface ApprovalEvent {
  readonly type: 'approval/asked' | 'approval/decided'
  readonly data: { readonly id: unknown }
}

export class DshHerdrBridge {
  readonly #reporter: StateReporter
  readonly #tracker = new DshStateTracker()
  #display: DshDisplay = {}
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

  setDisplay(display: DshDisplay): void {
    this.#display = { ...this.#display, ...display }
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
      if (this.#disposed) return
      const snapshot = this.#tracker.snapshot()
      this.#reporter.update(snapshot)
      this.#reporter.metadata?.(this.#metadata(snapshot))
    })
  }

  /**
   * Mirrored onto the token names Herdr sidebars already compose with, so an
   * existing `ui.sidebar.agents` layout renders DSH without being rewritten.
   */
  #metadata(snapshot: StateSnapshot): MetadataSnapshot {
    const tokens: Record<string, string> = {}
    const context = snapshot.message ?? 'idle'
    tokens.context = context
    tokens.dsh_context = context
    if (this.#display.title !== undefined) {
      tokens.title = this.#display.title
      tokens.dsh_title = this.#display.title
    }
    if (this.#display.model !== undefined) {
      tokens.provider = this.#display.model
      tokens.dsh_model = this.#display.model
    }
    return { displayAgent: 'dsh', tokens }
  }
}
