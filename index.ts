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

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";

interface BgJobRecord {
	id: string;
	prompt: string;
	slug?: string;
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

/**
 * Generate a simple slug from a bash command.
 * Extracts the main command and a few key details.
 */
function slugifyCommand(cmd: string): string {
	if (!cmd) return "unknown";
	const clean = cmd.trim().replace(/\n/g, " ");
	const match = clean.match(/^(?:(?:nohup|sudo|time|nice)\s+)*(\w+)/);
	const mainCmd = match?.[1] ?? "cmd";
	if (clean.includes("sleep")) {
		const sleepMatch = clean.match(/sleep\s+(\d+)/);
		if (sleepMatch) return `sleep-${sleepMatch[1]}s`;
	}
	if (clean.includes("for i in")) {
		const seqMatch = clean.match(/seq\s+\d+\s+(\d+)/);
		if (seqMatch) return `loop-${seqMatch[1]}`;
	}
	if (clean.includes(" > ") || clean.includes(">> ")) {
		const outMatch = clean.match(/>>?\s*([^\s;|&]+)/);
		if (outMatch) {
			const file = path.basename(outMatch[1]!);
			return `${mainCmd}-to-${file}`;
		}
	}
	return mainCmd.slice(0, 20);
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

	const jobs = new Map<string, BgJobRecord>();

	let lastPrompt: string | null = null;
	let lastPromptAt = 0;
	let lastPromptBackgroundedAt = 0;
	let toolExecuting = false;
	let lastBashCommand: string | null = null;
	let followedJobId: string | null = null;
	let jobSelectorOpen = false;

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
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === CUSTOM_TYPE) {
				const data = entry.data as BgJobRecord | undefined;
				if (data?.id) {
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
		toolExecuting = true;
		if (typeof event.args?.command === "string") {
			lastBashCommand = event.args.command;
		}
	});

	pi.on("tool_execution_end", async (_event, _ctx) => {
		toolExecuting = false;
	});

	pi.on("turn_end", async (_event, ctx) => {
		toolExecuting = false;
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

		if (!toolExecuting) {
			ctx.ui.notify(
				"No tool is currently executing. Can only background active tool runs.",
				"warning",
			);
			return;
		}

		if (lastPromptBackgroundedAt === lastPromptAt) {
			ctx.ui.notify(
				"This prompt was already backgrounded. Send a new prompt first.",
				"warning",
			);
			return;
		}

		const wasBusy = !ctx.isIdle();
		if (wasBusy) {
			ctx.abort();
			await new Promise((r) => setTimeout(r, 150));
		}

		const id = shortId();
		const sessionFile = path.join(STATE_DIR, `bg-${id}.jsonl`);
		const logFile = path.join(STATE_DIR, `bg-${id}.log`);
		const outputFile = path.join(STATE_DIR, `bg-${id}.out`);

		const noteSuffix = extra ? `\n\nAdditional instruction from user: ${extra}` : "";
		const childPrompt =
			`## SYSTEM INSTRUCTION - BACKGROUND TASK\n\n` +
			`You are a background agent. Do NOT respond to this message conversationally. ` +
			`Do NOT explain anything. Do NOT ask questions. ` +
			`Immediately execute the following user request:\n\n` +
			`${lastBashCommand ?? lastPrompt ?? "(no task)"}${noteSuffix}\n\n` +
			`### Execution rules\n` +
			`1. Redirect the command's stdout and stderr to ${outputFile} so the user can ` +
			`monitor progress in real time.\n` +
			`2. Do NOT background the command with \`&\` — this pi process is already ` +
			`running as a background job.\n` +
			`3. The command may run for hours or days. Use a very large timeout (e.g., ` +
			`86400 seconds or more) when calling the bash tool.`;

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
			slug: slugifyCommand(lastBashCommand ?? lastPrompt ?? ""),
			extra: extra || undefined,
			sessionFile,
			logFile,
			outputFile,
			pid: child.pid ?? -1,
			startedAt: Date.now(),
			status: child.pid ? "running" : "unknown",
		};
		persist(job);
		lastPromptBackgroundedAt = lastPromptAt;

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
			} catch { /* ignore */ }
			try { fs.closeSync(out); } catch { /* ignore */ }
			try { fs.closeSync(err); } catch { /* ignore */ }
			persist(updated);
			updateStatusWidget(ctx);
			const wasTerminated = code === 143 || code === 137 || killed;
			const level: "info" | "warning" | "error" = wasTerminated
				? "warning"
				: (code ?? 0) === 0
					? "info"
					: "error";
			const suffix = wasTerminated ? "killed" : `exited code=${code ?? "?"}`;
			ctx.ui.notify(`bg job ${id} ${suffix}`, level);
		});

		ctx.ui.notify(
			`Backgrounded as ${id}${wasBusy ? " (aborted current turn)" : ""}`,
			"info",
		);
		trimFinished(AUTO_TRIM_KEEP);
		updateStatusWidget(ctx);
		if (followedJobId) {
			followJob(id, ctx);
		}
	};

	pi.registerCommand("bg", {
		description:
			"Abort current turn and respawn the last user prompt as a background pi job",
		handler: async (args, ctx) => {
			await runBg((args ?? "").trim(), ctx);
		},
	});

	pi.registerShortcut("ctrl+b", {
		description: "Background a running tool execution (or show job list if nothing is executing)",
		handler: async (ctx) => {
			if (toolExecuting) {
				await runBg("", ctx);
			} else {
				await showJobSelector(ctx);
			}
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

		let content = "(no output yet)";
		try {
			const stat = fs.statSync(job.outputFile);
			const size = stat.size;
			const start = Math.max(0, size - 40 * 1024);
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
			process.kill(-job.pid, "SIGTERM");
			ctx.ui.notify(`Sent SIGTERM to ${job.id} process group (pid ${job.pid})`, "info");
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

	/**
	 * Show an interactive job selector with kill support (x key).
	 */
	const showJobSelector = async (ctx: ExtensionContext): Promise<void> => {
		if (jobSelectorOpen) {
			jobSelectorOpen = false;
			return;
		}
		refreshLiveness();
		trimFinished(AUTO_TRIM_KEEP);
		const sorted = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
		if (sorted.length === 0) {
			ctx.ui.notify("No background jobs.", "info");
			return;
		}

		jobSelectorOpen = true;
		try {
			await ctx.ui.custom<void>((tui, theme, kb, done) => {
				let selectedIndex = 0;
				let currentJobs = sorted;

				const rebuildJobs = () => {
					refreshLiveness();
					currentJobs = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
					selectedIndex = Math.min(selectedIndex, Math.max(0, currentJobs.length - 1));
				};

				const handleNavigation = () => {
					if (followedJobId && currentJobs[selectedIndex]) {
						followJob(currentJobs[selectedIndex]!.id, ctx);
					}
				};

				return {
					render: (width: number) => {
						const innerW = Math.max(1, width - 2);
						const result: string[] = [];
						const now = Date.now();

						// Top border with title
						const title = " Background Jobs ";
						const dashL = Math.floor((innerW - title.length) / 2);
						const dashR = Math.max(0, innerW - title.length - dashL);
						result.push(
							theme.fg("border", "╭" + "─".repeat(dashL)) +
							theme.fg("accent", theme.bold(title)) +
							theme.fg("border", "─".repeat(dashR) + "╮")
						);

						// Job list with fixed-width columns (max 10 visible)
						const MAX_JOBS = 10;
						const visibleCount = Math.min(currentJobs.length, MAX_JOBS);
						for (let i = 0; i < visibleCount; i++) {
							const job = currentJobs[i]!;
							const prefix = i === selectedIndex ? "> " : "  ";

							// Column 1: Job ID (6 chars)
							const jobId = job.id.padEnd(6);
							// Column 2: Age (6 chars)
							const age = fmtAge(now - job.startedAt).padStart(6);
							// Column 3: Status (25 chars) - styled but padded to fixed width
							const statusRaw =
								job.status === "running"
									? `running pid=${job.pid}`
									: job.status === "killed"
										? "killed"
										: job.status === "exited"
											? `exited code=${job.exitCode ?? "?"}`
											: job.status;
							const statusStyled =
								job.status === "running"
									? theme.fg("warning", statusRaw)
									: job.status === "killed"
										? theme.fg("error", statusRaw)
										: job.status === "exited"
											? theme.fg("success", statusRaw)
											: theme.fg("muted", statusRaw);
							const statusPadded = statusStyled + " ".repeat(Math.max(0, 25 - statusRaw.length));
							// Column 4: Slug (20 chars)
							const slug = (job.slug ?? "?").padEnd(20).slice(0, 20);
							// Column 5: Prompt (30 chars max)
							const promptPreview = job.prompt.length > 30 ? `${job.prompt.slice(0, 30)}…` : job.prompt;

							// Don't wrap entire line in accent - just highlight prefix and ID to avoid nested ANSI width issues
							const prefix2 = i === selectedIndex ? theme.fg("accent", prefix) : prefix;
							const jobId2 = i === selectedIndex ? theme.fg("accent", jobId) : jobId;
							const line = `${prefix2}${jobId2}  ${age}  ${statusPadded}  ${slug}  ${promptPreview}`;
							const truncated = truncateToWidth(line, innerW, "");
							const padding = " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
							result.push(theme.fg("border", "│") + truncated + padding + theme.fg("border", "│"));
						}

						// Pad to fixed height to prevent ghosting when follow widget changes height
						for (let i = visibleCount; i < MAX_JOBS; i++) {
							result.push(theme.fg("border", "│") + " ".repeat(innerW) + theme.fg("border", "│"));
						}

						// Help text
						const help = " ↑↓ nav • x kill • ctrl+f follow • ctrl+b/ctrl+j/esc close ";
						const helpStyled = theme.fg("dim", help);
						const helpTruncated = truncateToWidth(helpStyled, innerW, "");
						const helpPadding = " ".repeat(Math.max(0, innerW - visibleWidth(helpTruncated)));
						result.push(theme.fg("border", "│") + helpTruncated + helpPadding + theme.fg("border", "│"));

						// Bottom border
						result.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));

						return result;
					},
					invalidate: () => { tui.requestRender(); },
					handleInput: (data: string) => {
						if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q") || matchesKey(data, "ctrl+j") || matchesKey(data, "ctrl+b")) {
							done();
						} else if (kb.matches(data, "tui.select.up") && selectedIndex > 0) {
							selectedIndex--;
							handleNavigation();
							tui.requestRender();
						} else if (kb.matches(data, "tui.select.down") && selectedIndex < currentJobs.length - 1) {
							selectedIndex++;
							handleNavigation();
							tui.requestRender();
						} else if (matchesKey(data, "ctrl+f")) {
							if (followedJobId) {
								closeFollowWidget(ctx);
							} else if (currentJobs[selectedIndex]) {
								followJob(currentJobs[selectedIndex]!.id, ctx);
							}
							tui.requestRender();
						} else if (data === "x") {
							const job = currentJobs[selectedIndex];
							if (job && job.status === "running") {
								try {
									process.kill(-job.pid, "SIGTERM");
									persist({ ...job, status: "killed", endedAt: Date.now() });
									updateStatusWidget(ctx);
									ctx.ui.notify(`Sent SIGTERM to ${job.id} process group (pid ${job.pid})`, "info");
									rebuildJobs();
									tui.requestRender();
								} catch (e: any) {
									ctx.ui.notify(`Failed to kill ${job.id}: ${e?.message ?? e}`, "error");
								}
							} else if (job) {
								ctx.ui.notify(`Job ${job.id} is not running (${job.status})`, "warning");
							}
						}
					},
				};
			}, { overlay: true, overlayOptions: { width: "90%", margin: { left: 5, right: 5 } } });
		} finally {
			jobSelectorOpen = false;
		}
	};

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
				await showJobSelector(ctx);
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

	/**
	 * TailWidget: a compact below-editor widget that shows the last N lines of a
	 * job's output file. Uses fs.watch + 500ms polling for live updates.
	 */
	class TailWidget {
		private theme: Theme;
		private tui: TUI;
		private job: BgJobRecord;
		private jobsMap: Map<string, BgJobRecord>;

		private lines: string[] = [];
		private partial = "";
		private readPos = 0;

		private watcher: fs.FSWatcher | null = null;
		private pollInterval: ReturnType<typeof setInterval> | null = null;
		private disposed = false;

		private static readonly ROWS = 5;

		private cachedWidth?: number;
		private cachedResult?: string[];
		private cachedLinesLen = -1;
		private cachedStatus?: string;

		constructor(tui: TUI, theme: Theme, job: BgJobRecord, jobsMap: Map<string, BgJobRecord>) {
			this.tui = tui;
			this.theme = theme;
			this.job = job;
			this.jobsMap = jobsMap;
			this.start();
		}

		private start(): void {
			this.readNewData();
			try {
				this.watcher = fs.watch(this.job.outputFile, { persistent: false }, () => {
					if (this.disposed) return;
					this.readNewData();
					this.tui.requestRender();
				});
				this.watcher.on("error", () => { this.watcher = null; });
			} catch { /* fall through to polling */ }
			this.pollInterval = setInterval(() => {
				if (this.disposed) return;
				const before = this.readPos;
				this.readNewData();
				if (this.readPos !== before) this.tui.requestRender();
			}, 500);
		}

		private readNewData(): void {
			let fd: number | null = null;
			try {
				const stat = fs.statSync(this.job.outputFile);
				if (stat.size <= this.readPos) return;
				const chunkSize = stat.size - this.readPos;
				const buf = Buffer.alloc(chunkSize);
				fd = fs.openSync(this.job.outputFile, "r");
				const bytesRead = fs.readSync(fd, buf, 0, chunkSize, this.readPos);
				this.readPos += bytesRead;
				const text = this.partial + buf.slice(0, bytesRead).toString("utf8");
				const parts = text.split("\n");
				for (let i = 0; i < parts.length - 1; i++) this.lines.push(parts[i]!);
				this.partial = parts[parts.length - 1]!;
				this.cachedWidth = undefined;
			} catch { /* file may not exist yet */ }
			finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
		}

		invalidate(): void {
			this.cachedWidth = undefined;
		}

		dispose(): void {
			if (this.disposed) return;
			this.disposed = true;
			if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
			if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
		}

		render(width: number): string[] {
			const currentStatus = this.jobsMap.get(this.job.id)?.status ?? this.job.status;
			if (this.cachedResult && this.cachedWidth === width && this.cachedLinesLen === this.lines.length && this.cachedStatus === currentStatus) {
				return this.cachedResult;
			}

			const th = this.theme;
			const ROWS = TailWidget.ROWS;
			const innerW = Math.max(1, width - 2);

			const pad = (s: string) => {
				const truncated = truncateToWidth(s, innerW, "");
				return truncated + " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
			};

			const jobStatus = this.jobsMap.get(this.job.id)?.status ?? this.job.status;
			const statusLabel =
				jobStatus === "running" ? th.fg("warning", "● running") :
				jobStatus === "exited" ? th.fg("success", "✓ done") :
				jobStatus === "killed" ? th.fg("error", "✗ killed") :
				th.fg("muted", jobStatus);
			const titlePlain = ` bg:${this.job.id} ${jobStatus}  ctrl+f close `;
			const titleW = Math.min(visibleWidth(titlePlain), innerW);
			const dashL = Math.floor((innerW - titleW) / 2);
			const dashR = Math.max(0, innerW - titleW - dashL);
			const titleStyled =
				` bg:${th.fg("accent", this.job.id)} ${statusLabel}  ` +
				th.fg("dim", "ctrl+f close") + " ";
			const titleLineRaw =
				th.fg("border", `╭${"─".repeat(dashL)}`) +
				titleStyled +
				th.fg("border", `${"─".repeat(dashR)}╮`);
			const titleLine = truncateToWidth(titleLineRaw, width, "");

			const display = this.partial ? [...this.lines, this.partial + "▌"] : this.lines;
			const slice = display.slice(Math.max(0, display.length - ROWS));

			const result: string[] = [titleLine];
			for (let i = 0; i < ROWS; i++) {
				const raw = slice[i] ?? "";
				const line = th.fg("border", "│") + pad(th.fg("toolOutput", raw)) + th.fg("border", "│");
				result.push(truncateToWidth(line, width, ""));
			}
			const bottomLine = th.fg("border", `╰${"─".repeat(innerW)}╯`);
			result.push(truncateToWidth(bottomLine, width, ""));

			this.cachedWidth = width;
			this.cachedLinesLen = this.lines.length;
			this.cachedStatus = currentStatus;
			this.cachedResult = result;
			return result;
		}
	}

	const closeFollowWidget = (ctx: ExtensionContext) => {
		ctx.ui.setWidget("bg-follow", undefined);
		followedJobId = null;
	};

	const followJob = (rest: string, ctx: ExtensionContext) => {
		const job = resolveJobRef(rest);
		if (!job) {
			ctx.ui.notify(`No such job: ${rest || "(empty)"}`, "warning");
			return;
		}

		if (followedJobId === job.id) {
			closeFollowWidget(ctx);
			return;
		}

		if (!fs.existsSync(job.outputFile)) {
			try { fs.writeFileSync(job.outputFile, ""); } catch { /* ignore */ }
		}

		followedJobId = job.id;

		ctx.ui.setWidget(
			"bg-follow",
			(tui, theme) => new TailWidget(tui, theme, job, jobs),
			{ placement: "belowEditor" },
		);
	};

	pi.registerShortcut("ctrl+f", {
		description: "Toggle the bg-follow tail widget (or open most recent job)",
		handler: async (ctx) => {
			if (followedJobId) {
				closeFollowWidget(ctx);
			} else {
				refreshLiveness();
				const sorted = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
				jobIndex = sorted.map((j) => j.id);
				if (sorted.length === 0) {
					ctx.ui.notify("No background jobs.", "info");
					return;
				}
				followJob(jobIndex[0]!, ctx);
			}
		},
	});

	pi.registerShortcut("ctrl+j", {
		description: "Toggle job selector widget",
		handler: async (ctx) => {
			await showJobSelector(ctx);
		},
	});
}
