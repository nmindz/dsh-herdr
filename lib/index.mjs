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
			if (!this.#disposed) this.#reporter.update(this.#tracker.snapshot());
		});
	}
};
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
/** Persistent newline-delimited JSON client for Unix sockets and Windows named pipes. */
var HerdrSocketClient = class {
	#socketPath;
	#pending = /* @__PURE__ */ new Map();
	#socket;
	#connecting;
	#requestSequence = 0;
	#closed = false;
	constructor(socketPath) {
		this.#socketPath = socketPath;
	}
	async request(method, params, timeoutMs) {
		if (this.#closed) throw new Error("Herdr socket client is closed");
		const socket = await this.#connect(timeoutMs);
		const id = `dsh-herdr-${process.pid}-${++this.#requestSequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(/* @__PURE__ */ new Error(`Herdr socket request timed out after ${timeoutMs}ms`));
				this.#disconnect(socket, /* @__PURE__ */ new Error("Herdr socket response timed out"));
			}, timeoutMs);
			timer.unref();
			this.#pending.set(id, {
				socket,
				timer,
				resolve,
				reject
			});
			socket.write(`${JSON.stringify({
				id,
				method,
				params
			})}\n`, "utf8", (error) => {
				if (error === void 0 || error === null) return;
				this.#takePending(id)?.reject(error);
				this.#disconnect(socket, error);
			});
		});
	}
	close() {
		if (this.#closed) return;
		this.#closed = true;
		const error = /* @__PURE__ */ new Error("Herdr socket client closed");
		for (const id of [...this.#pending.keys()]) this.#takePending(id)?.reject(error);
		const socket = this.#socket;
		this.#socket = void 0;
		socket?.end();
		socket?.destroy();
	}
	#connect(timeoutMs) {
		if (this.#closed) return Promise.reject(/* @__PURE__ */ new Error("Herdr socket client is closed"));
		if (this.#socket !== void 0 && !this.#socket.destroyed) return Promise.resolve(this.#socket);
		if (this.#connecting !== void 0) return this.#connecting;
		const connecting = new Promise((resolve, reject) => {
			const socket = createConnection({ path: this.#socketPath });
			let connected = false;
			let buffer = "";
			const connectionTimer = setTimeout(() => {
				const error = /* @__PURE__ */ new Error(`Herdr socket connection timed out after ${timeoutMs}ms`);
				reject(error);
				this.#disconnect(socket, error);
			}, timeoutMs);
			connectionTimer.unref();
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				buffer += chunk;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (line !== "") this.#handleLine(socket, line);
				}
			});
			socket.on("error", (error) => {
				clearTimeout(connectionTimer);
				if (!connected) reject(error);
				this.#disconnect(socket, error);
			});
			socket.on("close", () => {
				clearTimeout(connectionTimer);
				const error = /* @__PURE__ */ new Error("Herdr socket connection closed");
				if (!connected) reject(error);
				this.#disconnect(socket, error);
			});
			socket.once("connect", () => {
				clearTimeout(connectionTimer);
				connected = true;
				if (this.#closed) {
					socket.destroy();
					reject(/* @__PURE__ */ new Error("Herdr socket client closed while connecting"));
					return;
				}
				this.#socket = socket;
				resolve(socket);
			});
		});
		this.#connecting = connecting;
		connecting.finally(() => {
			if (this.#connecting === connecting) this.#connecting = void 0;
		}).catch(() => void 0);
		return connecting;
	}
	#handleLine(socket, line) {
		let response;
		try {
			response = JSON.parse(line);
		} catch (error) {
			this.#disconnect(socket, /* @__PURE__ */ new Error(`Invalid Herdr socket response: ${errorText(error)}`));
			return;
		}
		const id = typeof response.id === "string" || typeof response.id === "number" ? String(response.id) : void 0;
		if (id === void 0) return;
		const pending = this.#pending.get(id);
		if (pending === void 0 || pending.socket !== socket) return;
		this.#takePending(id);
		if (response.error !== void 0 && response.error !== null) pending.reject(/* @__PURE__ */ new Error(`Herdr socket error: ${errorText(response.error)}`));
		else if (response.result !== void 0) pending.resolve();
		else pending.reject(/* @__PURE__ */ new Error("Herdr socket response has neither result nor error"));
	}
	#takePending(id) {
		const pending = this.#pending.get(id);
		if (pending === void 0) return void 0;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		return pending;
	}
	#disconnect(socket, error) {
		if (this.#socket === socket) this.#socket = void 0;
		for (const [id, pending] of this.#pending) {
			if (pending.socket !== socket) continue;
			this.#takePending(id)?.reject(error);
		}
		if (!socket.destroyed) socket.destroy();
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
	});
}
//#endregion
export { DshHerdrBridge, DshStateTracker, HERDR_AGENT, HERDR_SOURCE, HerdrReporter, HerdrSocketClient, apply, inject, name, reporterConfigFromEnv, runHerdr, unresolvedApprovals };
