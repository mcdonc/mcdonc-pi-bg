/**
 * Background Jobs - "background the last task"
 *
 * Tracks the last user prompt. Provides:
 *   /bg [extra instructions]    Abort current turn, respawn it as a detached
 *                               `pi` subprocess with its own session file.
 *   /jobs                       List active/finished background jobs.
 *   /jobs:attach <id>           Switch the current TUI session to the job's
 *                               session file (you "become" that pi instance).
 *   /jobs:tail <id>             Show the tail of the job's log without switching.
 *   /jobs:kill <id>             SIGTERM the job's process.
 *   /jobs:clear                 Forget all finished jobs.
 *
 * Jobs are persisted as custom session entries (customType: "bg-job") so
 * they survive /reload. Process liveness is rechecked on session_start.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";

interface BgJobRecord {
	id: string;
	prompt: string;
	extra?: string;
	sessionFile: string;
	logFile: string;
	outputFile: string;
	pid: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	status: "running" | "exited" | "killed" | "unknown";
}

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "state", "background");
const CUSTOM_TYPE = "bg-job";
const LAST_PROMPT_TYPE = "bg-last-prompt";

/** How many finished jobs to keep before opportunistic auto-trim kicks in. */
const AUTO_TRIM_KEEP = 5;

interface LastPromptRecord {
	prompt: string;
	timestamp: number;
}

function ensureDir(p: string): void {
	fs.mkdirSync(p, { recursive: true });
}

function shortId(): string {
	return Math.random().toString(36).slice(2, 8);
}

function fmtAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m`;
	return `${Math.floor(h / 24)}d${h % 24}h`;
}

function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM"; // exists but not ours
	}
}

/**
 * Locate the pi entrypoint to spawn. Mirrors subagent example.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export default function (pi: ExtensionAPI) {
	ensureDir(STATE_DIR);

	// In-memory mirror of persisted jobs. Keyed by id.
	const jobs = new Map<string, BgJobRecord>();

	// The most recent user prompt for the current session. Captured at
	// before_agent_start so we have the text the agent is actually working on.
	let lastPrompt: string | null = null;
	let lastPromptAt = 0;

	// The most recent bash command executed by the assistant. Tracked via
	// tool_execution_start so /bg re-runs the actual bash command rather
	// than the user's conversational prompt.
	let lastBashCommand: string | null = null;

	const persist = (job: BgJobRecord) => {
		jobs.set(job.id, job);
		pi.appendEntry(CUSTOM_TYPE, job);
	};

	const refreshLiveness = () => {
		for (const job of jobs.values()) {
			if (job.status === "running" && !isPidAlive(job.pid)) {
				job.status = "unknown";
				job.endedAt = job.endedAt ?? Date.now();
			}
		}
	};

	const updateStatusWidget = (ctx: ExtensionContext) => {
		refreshLiveness();
		const running = [...jobs.values()].filter((j) => j.status === "running").length;
		if (running > 0) {
			ctx.ui.setStatus("bg", `bg:${running}`);
		} else {
			ctx.ui.setStatus("bg", "");
		}
	};

	// --- Lifecycle ---------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		jobs.clear();
		lastPrompt = null;
		lastPromptAt = 0;
		// Rebuild from persisted custom entries.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === CUSTOM_TYPE) {
				const data = entry.data as BgJobRecord | undefined;
				if (data?.id) {
					// Each append overwrites the prior record for the same id.
					jobs.set(data.id, { ...data });
				}
			} else if (entry.customType === LAST_PROMPT_TYPE) {
				const data = entry.data as LastPromptRecord | undefined;
				if (data?.prompt) {
					lastPrompt = data.prompt;
					lastPromptAt = data.timestamp ?? 0;
				}
			}
		}
		refreshLiveness();
		updateStatusWidget(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.prompt && event.prompt.trim()) {
			lastPrompt = event.prompt;
			lastPromptAt = Date.now();
			pi.appendEntry(LAST_PROMPT_TYPE, {
				prompt: lastPrompt,
				timestamp: lastPromptAt,
			} satisfies LastPromptRecord);
		}
		updateStatusWidget(ctx);
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		if (typeof event.args?.command === "string") {
			lastBashCommand = event.args.command;
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateStatusWidget(ctx);
	});

	// --- /bg ---------------------------------------------------------------

	const runBg = async (extra: string, ctx: ExtensionContext) => {
		if (!lastPrompt) {
			ctx.ui.notify(
				"No prompt to background yet. Send a prompt first, then /bg.",
				"warning",
			);
			return;
		}

		// If the agent is mid-turn, abort it. Then queue the work as a child.
		const wasBusy = !ctx.isIdle();
		if (wasBusy) {
			ctx.abort();
			// give the abort a moment to land
			await new Promise((r) => setTimeout(r, 150));
		}

			const id = shortId();
			const sessionFile = path.join(STATE_DIR, `bg-${id}.jsonl`);
			const logFile = path.join(STATE_DIR, `bg-${id}.log`);
			const outputFile = path.join(STATE_DIR, `bg-${id}.out`);

			// Start fresh — no parent session fork. The parent conversation is full
			// of meta-chat about this extension which confuses the model into being
			// conversational instead of just executing the command.
			//
			// Tell the model to redirect long-running bash output to outputFile.
			const noteSuffix = extra ? `\n\nAdditional instruction from user: ${extra}` : "";
			const childPrompt =
				`## SYSTEM INSTRUCTION - BACKGROUND TASK\n\n` +
				`You are a background agent. Do NOT respond to this message conversationally. ` +
				`Do NOT explain anything. Do NOT ask questions. ` +
				`Immediately execute the following user request:\n\n` +
				`${lastBashCommand ?? lastPrompt ?? "(no task)"}${noteSuffix}\n\n` +
				`### Output capture rule\n` +
				`For any command that may run for a long time (sleep >5s, loops, servers, ` +
				`streaming output), background it within bash with \`&\` and redirect its ` +
				`stdout and stderr to ${outputFile} so the user can monitor progress. ` +
				`For quick commands that finish immediately, run them normally.`;

			const effectivePrompt = childPrompt;
			const piArgs = ["--session", sessionFile, "-p", childPrompt];
			const currentModel = ctx.model;
			if (currentModel?.provider && currentModel?.id) {
				piArgs.push("--model", `${currentModel.provider}/${currentModel.id}`);
			}
			const invocation = getPiInvocation(piArgs);

			const out = fs.openSync(logFile, "a");
			const err = fs.openSync(logFile, "a");
			fs.writeSync(
				out,
				`\n=== bg job ${id} started at ${new Date().toISOString()} ===\n` +
					`cwd: ${ctx.cwd}\nprompt:\n${effectivePrompt}\n=== output ===\n`,
			);

			let child;
			try {
				child = spawn(invocation.command, invocation.args, {
					cwd: ctx.cwd,
					detached: true,
					stdio: ["ignore", out, err],
					env: { ...process.env, PI_BG_JOB: id },
				});
			} catch (e: any) {
				try { fs.closeSync(out); } catch { /* ignore */ }
				try { fs.closeSync(err); } catch { /* ignore */ }
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
				try { fs.unlinkSync(logFile); } catch { /* ignore */ }
				ctx.ui.notify(`Failed to spawn bg job: ${e?.message ?? e}`, "error");
				return;
			}
			child.unref();

			// If the child died immediately (no pid), clean up.
			if (!child.pid) {
				try { fs.closeSync(out); } catch { /* ignore */ }
				try { fs.closeSync(err); } catch { /* ignore */ }
				try { fs.unlinkSync(sessionFile); } catch { /* ignore */ }
				try { fs.unlinkSync(logFile); } catch { /* ignore */ }
				ctx.ui.notify("Failed to spawn bg job: no pid", "error");
				return;
			}

			const job: BgJobRecord = {
				id,
				prompt: lastPrompt,
				extra: extra || undefined,
				sessionFile,
				logFile,
				outputFile,
				pid: child.pid ?? -1,
				startedAt: Date.now(),
				status: child.pid ? "running" : "unknown",
			};
			persist(job);

			child.on("exit", (code, signal) => {
				const killed = signal === "SIGTERM" || signal === "SIGKILL";
				const updated: BgJobRecord = {
					...job,
					endedAt: Date.now(),
					exitCode: code ?? undefined,
					status: killed ? "killed" : "exited",
				};
				try {
					fs.writeSync(
						out,
						`\n=== bg job ${id} ended ${new Date().toISOString()} ` +
							`code=${code} signal=${signal ?? ""} ===\n`,
					);
				} catch {
					/* ignore */
				}
				try {
					fs.closeSync(out);
				} catch {
					/* ignore */
				}
				try {
					fs.closeSync(err);
				} catch {
					/* ignore */
				}
				persist(updated);
				updateStatusWidget(ctx);
				const level: "info" | "warning" | "error" = killed
					? "warning"
					: (code ?? 0) === 0
						? "info"
						: "error";
				const suffix = killed
					? "killed"
					: `exited code=${code ?? "?"}`;
				ctx.ui.notify(`bg job ${id} ${suffix}`, level);
			});

		ctx.ui.notify(
			`Backgrounded as ${id}${wasBusy ? " (aborted current turn)" : ""}`,
			"info",
		);
		trimFinished(AUTO_TRIM_KEEP);
		updateStatusWidget(ctx);
		showJobsList(ctx);
	};

	pi.registerCommand("bg", {
		description:
			"Abort current turn and respawn the last user prompt as a background pi job",
		handler: async (args, ctx) => {
			await runBg((args ?? "").trim(), ctx);
		},
	});

	pi.registerShortcut("ctrl+b", {
		description: "Background the last user prompt as a detached pi job",
		handler: async (ctx) => {
			await runBg("", ctx);
		},
	});

	pi.registerShortcut("ctrl+`", {
		description: "Tail the most recent background job",
		handler: async (ctx) => {
			refreshLiveness();
			const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
			jobIndex = list.map((j) => j.id);
			if (list.length === 0) {
				ctx.ui.notify("No background jobs.", "info");
				return;
			}
			jobTail("1", ctx);
		},
	});

	// --- /jobs and friends -------------------------------------------------

	// Numeric index -> short id, refreshed on each /jobs listing so that
	// numbers match what the user just saw.
	let jobIndex: string[] = [];

	const resolveJobRef = (raw: string): BgJobRecord | undefined => {
		const arg = raw.trim();
		if (!arg) return undefined;
		if (/^\d+$/.test(arg)) {
			const id = jobIndex[Number(arg) - 1];
			return id ? jobs.get(id) : undefined;
		}
		return jobs.get(arg);
	};

	const trimFinished = (keep: number) => {
		const finished = [...jobs.values()]
			.filter((j) => j.status !== "running")
			.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
		const toRemove = finished.slice(Math.max(0, keep));
		for (const job of toRemove) {
			removeJobFiles(job);
			jobs.delete(job.id);
			pi.appendEntry(CUSTOM_TYPE, { ...job, status: "exited", endedAt: job.endedAt ?? Date.now() });
		}
		return toRemove.length;
	};

	const showJobsList = (ctx: ExtensionContext) => {
		refreshLiveness();
		trimFinished(AUTO_TRIM_KEEP);
		const list = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
		jobIndex = list.map((j) => j.id);
		if (list.length === 0) {
			ctx.ui.notify("No background jobs.", "info");
			return;
		}

		const now = Date.now();
		// Pre-format text fallback (for non-TUI / log / export) plus structured
		// rows for the custom renderer.
		const rows = list.map((j, i) => ({
			index: i + 1,
			id: j.id,
			age: fmtAge(now - j.startedAt),
			status: j.status,
			pid: j.pid,
			exitCode: j.exitCode,
			prompt: j.prompt,
		}));
		const lines = rows.map((r) => {
			const tail =
				r.status === "running"
					? `running pid=${r.pid}`
					: r.status === "exited"
						? `exited code=${r.exitCode ?? "?"}`
						: r.status;
			const promptPreview =
				r.prompt.length > 60 ? `${r.prompt.slice(0, 60)}…` : r.prompt;
			const num = String(r.index).padStart(2);
			return `${num}. ${r.id}  ${r.age.padStart(5)}  ${tail.padEnd(20)}  ${promptPreview}`;
		});

		pi.sendMessage({
			customType: "bg-jobs-list",
			content: ["Background jobs:", ...lines].join("\n"),
			display: true,
			details: { rows },
		});
	};

	type JobRow = {
		index: number;
		id: string;
		age: string;
		status: BgJobRecord["status"];
		pid: number;
		exitCode?: number;
		prompt: string;
	};

	pi.registerMessageRenderer<{ rows: JobRow[] }>(
		"bg-jobs-list",
		(message, _opts, theme) => {
			const rows = message.details?.rows ?? [];
			const container = new Container();
			container.addChild(new Text(theme.fg("toolTitle", theme.bold("Background jobs")), 0, 0));
			for (const r of rows) {
				const statusColor =
					r.status === "running"
						? "warning"
						: r.status === "exited" && (r.exitCode ?? 0) === 0
							? "success"
							: r.status === "killed"
								? "error"
								: "muted";
				const rowColor = r.status === "running" ? "toolOutput" : "dim";
				const tail =
					r.status === "running"
						? `running pid=${r.pid}`
						: r.status === "exited"
							? `exited code=${r.exitCode ?? "?"}`
							: r.status;
				const promptPreview =
					r.prompt.length > 60 ? `${r.prompt.slice(0, 60)}…` : r.prompt;
				const num = String(r.index).padStart(2);
				const text =
					theme.fg("muted", `${num}. `) +
					theme.fg("accent", r.id) +
					theme.fg("dim", `  ${r.age.padStart(5)}  `) +
					theme.fg(statusColor, tail.padEnd(20)) +
					theme.fg(rowColor, `  ${promptPreview}`);
				container.addChild(new Text(text, 0, 0));
			}
			return container;
		},
	);

	const completeJobId = (prefix: string) => {
		const items: { value: string; label: string }[] = [];
		for (const [i, id] of jobIndex.entries()) {
			const num = String(i + 1);
			if (num.startsWith(prefix)) items.push({ value: num, label: `${num} (${id})` });
		}
		for (const id of jobs.keys()) {
			if (id.startsWith(prefix)) items.push({ value: id, label: id });
		}
		return items.length > 0 ? items : null;
	};

	function removeJobFiles(job: BgJobRecord) {
		try { fs.unlinkSync(job.sessionFile); } catch { /* ignore */ }
		try { fs.unlinkSync(job.logFile); } catch { /* ignore */ }
		try { fs.unlinkSync(job.outputFile); } catch { /* ignore */ }
	}

	const jobAttach = async (rest: string, ctx: ExtensionCommandContext) => {
		const job = resolveJobRef(rest);
		if (!job) {
			ctx.ui.notify(`No such job: ${rest || "(empty)"}`, "warning");
			return;
		}
		if (!fs.existsSync(job.sessionFile)) {
			ctx.ui.notify(
				`Session file missing: ${job.sessionFile}. Job may not have written yet.`,
				"warning",
			);
			return;
		}
		await ctx.switchSession(job.sessionFile, {
			withSession: async (newCtx) => {
				newCtx.ui.notify(`Attached to bg job ${job.id}`, "info");
			},
		});
	};

	const jobTail = (rest: string, ctx: ExtensionContext) => {
		const job = resolveJobRef(rest);
		if (!job) {
			ctx.ui.notify(`No such job: ${rest || "(empty)"}`, "warning");
			return;
		}

		// Read the output file (direct bash stdout/stderr from the child).
		let content = "(no output yet)";
		try {
			const stat = fs.statSync(job.outputFile);
			const size = stat.size;
			const start = Math.max(0, size - 40 * 1024); // show last 40KB
			if (size === 0) {
				content = "(output file empty, still starting up?)";
			} else {
				const fd = fs.openSync(job.outputFile, "r");
				const buf = Buffer.alloc(size - start);
				fs.readSync(fd, buf, 0, buf.length, start);
				fs.closeSync(fd);
				content = buf.toString("utf8");
			}
		} catch (e: any) {
			if (e?.code === "ENOENT") {
				content = "(output file does not exist — job may not have started yet)";
			} else {
				content = `(unable to read output: ${e?.message ?? e})`;
			}
		}

		pi.sendMessage({
			customType: "bg-job-tail",
			content: `Output of bg job ${job.id} (${job.status}):\n\n${content}`,
			display: true,
		});
	};

	const jobKill = (rest: string, ctx: ExtensionContext) => {
		const job = resolveJobRef(rest);
		if (!job) {
			ctx.ui.notify(`No such job: ${rest || "(empty)"}`, "warning");
			return;
		}
		if (job.status !== "running") {
			ctx.ui.notify(`Job ${job.id} is not running (${job.status})`, "warning");
			return;
		}
		try {
			process.kill(job.pid, "SIGTERM");
			ctx.ui.notify(`Sent SIGTERM to ${job.id} (pid ${job.pid})`, "info");
		} catch (e: any) {
			ctx.ui.notify(`Failed to kill ${job.id}: ${e?.message ?? e}`, "error");
		}
		setTimeout(() => {
			if (!isPidAlive(job.pid)) {
				persist({ ...job, status: "killed", endedAt: Date.now() });
				updateStatusWidget(ctx);
			}
		}, 500);
	};

	const jobTrim = (rest: string, ctx: ExtensionContext) => {
		const n = Number.parseInt(rest, 10);
		if (!Number.isFinite(n) || n < 0) {
			ctx.ui.notify("Usage: /job trim <N>  (keep most recent N exited jobs)", "warning");
			return;
		}
		refreshLiveness();
		const removed = trimFinished(n);
		ctx.ui.notify(`Trimmed ${removed} job(s); keeping at most ${n}.`, "info");
		updateStatusWidget(ctx);
	};

	const jobGc = (ctx: ExtensionContext) => {
		let removed = 0;
		const tracked = new Set<string>();
		for (const job of jobs.values()) {
			tracked.add(path.basename(job.sessionFile));
			tracked.add(path.basename(job.logFile));
			tracked.add(path.basename(job.outputFile));
		}
		try {
			for (const name of fs.readdirSync(STATE_DIR)) {
				if (!name.startsWith("bg-")) continue;
				if (tracked.has(name)) continue;
				try {
					fs.unlinkSync(path.join(STATE_DIR, name));
					removed++;
				} catch { /* ignore */ }
			}
		} catch (e: any) {
			ctx.ui.notify(`gc failed: ${e?.message ?? e}`, "error");
			return;
		}
		ctx.ui.notify(`Removed ${removed} orphaned file(s) from ${STATE_DIR}.`, "info");
	};

	const SUBCOMMANDS = ["ls", "attach", "tail", "kill", "trim", "follow", "gc", "help"] as const;

	pi.registerCommand("job", {
		description:
			`Manage background pi jobs. Subcommands: ls (default), attach <id|#>, tail <id|#>, kill <id|#>, trim <N>, follow <id|#>, gc. Auto-trims to ${AUTO_TRIM_KEEP} finished jobs.`,
		getArgumentCompletions: (prefix) => {
			const trimmed = prefix.trimStart();
			const firstSpace = trimmed.indexOf(" ");
			if (firstSpace === -1) {
				const items = SUBCOMMANDS.filter((s) => s.startsWith(trimmed)).map((s) => ({
					value: s,
					label: s,
				}));
				return items.length > 0 ? items : null;
			}
			const sub = trimmed.slice(0, firstSpace);
			const rest = trimmed.slice(firstSpace + 1);
			if (sub === "attach" || sub === "tail" || sub === "kill") {
				const ids = completeJobId(rest);
				return ids
					? ids.map((i) => ({ value: `${sub} ${i.value}`, label: `${sub} ${i.label}` }))
					: null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				// Interactive: show a selectable list. Selecting a job follows it.
				refreshLiveness();
				const sorted = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
				jobIndex = sorted.map((j) => j.id);
				if (sorted.length === 0) {
					ctx.ui.notify("No background jobs.", "info");
					return;
				}
				const now = Date.now();
				const items = sorted.map((j) => {
					const tail =
						j.status === "running"
							? `running pid=${j.pid}`
							: j.status === "exited"
								? `exited code=${j.exitCode ?? "?"}`
								: j.status;
					const age = fmtAge(now - j.startedAt);
					const promptPreview =
						j.prompt.length > 50 ? `${j.prompt.slice(0, 50)}…` : j.prompt;
					return `${j.id}  ${age.padStart(5)}  ${tail.padEnd(16)}  ${promptPreview}`;
				});
				const chosen = await ctx.ui.select("Select job to follow:", items);
				if (chosen) {
					followJob(chosen.split(" ")[0], ctx);
				}
				return;
			}
			const space = trimmed.indexOf(" ");
			const sub = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
			const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
			switch (sub) {
				case "":
				case "ls":
				case "list":
					showJobsList(ctx);
					return;
				case "attach":
				case "a":
					await jobAttach(rest, ctx as ExtensionCommandContext);
					return;
				case "tail":
				case "t":
					jobTail(rest, ctx);
					return;
				case "kill":
				case "k":
					jobKill(rest, ctx);
					return;
				case "follow":
				case "f":
					if (!rest) {
						refreshLiveness();
						const sorted = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
						jobIndex = sorted.map((j) => j.id);
						const latest = jobIndex.length > 0 ? jobIndex[0] : null;
						if (!latest) {
							ctx.ui.notify("No background jobs.", "info");
							return;
						}
						followJob(latest, ctx);
					} else {
						followJob(rest, ctx);
					}
					return;
				case "gc":
					jobGc(ctx);
					return;
				case "trim":
					jobTrim(rest, ctx);
					return;
				case "help":
				case "?":
					ctx.ui.notify(
						`/job (interactive) / job ls / attach / tail / kill / trim / follow / gc (auto-keeps ${AUTO_TRIM_KEEP} finished)`,
						"info",
					);
					return;
				default:
					ctx.ui.notify(
						`Unknown subcommand: ${sub}. Try: ${SUBCOMMANDS.join(", ")}`,
						"warning",
					);
			}
		},
	});

	// --- /job follow ---

	class FollowComponent implements Component {
		private theme: Theme;
		private pollFile: string;
		private tailLines: string[] = [];
		private interval: ReturnType<typeof setInterval> | null = null;
		private tui: TUI | null = null;
		private done: () => void;

		constructor(theme: Theme, pollFile: string, done: () => void) {
			this.theme = theme;
			this.pollFile = pollFile;
			this.done = done;
		}

		setTUI(tui: TUI): void {
			this.tui = tui;
			this.interval = setInterval(() => {
				this.readTail();
				this.tui?.requestRender();
			}, 1000);
			this.readTail();
		}

		private readTail(): void {
			try {
				const out = execSync(`tail -n 50 "${this.pollFile}"`, { encoding: "utf8" });
				const lines = out.split("\n").filter((l) => l.length > 0);
				this.tailLines = lines.length > 0 ? lines : ["(output file empty)"];
			} catch {
				this.tailLines = ["(no output yet)"];
			}
		}

		handleInput(data: string): void {
			if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
				this.close();
			}
		}

		invalidate(): void {}

		dispose(): void {
			this.close();
		}

		private close(): void {
			if (this.interval) {
				clearInterval(this.interval);
				this.interval = null;
			}
			this.done();
		}

		render(width: number): string[] {
			const th = this.theme;
			const innerW = Math.max(1, width - 2);

			// Build raw (uncolored) display lines — copy to avoid mutating this.tailLines
			const rawLines: string[] = this.tailLines.length === 0
				? ["(no output)"]
				: [...this.tailLines];
			rawLines.push("", "Esc/q to close");

			const result: string[] = [];
			const title = "bg tail";
			const titleStr = ` ${title} `;
			const titleW = titleStr.length;
			const topLine = "─".repeat(Math.floor((innerW - titleW) / 2));
			const topLine2 = "─".repeat(Math.max(0, innerW - titleW - topLine.length));
			result.push(
				th.fg("border", `╭${topLine}`) +
					th.fg("accent", titleStr) +
					th.fg("border", `${topLine2}╮`),
			);
			for (const raw of rawLines) {
				const truncated = raw.length > innerW ? raw.slice(0, innerW) : raw.padEnd(innerW);
				result.push(th.fg("border", "│") + th.fg("toolOutput", truncated) + th.fg("border", "│"));
			}
			result.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));
			return result;
		}
	}

	const followJob = (rest: string, ctx: ExtensionContext) => {
		const job = resolveJobRef(rest);
		if (!job) {
			ctx.ui.notify(`No such job: ${rest || "(empty)"}`, "warning");
			return;
		}
		if (!fs.existsSync(job.outputFile)) {
			ctx.ui.notify(
				`Output file does not exist yet for job ${job.id}. Wait for it to start.`,
				"warning",
			);
			return;
		}
		ctx.ui.custom<void>(
			(_tui, theme, _kb, done) => new FollowComponent(theme, job.outputFile, done),
			{ overlay: true },
		);
	};
}

