import { basename } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { performance } from "node:perf_hooks";
//#region src/state.ts
function plural(count, singular, pluralForm = `${singular}s`) {
	return count === 1 ? singular : pluralForm;
}
/** Fold both persisted seed events and live events into unresolved approval ids. */
function unresolvedApprovals(events) {
	const pending = /* @__PURE__ */ new Set();
	for (const event of events) {
		const type = event.type;
		if (type === "approval/asked") {
			const asked = event;
			pending.add(String(asked.data.id));
		} else if (type === "approval/decided") {
			const decided = event;
			pending.delete(String(decided.data.id));
		}
	}
	return pending;
}
/** Process-local rollup for every root and child agent hosted by one DSH TUI. */
var DshStateTracker = class {
	#agents = /* @__PURE__ */ new Map();
	#rootSessionId;
	setRootSession(sessionId) {
		this.#rootSessionId = sessionId;
	}
	upsert(agentId, status, approvals = []) {
		const tracked = this.#agents.get(agentId);
		if (tracked !== void 0) {
			tracked.status = status;
			tracked.approvals.clear();
			for (const approval of approvals) tracked.approvals.add(approval);
			return;
		}
		this.#agents.set(agentId, {
			status,
			approvals: new Set(approvals)
		});
	}
	setStatus(agentId, status) {
		const tracked = this.#agents.get(agentId);
		if (tracked !== void 0) tracked.status = status;
	}
	approvalAsked(agentId, approvalId) {
		this.#agents.get(agentId)?.approvals.add(approvalId);
	}
	approvalDecided(agentId, approvalId) {
		this.#agents.get(agentId)?.approvals.delete(approvalId);
	}
	dispose(agentId) {
		this.#agents.delete(agentId);
	}
	snapshot() {
		const agents = [...this.#agents.values()];
		const agentCount = agents.length;
		const runningCount = agents.filter(({ status }) => status === "running").length;
		const approvalCount = agents.reduce((count, { approvals }) => count + approvals.size, 0);
		const session = this.#rootSessionId === void 0 ? {} : { sessionId: this.#rootSessionId };
		if (agentCount === 0) return {
			state: "idle",
			agentCount,
			runningCount,
			approvalCount,
			...session
		};
		if (approvalCount > 0) return {
			state: "blocked",
			agentCount,
			runningCount,
			approvalCount,
			message: `${approvalCount} ${plural(approvalCount, "approval")} waiting`,
			...session
		};
		if (runningCount > 0) return {
			state: "working",
			agentCount,
			runningCount,
			approvalCount,
			message: `${runningCount} ${plural(runningCount, "agent")} working`,
			...session
		};
		return {
			state: "idle",
			agentCount,
			runningCount,
			approvalCount,
			message: `${agentCount} ${plural(agentCount, "agent")} idle`,
			...session
		};
	}
};
//#endregion
//#region src/bridge.ts
var DshHerdrBridge = class {
	#reporter;
	#tracker = new DshStateTracker();
	#display = {};
	#scheduled = false;
	#disposed = false;
	constructor(reporter) {
		this.#reporter = reporter;
	}
	/** Claim the pane as soon as the plugin loads, before any agent exists. */
	announce() {
		this.#changed();
	}
	setRootSession(sessionId) {
		this.#tracker.setRootSession(sessionId);
		this.#changed();
	}
	setDisplay(display) {
		this.#display = {
			...this.#display,
			...display
		};
		this.#changed();
	}
	upsert(agent) {
		this.#tracker.upsert(String(agent.id), agent.status, unresolvedApprovals(agent.session.snapshotEvents()));
		this.#changed();
	}
	setStatus(agentId, status) {
		this.#tracker.setStatus(String(agentId), status);
		this.#changed();
	}
	sessionEvent(sessionId, event) {
		const type = event.type;
		if (type !== "approval/asked" && type !== "approval/decided") return;
		const approval = event;
		if (type === "approval/asked") this.#tracker.approvalAsked(String(sessionId), String(approval.data.id));
		else this.#tracker.approvalDecided(String(sessionId), String(approval.data.id));
		this.#changed();
	}
	remove(agentId) {
		this.#tracker.dispose(String(agentId));
		this.#changed();
	}
	async dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#reporter.close !== void 0) await this.#reporter.close();
		else await this.#reporter.release();
	}
	#changed() {
		if (this.#disposed || this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (this.#disposed) return;
			const snapshot = this.#tracker.snapshot();
			this.#reporter.update(snapshot);
			this.#reporter.metadata?.(this.#metadata(snapshot));
		});
	}
	/**
	* Mirrored onto the token names Herdr sidebars already compose with, so an
	* existing `ui.sidebar.agents` layout renders DSH without being rewritten.
	*/
	#metadata(snapshot) {
		const tokens = {};
		const rollup = snapshot.message ?? "idle";
		tokens.context = this.#display.context ?? rollup;
		tokens.dsh_context = tokens.context;
		tokens.dsh_rollup = rollup;
		if (this.#display.title !== void 0) {
			tokens.title = this.#display.title;
			tokens.dsh_title = this.#display.title;
		}
		if (this.#display.limit !== void 0) {
			tokens.limit = this.#display.limit;
			tokens.dsh_limit = this.#display.limit;
		}
		if (this.#display.model !== void 0) tokens.dsh_model = this.#display.model;
		return {
			displayAgent: "dsh",
			tokens
		};
	}
};
//#endregion
//#region src/display.ts
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : void 0;
}
/** 999 · 575k · 128M — the magnitudes a sidebar row has room for. */
function humanizeTokens(total) {
	if (total < 1e3) return String(Math.round(total));
	if (total < 1e6) return `${Math.round(total / 1e3)}k`;
	return `${Math.round(total / 1e6)}M`;
}
function formatTokenTotal(usage) {
	if (usage === null || usage === void 0) return void 0;
	const buckets = [
		finite(usage.uncachedInputTokens),
		finite(usage.outputTokens),
		finite(usage.cacheReadTokens),
		finite(usage.cacheWriteTokens)
	].filter((value) => value !== void 0);
	if (buckets.length === 0) return void 0;
	return `Σ ${humanizeTokens(buckets.reduce((sum, value) => sum + value, 0))}`;
}
/**
* DSH stores no percentage, so derive it. Without a context window only the
* raw token count is honest — a percentage of an unknown budget is not.
*/
function formatContextPressure(pressure) {
	if (pressure === null || pressure === void 0) return void 0;
	const used = finite(pressure.projectedTokens) ?? finite(pressure.pressureTokens);
	if (used === void 0) return void 0;
	const window = finite(pressure.contextWindow);
	if (window === void 0 || window === 0) return `⊙ ${humanizeTokens(used)}`;
	return `⊙ ${Math.round(used * 100 / window)}% (${humanizeTokens(used)})`;
}
//#endregion
//#region src/reporter.ts
const HERDR_SOURCE = "dsh:runtime";
const HERDR_AGENT = "dsh";
function errorText(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}
function reporterConfigFromEnv(env = process.env) {
	if (env.HERDR_ENV !== "1") return void 0;
	const paneId = env.HERDR_PANE_ID?.trim();
	if (paneId === void 0 || paneId === "") return void 0;
	const socketPath = env.HERDR_SOCKET_PATH?.trim();
	return {
		binary: env.HERDR_BIN_PATH?.trim() || "herdr",
		paneId,
		...socketPath === void 0 || socketPath === "" ? {} : { socketPath }
	};
}
function runHerdr(binary, args, timeoutMs) {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [...args], {
			env: process.env,
			stdio: "ignore",
			windowsHide: true
		});
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === void 0) resolve();
			else reject(error);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(/* @__PURE__ */ new Error(`Herdr command timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();
		child.once("error", finish);
		child.once("close", (code, signal) => {
			if (code === 0) finish();
			else finish(/* @__PURE__ */ new Error(`Herdr command exited with ${code ?? signal ?? "unknown status"}`));
		});
	});
}
/**
* Newline-delimited JSON client for Unix sockets and Windows named pipes.
*
* Herdr serves one request per connection and hangs up after answering, so
* every request dials its own socket. Holding one open and writing a second
* request to it earns an EPIPE, which is silent here: the report is dropped
* and the pane keeps whatever state it had.
*/
var HerdrSocketClient = class {
	#socketPath;
	#open = /* @__PURE__ */ new Set();
	#requestSequence = 0;
	#closed = false;
	constructor(socketPath) {
		this.#socketPath = socketPath;
	}
	request(method, params, timeoutMs) {
		if (this.#closed) return Promise.reject(/* @__PURE__ */ new Error("Herdr socket client is closed"));
		const id = `dsh-herdr-${process.pid}-${++this.#requestSequence}`;
		return new Promise((resolve, reject) => {
			const socket = createConnection({ path: this.#socketPath });
			this.#open.add(socket);
			let settled = false;
			let buffer = "";
			const finish = (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.#open.delete(socket);
				if (!socket.destroyed) socket.destroy();
				if (error === void 0) resolve();
				else reject(error);
			};
			const timer = setTimeout(() => finish(/* @__PURE__ */ new Error(`Herdr socket request timed out after ${timeoutMs}ms`)), timeoutMs);
			timer.unref();
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				const line = buffer.slice(0, newline).trim();
				if (line !== "") finish(this.#responseError(line, id));
			});
			socket.on("error", (error) => finish(error));
			socket.on("close", () => finish(/* @__PURE__ */ new Error("Herdr socket connection closed")));
			socket.once("connect", () => {
				socket.write(`${JSON.stringify({
					id,
					method,
					params
				})}\n`, "utf8", (error) => {
					if (error !== void 0 && error !== null) finish(error);
				});
			});
		});
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		for (const socket of [...this.#open]) socket.destroy();
		this.#open.clear();
	}
	/** The error a response line represents, or undefined when it succeeded. */
	#responseError(line, id) {
		let response;
		try {
			response = JSON.parse(line);
		} catch (error) {
			return /* @__PURE__ */ new Error(`Invalid Herdr socket response: ${errorText(error)}`);
		}
		const responseId = typeof response.id === "string" || typeof response.id === "number" ? String(response.id) : void 0;
		if (responseId !== void 0 && responseId !== id) return /* @__PURE__ */ new Error(`Herdr socket response id ${responseId} does not match ${id}`);
		if (response.error !== void 0 && response.error !== null) return /* @__PURE__ */ new Error(`Herdr socket error: ${errorText(response.error)}`);
		if (response.result === void 0) return /* @__PURE__ */ new Error("Herdr socket response has neither result nor error");
	}
};
/** Socket-first reporting with CLI fallback and cross-process sequenced updates. */
var HerdrReporter = class {
	#binary;
	#paneId;
	#source;
	#agent;
	#timeoutMs;
	#run;
	#onError;
	#socket;
	#sequence = 0;
	#lastDesired;
	#lastMetadata;
	#released = true;
	#queue = Promise.resolve();
	constructor(config, run = runHerdr, onError = () => void 0) {
		this.#binary = config.binary;
		this.#paneId = config.paneId;
		this.#source = config.source ?? "dsh:runtime";
		this.#agent = config.agent ?? "dsh";
		this.#timeoutMs = config.timeoutMs ?? 3e3;
		this.#run = run;
		this.#onError = onError;
		if (config.socketPath !== void 0) this.#socket = new HerdrSocketClient(config.socketPath);
	}
	update(snapshot) {
		if (snapshot.state === void 0) {
			this.release();
			return;
		}
		const desired = `${snapshot.state}\0${snapshot.message ?? ""}\0${snapshot.sessionId ?? ""}`;
		if (!this.#released && desired === this.#lastDesired) return;
		this.#released = false;
		this.#lastDesired = desired;
		const seq = this.#nextSequence();
		const params = {
			pane_id: this.#paneId,
			source: this.#source,
			agent: this.#agent,
			state: snapshot.state,
			seq
		};
		const args = [
			"pane",
			"report-agent",
			this.#paneId,
			"--source",
			this.#source,
			"--agent",
			this.#agent,
			"--state",
			snapshot.state,
			"--seq",
			String(seq)
		];
		if (snapshot.message !== void 0) {
			params.message = snapshot.message;
			args.push("--message", snapshot.message);
		}
		if (snapshot.sessionId !== void 0) {
			params.agent_session_id = snapshot.sessionId;
			args.push("--agent-session-id", snapshot.sessionId);
		}
		this.#enqueue("pane.report_agent", params, args);
	}
	/**
	* Presentation rides a sibling source so it never competes with the
	* lifecycle authority reported above.
	*/
	metadata(snapshot) {
		const desired = JSON.stringify([snapshot.displayAgent ?? "", snapshot.tokens]);
		if (desired === this.#lastMetadata) return;
		this.#lastMetadata = desired;
		const source = `${this.#source}-display`;
		const seq = this.#nextSequence();
		const params = {
			pane_id: this.#paneId,
			source,
			agent: this.#agent,
			seq,
			tokens: snapshot.tokens
		};
		const args = [
			"pane",
			"report-metadata",
			this.#paneId,
			"--source",
			source,
			"--agent",
			this.#agent,
			"--seq",
			String(seq)
		];
		for (const [name, value] of Object.entries(snapshot.tokens)) args.push("--token", `${name}=${value}`);
		if (snapshot.displayAgent !== void 0) {
			params.display_agent = snapshot.displayAgent;
			args.push("--display-agent", snapshot.displayAgent);
		}
		this.#enqueue("pane.report_metadata", params, args);
	}
	release() {
		if (this.#released) return this.#queue;
		this.#released = true;
		this.#lastDesired = void 0;
		const seq = this.#nextSequence();
		this.#enqueue("pane.release_agent", {
			pane_id: this.#paneId,
			source: this.#source,
			agent: this.#agent,
			seq
		}, [
			"pane",
			"release-agent",
			this.#paneId,
			"--source",
			this.#source,
			"--agent",
			this.#agent,
			"--seq",
			String(seq)
		]);
		return this.#queue;
	}
	async close() {
		await this.release();
		this.#socket?.close();
	}
	whenIdle() {
		return this.#queue;
	}
	#nextSequence() {
		const epochMicros = Math.floor((performance.timeOrigin + performance.now()) * 1e3);
		this.#sequence = Math.max(this.#sequence + 1, epochMicros);
		return this.#sequence;
	}
	#enqueue(method, params, args) {
		this.#queue = this.#queue.then(async () => {
			let socketError;
			if (this.#socket !== void 0) try {
				await this.#socket.request(method, params, this.#timeoutMs);
				return;
			} catch (error) {
				socketError = error;
			}
			try {
				await this.#run(this.#binary, args, this.#timeoutMs);
			} catch (cliError) {
				if (socketError === void 0) throw cliError;
				throw new AggregateError([socketError, cliError], `Herdr socket and CLI fallback failed: ${errorText(socketError)}; ${errorText(cliError)}`);
			}
		}).catch((error) => this.#onError(error));
	}
};
//#endregion
//#region src/index.ts
const name = "integration-herdr";
const inject = ["agents"];
const PROJECTION_KEYS = [
	"modelSelection",
	"title",
	"tokenUsage",
	"contextPressure"
];
function modelLabel(selection) {
	const model = selection?.model;
	if (model === void 0 || model === "") return void 0;
	const effort = selection?.reasoningEffort;
	return effort === void 0 || effort === "" ? model : `${model} · ${effort}`;
}
/**
* Title, usage and context live in session projections rather than on the
* agent, so they are readable before the first agent exists. The service is
* optional and read defensively: a profile that never loads it — or a DSH that
* renames a projection — must not take the whole rollup down with it.
*/
function syncSessionDisplay(ctx, session, bridge) {
	try {
		const projections = ctx.sessionProjections;
		if (projections === void 0) return;
		const values = projections.snapshot(session, PROJECTION_KEYS).values;
		if (values === void 0) return;
		const title = values.title;
		bridge.setDisplay({
			...modelLabel(values.modelSelection?.next) === void 0 ? {} : { model: modelLabel(values.modelSelection?.next) },
			...title === null || title === void 0 || title === "" ? {} : { title },
			...formatTokenTotal(values.tokenUsage) === void 0 ? {} : { limit: formatTokenTotal(values.tokenUsage) },
			...formatContextPressure(values.contextPressure) === void 0 ? {} : { context: formatContextPressure(values.contextPressure) }
		});
	} catch {}
}
function apply(ctx) {
	const config = reporterConfigFromEnv();
	if (config === void 0) return;
	const logger = ctx.logger("dsh-herdr");
	const bridge = new DshHerdrBridge(new HerdrReporter(config, void 0, (error) => {
		logger.warn("Herdr state report failed: %s", error instanceof Error ? error.message : String(error));
	}));
	ctx.effect(() => async () => bridge.dispose(), "dsh-herdr reporter");
	const syncRootSession = () => {
		const root = ctx.agents.roots()[0];
		bridge.setRootSession(root === void 0 ? void 0 : String(root.id));
	};
	for (const agent of ctx.agents.list()) bridge.upsert(agent);
	syncRootSession();
	bridge.setDisplay({ title: basename(process.cwd()) });
	bridge.announce();
	ctx.on("agent/created", ({ agent }) => {
		bridge.upsert(agent);
		syncRootSession();
	});
	ctx.on("agent/status", ({ agent, status }) => bridge.setStatus(agent.id, status));
	ctx.on("agent/disposed", ({ agent }) => {
		bridge.remove(agent.id);
		syncRootSession();
	});
	ctx.on("session/event", (session, event) => {
		bridge.sessionEvent(session.id, event);
		syncSessionDisplay(ctx, session, bridge);
	});
}
//#endregion
export { DshHerdrBridge, DshStateTracker, HERDR_AGENT, HERDR_SOURCE, HerdrReporter, HerdrSocketClient, apply, formatContextPressure, formatTokenTotal, humanizeTokens, inject, name, reporterConfigFromEnv, runHerdr, unresolvedApprovals };
