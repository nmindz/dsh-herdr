import { Context } from "@deepseek-ai/cordis";
import { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import { SessionEvent } from "@deepseek-ai/dsh-session";
//#region src/state.d.ts
type HerdrAgentState = 'idle' | 'working' | 'blocked';
interface StateSnapshot {
  readonly state?: HerdrAgentState;
  readonly agentCount: number;
  readonly runningCount: number;
  readonly approvalCount: number;
  readonly message?: string;
  /** Root DSH session id — the key `DSH_TUI_RESUME_SESSION` accepts. */
  readonly sessionId?: string;
}
/** Fold both persisted seed events and live events into unresolved approval ids. */
declare function unresolvedApprovals(events: readonly SessionEvent[]): Set<string>;
/** Process-local rollup for every root and child agent hosted by one DSH TUI. */
declare class DshStateTracker {
  #private;
  setRootSession(sessionId: string | undefined): void;
  upsert(agentId: string, status: AgentStatus, approvals?: Iterable<string>): void;
  setStatus(agentId: string, status: AgentStatus): void;
  approvalAsked(agentId: string, approvalId: string): void;
  approvalDecided(agentId: string, approvalId: string): void;
  dispose(agentId: string): void;
  snapshot(): StateSnapshot;
}
//#endregion
//#region src/reporter.d.ts
declare const HERDR_SOURCE = "dsh:runtime";
declare const HERDR_AGENT = "dsh";
interface HerdrReporterConfig {
  readonly binary: string;
  readonly paneId: string;
  readonly socketPath?: string;
  readonly source?: string;
  readonly agent?: string;
  readonly timeoutMs?: number;
}
type RunHerdr = (binary: string, args: readonly string[], timeoutMs: number) => Promise<void>;
/** Display-only sidebar fields; Herdr keeps these out of state and waits. */
interface MetadataSnapshot {
  readonly displayAgent?: string;
  readonly tokens: Readonly<Record<string, string>>;
}
interface StateReporter {
  update(snapshot: StateSnapshot): void;
  release(): Promise<void>;
  metadata?(snapshot: MetadataSnapshot): void;
  close?(): Promise<void> | void;
}
type HerdrParams = Record<string, string | number | Readonly<Record<string, string>>>;
declare function reporterConfigFromEnv(env?: NodeJS.ProcessEnv): HerdrReporterConfig | undefined;
declare function runHerdr(binary: string, args: readonly string[], timeoutMs: number): Promise<void>;
/**
 * Newline-delimited JSON client for Unix sockets and Windows named pipes.
 *
 * Herdr serves one request per connection and hangs up after answering, so
 * every request dials its own socket. Holding one open and writing a second
 * request to it earns an EPIPE, which is silent here: the report is dropped
 * and the pane keeps whatever state it had.
 */
declare class HerdrSocketClient {
  #private;
  constructor(socketPath: string);
  request(method: string, params: HerdrParams, timeoutMs: number): Promise<void>;
  close(): void;
}
/** Socket-first reporting with CLI fallback and cross-process sequenced updates. */
declare class HerdrReporter implements StateReporter {
  #private;
  constructor(config: HerdrReporterConfig, run?: RunHerdr, onError?: (error: unknown) => void);
  update(snapshot: StateSnapshot): void;
  /**
   * Presentation rides a sibling source so it never competes with the
   * lifecycle authority reported above.
   */
  metadata(snapshot: MetadataSnapshot): void;
  release(): Promise<void>;
  close(): Promise<void>;
  whenIdle(): Promise<void>;
}
//#endregion
//#region src/bridge.d.ts
/** Sidebar fields DSH owns but the rollup cannot derive on its own. */
interface DshDisplay {
  readonly title?: string;
  readonly model?: string;
  readonly limit?: string;
  readonly context?: string;
}
declare class DshHerdrBridge {
  #private;
  constructor(reporter: StateReporter);
  /** Claim the pane as soon as the plugin loads, before any agent exists. */
  announce(): void;
  setRootSession(sessionId: string | undefined): void;
  setDisplay(display: DshDisplay): void;
  upsert(agent: Agent): void;
  setStatus(agentId: unknown, status: AgentStatus): void;
  sessionEvent(sessionId: unknown, event: SessionEvent): void;
  remove(agentId: unknown): void;
  dispose(): Promise<void>;
}
//#endregion
//#region src/display.d.ts
/**
 * Sidebar text for the usage tokens. Herdr sidebars render these beside the
 * equivalents other agents publish, so the shapes deliberately match: a `Σ`
 * cumulative total and a `⊙` context meter.
 */
/** Cumulative provider usage for a whole session log. */
interface TokenUsage {
  readonly uncachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}
/** Prompt-side occupancy of the model's context window. */
interface ContextPressure {
  readonly contextWindow?: number;
  readonly pressureTokens?: number;
  readonly projectedTokens?: number;
}
/** 999 · 575k · 128M — the magnitudes a sidebar row has room for. */
declare function humanizeTokens(total: number): string;
declare function formatTokenTotal(usage: TokenUsage | null | undefined): string | undefined;
/**
 * DSH stores no percentage, so derive it. Without a context window only the
 * raw token count is honest — a percentage of an unknown budget is not.
 */
declare function formatContextPressure(pressure: ContextPressure | null | undefined): string | undefined;
//#endregion
//#region src/index.d.ts
declare const name = "integration-herdr";
declare const inject: string[];
declare function apply(ctx: Context): void;
//#endregion
export { ContextPressure, DshDisplay, DshHerdrBridge, DshStateTracker, HERDR_AGENT, HERDR_SOURCE, HerdrAgentState, HerdrReporter, HerdrReporterConfig, HerdrSocketClient, MetadataSnapshot, RunHerdr, StateReporter, StateSnapshot, TokenUsage, apply, formatContextPressure, formatTokenTotal, humanizeTokens, inject, name, reporterConfigFromEnv, runHerdr, unresolvedApprovals };