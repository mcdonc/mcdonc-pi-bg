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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, Theme, TUI } from "@earendil-works/pi-tui";
import { ensureDir, shortId, fmtAge, slugifyCommand, isPidAlive, shellQuote, buildWrapperCommand } from "./lib.ts";

interface BgJobRecord {
	id: string;
	prompt: string;
	slug?: string;
	extra?: string;
	sessionFile?: string;
	logFile?: string;
	outputFile: string;
	pid: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	status: "running" | "exited" | "killed" | "unknown";
}

interface ForkPoint {
	id: string;            // shortId() for display
	leafId: string;        // session tree entry ID of the aborted turn's leaf
	prompt: string;        // original prompt (for display and search)
	forkTimestamp: number;
	resumed: boolean;
}

const STATE_DIR = path.join(os.homedir(), ".pi", "agent", "state", "background");
const CUSTOM_TYPE = "bg-job";
const LAST_PROMPT_TYPE = "bg-last-prompt";
const FORK_POINT_TYPE = "bg-fork-point";

/** How many finished jobs to keep before opportunistic auto-trim kicks in. */
const AUTO_TRIM_KEEP = 5;

interface LastPromptRecord {
	prompt: string;
	timestamp: number;
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
	let currentTailWidget: TailWidget | null = null;
	let jobSelectorOpen = false;
	const forkStack: ForkPoint[] = [];
	let pendingForkLeafId: string | null = null;
	let pendingForkPrompt: string | null = null;


	let currentBashCtrl: {
		pipePath: string;
		pidFile: string;
		outFile: string;
		command: string;
	} | null = null;

	// --- Bash tool with spawnHook ------------------------------------------

	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => {
			const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
			const pipePath = path.join(STATE_DIR, `bg-ctrl-${unique}.pipe`);
			const pidFile = path.join(STATE_DIR, `bg-ctrl-${unique}.pid`);
			const outFile = path.join(STATE_DIR, `bg-ctrl-${unique}.out`);

			currentBashCtrl = { pipePath, pidFile, outFile, command };

			const wrapperScript = path.join(path.dirname(new URL(import.meta.url).pathname), "wrapper.ts");
			const wrapped = buildWrapperCommand({ wrapperScript, pipePath, pidFile, outFile, command });
			return { command: wrapped, cwd, env };
		},
	});

	pi.registerTool({ ...bashTool });

	const killAllRunning = () => {
		for (const job of jobs.values()) {
			if (job.status === "running" && isPidAlive(job.pid)) {
				try { process.kill(-job.pid, "SIGTERM"); } catch { /* ignore */ }
			}
		}
	};

	process.on("exit", killAllRunning);

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
			ctx.ui.setStatus("bg", `⚙ bg:${running} (ctrl-j for jobs)`);
		} else {
			ctx.ui.setStatus("bg", "");
		}
	};

	const updateForkStatus = (ctx: ExtensionContext) => {
		const unresumed = forkStack.filter(f => !f.resumed).length;
		if (unresumed > 0) {
			ctx.ui.setStatus("fork", `⑂ ${unresumed} fork${unresumed > 1 ? "s" : ""}`);
		} else {
			ctx.ui.setStatus("fork", "");
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
			} else if (entry.customType === FORK_POINT_TYPE) {
				const data = entry.data as ForkPoint | undefined;
				if (data?.id) {
					const existing = forkStack.findIndex(f => f.id === data.id);
					if (existing >= 0) {
						forkStack[existing] = { ...data };
					} else {
						forkStack.push({ ...data });
					}
				}
			}
		}
		refreshLiveness();
		updateStatusWidget(ctx);
		updateForkStatus(ctx);

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
		updateForkStatus(ctx);
	});

	pi.on("tool_execution_start", async (event, _ctx) => {
		toolExecuting = true;
		if (typeof event.args?.command === "string") {
			lastBashCommand = event.args.command;
		}
	});

	pi.on("tool_execution_end", async (_event, _ctx) => {
		toolExecuting = false;
		currentBashCtrl = null;
	});

	pi.on("turn_end", async (_event, ctx) => {
		toolExecuting = false;
		updateStatusWidget(ctx);
		updateForkStatus(ctx);
	});

	// --- Fork --------------------------------------------------------------

	/**
	 * Fork from a shortcut handler (ExtensionContext only).
	 * Pre-fills the editor with "/b " but does NOT abort yet. The agent
	 * keeps streaming while the user decides. If the user submits, /s
	 * aborts and forks. If the user hits Escape to clear the editor,
	 * the original task continues uninterrupted.
	 */
	const runForkFromShortcut = (ctx: ExtensionContext) => {
		if (!lastPrompt) {
			ctx.ui.notify("No prompt to fork from.", "warning");
			return;
		}
		if (ctx.isIdle()) {
			ctx.ui.notify("Nothing to fork — agent is idle.", "warning");
			return;
		}

		pendingForkPrompt = lastPrompt;

		// Pre-fill editor with "/b " — user types their message after it.
		// The abort happens in /b command handler, not here.
		ctx.ui.setEditorText("/b ");
	};


	/**
	 * Fork from a command handler (ExtensionCommandContext with navigateTree).
	 * Completes the fork: navigates the tree to create a clean branch.
	 */
	const runForkFromCommand = async (ctx: ExtensionCommandContext) => {
		const prompt = pendingForkPrompt ?? lastPrompt;
		pendingForkLeafId = null;
		pendingForkPrompt = null;

		if (!prompt) {
			ctx.ui.notify("No prompt to fork from.", "warning");
			return;
		}

		if (!ctx.isIdle()) {
			ctx.abort();
			await ctx.waitForIdle();
		}

		// Get the leaf fresh after abort has settled
		const leafId = ctx.sessionManager.getLeafId() ?? null;

		if (!leafId) {
			ctx.ui.notify("Could not determine current position in session tree.", "warning");
			return;
		}

		// Navigate back to before the original user prompt so the side
		// conversation starts on a clean branch. The tree after abort is:
		//   ... → user prompt (B) → aborted assistant (C, leaf)
		// We want to navigate to B's parent (A) so the new branch is a
		// sibling of the original prompt, not a child of it.
		// Walk up the tree from the leaf to find the user message that
		// started this turn, then navigate to its parent so the new branch
		// is a sibling of the original prompt.
		const entries = ctx.sessionManager.getEntries();
		const entryMap = new Map(entries.map(e => [e.id, e]));

		// Find the nearest user message ancestor
		let current = entryMap.get(leafId);
		let userMessageEntry: typeof current = undefined;
		while (current) {
			if ((current as any).type === "message" && (current as any).message?.role === "user") {
				userMessageEntry = current;
				break;
			}
			current = current.parentId ? entryMap.get(current.parentId) : undefined;
		}

		// Navigate to the parent of the user message (or parent of leaf as fallback)
		const navigateTarget = userMessageEntry?.parentId
			?? entryMap.get(leafId)?.parentId
			?? leafId;
		await ctx.navigateTree(navigateTarget);

		const fp: ForkPoint = {
			id: shortId(),
			leafId,
			prompt: prompt ?? "",
			forkTimestamp: Date.now(),
			resumed: false,
		};

		forkStack.push(fp);
		pi.appendEntry(FORK_POINT_TYPE, fp);

		updateForkStatus(ctx);
		ctx.ui.notify(`Forked conversation (${fp.id}). /bb when ready to continue.`, "warning");
	};

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

		if (!currentBashCtrl) {
			ctx.ui.notify(
				"No active bash command to background.",
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

		const ctrl = currentBashCtrl;

		// Write "detach" to the control pipe to tell the wrapper to exit
		// without killing the inner process. Retry a few times in case
		// the wrapper's FIFO reader hasn't opened the read end yet.
		let detachSent = false;
		for (let i = 0; i < 30; i++) {
			try {
				const fd = fs.openSync(ctrl.pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
				fs.writeSync(fd, "detach\n");
				fs.closeSync(fd);
				detachSent = true;
				break;
			} catch {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		if (!detachSent) {
			ctx.ui.notify("Failed to signal detach: control pipe not ready", "error");
			return;
		}

		// Give the wrapper a moment to process the detach signal
		await new Promise((r) => setTimeout(r, 200));

		// Now abort pi's main loop
		ctx.abort();

		// Read the inner PID from the PID file
		let innerPid = -1;
		try {
			const pidStr = fs.readFileSync(ctrl.pidFile, "utf8").trim();
			innerPid = Number.parseInt(pidStr, 10);
		} catch (e: any) {
			ctx.ui.notify(`Failed to read inner PID: ${e?.message ?? e}`, "error");
			return;
		}

		if (!innerPid || innerPid <= 0 || !isPidAlive(innerPid)) {
			ctx.ui.notify("Inner process already exited.", "warning");
			return;
		}

		const id = shortId();
		const outputFile = ctrl.outFile;

		const job: BgJobRecord = {
			id,
			prompt: lastPrompt,
			slug: slugifyCommand(lastBashCommand ?? lastPrompt ?? ""),
			extra: extra || undefined,
			outputFile,
			pid: innerPid,
			startedAt: Date.now(),
			status: "running",
		};
		persist(job);
		lastPromptBackgroundedAt = lastPromptAt;
		currentBashCtrl = null;

		// Poll for process exit
		const pollInterval = setInterval(() => {
			if (!isPidAlive(innerPid)) {
				clearInterval(pollInterval);
				const updated: BgJobRecord = {
					...job,
					endedAt: Date.now(),
					exitCode: undefined,
					status: "exited",
				};
				persist(updated);
				updateStatusWidget(ctx);
				ctx.ui.notify(`bg job ${id} exited`, "info");
			}
		}, 1000);

		ctx.ui.notify(
			`Backgrounded as ${id} (pid ${innerPid})`,
			"warning",
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
		description: "Background a tool / fork conversation / show job list",
		handler: async (ctx) => {
			if (toolExecuting) {
				await runBg("", ctx);
			} else if (!ctx.isIdle()) {
				runForkFromShortcut(ctx);
			} else {
				await showJobSelector(ctx);
			}
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
		if (job.sessionFile) try { fs.unlinkSync(job.sessionFile); } catch { /* ignore */ }
		if (job.logFile) try { fs.unlinkSync(job.logFile); } catch { /* ignore */ }
		try { fs.unlinkSync(job.outputFile); } catch { /* ignore */ }
		// Clean up control pipe and pid files that may exist in STATE_DIR
		// These share the same basename pattern as the .out file
		const outBase = path.basename(job.outputFile, ".out");
		if (outBase.startsWith("bg-ctrl-")) {
			try { fs.unlinkSync(path.join(STATE_DIR, `${outBase}.pipe`)); } catch { /* ignore */ }
			try { fs.unlinkSync(path.join(STATE_DIR, `${outBase}.pid`)); } catch { /* ignore */ }
		}
	}

	const jobAttach = async (rest: string, ctx: ExtensionCommandContext) => {
		const job = resolveJobRef(rest);
		if (!job) {
			ctx.ui.notify(`No such job: ${rest || "(empty)"}`, "warning");
			return;
		}
		if (!job.sessionFile) {
			ctx.ui.notify(
				`Job ${job.id} has no session file (detached process). Use tail or follow instead.`,
				"warning",
			);
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
			if (isPidAlive(job.pid)) {
				try { process.kill(-job.pid, "SIGKILL"); } catch { /* ignore */ }
			}
			persist({ ...job, status: "killed", endedAt: Date.now() });
			updateStatusWidget(ctx);
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
			if (job.sessionFile) tracked.add(path.basename(job.sessionFile));
			if (job.logFile) tracked.add(path.basename(job.logFile));
			tracked.add(path.basename(job.outputFile));
			// Also track associated .pipe and .pid files
			const outBase = path.basename(job.outputFile, ".out");
			if (outBase.startsWith("bg-ctrl-")) {
				tracked.add(`${outBase}.pipe`);
				tracked.add(`${outBase}.pid`);
			}
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

	const SUBCOMMANDS = ["ls", "attach", "tail", "kill", "trim", "follow", "fullfollow", "gc", "help"] as const;

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
				let scrollOffset = 0;

				const rebuildJobs = () => {
					refreshLiveness();
					currentJobs = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
					selectedIndex = Math.min(selectedIndex, Math.max(0, currentJobs.length - 1));
					scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, currentJobs.length - 6)));
				};

				const handleNavigation = () => {
					// Update scroll offset to keep selected job visible
					const MAX_JOBS = 6;
					if (selectedIndex < scrollOffset) {
						scrollOffset = selectedIndex;
					} else if (selectedIndex >= scrollOffset + MAX_JOBS) {
						scrollOffset = Math.max(0, selectedIndex - MAX_JOBS + 1);
					}
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

						// Job list with fixed-width columns (max 6 visible, with scrolling)
						const MAX_JOBS = 6;
						const visibleCount = Math.min(currentJobs.length, MAX_JOBS);
						for (let i = 0; i < visibleCount; i++) {
							const jobIdx = scrollOffset + i;
							const job = currentJobs[jobIdx]!;
							const prefix = jobIdx === selectedIndex ? "> " : "  ";

							const jobId = job.id.padEnd(6);
							const age = fmtAge(now - job.startedAt).padStart(5);
							const statusChar =
								job.status === "running" ? theme.fg("warning", "●")
								: job.status === "killed" ? theme.fg("error", "✗")
								: job.status === "exited" ? theme.fg("success", "✓")
								: theme.fg("muted", "?");
							const slug = (job.slug ?? "?").slice(0, 15).padEnd(15);
							const promptPreview = job.prompt.length > 30 ? `${job.prompt.slice(0, 30)}…` : job.prompt;

							const prefix2 = i === selectedIndex ? theme.fg("accent", prefix) : prefix;
							const jobId2 = i === selectedIndex ? theme.fg("accent", jobId) : jobId;
							const line = `${prefix2}${jobId2} ${age} ${statusChar} ${slug}  ${promptPreview}`;
							const truncated = truncateToWidth(line, innerW, "");
							const padding = " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
							result.push(theme.fg("border", "│") + truncated + padding + theme.fg("border", "│"));
						}

						// Pad with empty bordered lines to fixed height (prevent ghosting from follow widget below)
						for (let i = visibleCount; i < MAX_JOBS; i++) {
							const emptyLine = " ".repeat(innerW);
							result.push(theme.fg("border", "│") + emptyLine + theme.fg("border", "│"));
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
								followState = "off";
							} else if (currentJobs[selectedIndex]) {
								followJob(currentJobs[selectedIndex]!.id, ctx);
								followState = "tail";
							}
							tui.requestRender();
						} else if (data === "x") {
							const job = currentJobs[selectedIndex];
							if (job && job.status === "running") {
								try {
									process.kill(-job.pid, "SIGTERM");
									ctx.ui.notify(`Sent SIGTERM to ${job.id} process group (pid ${job.pid})`, "info");
									setTimeout(() => {
										if (isPidAlive(job.pid)) {
											try { process.kill(-job.pid, "SIGKILL"); } catch { /* ignore */ }
										}
										persist({ ...job, status: "killed", endedAt: Date.now() });
										updateStatusWidget(ctx);
										rebuildJobs();
										tui.requestRender();
									}, 500);
								} catch (e: any) {
									ctx.ui.notify(`Failed to kill ${job.id}: ${e?.message ?? e}`, "error");
								}
							} else if (job) {
								ctx.ui.notify(`Job ${job.id} is not running (${job.status})`, "warning");
							}
						}
					},
				};
			}, { overlay: true, overlayOptions: { width: "90%", margin: { left: 2, right: 2 } } });
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
				case "fullfollow":
				case "ff":
					if (!rest) {
						refreshLiveness();
						const sorted2 = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
						jobIndex = sorted2.map((j) => j.id);
						const latest2 = jobIndex.length > 0 ? jobIndex[0] : null;
						if (!latest2) {
							ctx.ui.notify("No background jobs.", "info");
							return;
						}
						await showFullPageFollow(latest2, ctx);
					} else {
						await showFullPageFollow(rest, ctx);
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
						`/job (interactive) / job ls / attach / tail / kill / trim / follow / fullfollow / gc (auto-keeps ${AUTO_TRIM_KEEP} finished)`,
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

		/** Switch to a different job without recreating the widget. */
		switchJob(job: BgJobRecord): void {
			// Stop watching the old file
			if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } this.watcher = null; }
			// Reset state
			this.job = job;
			this.lines = [];
			this.partial = "";
			this.readPos = 0;
			this.cachedWidth = undefined;
			// Start watching new file (poll interval continues running)
			this.readNewData();
			try {
				this.watcher = fs.watch(this.job.outputFile, { persistent: false }, () => {
					if (this.disposed) return;
					this.readNewData();
					this.tui.requestRender();
				});
				this.watcher.on("error", () => { this.watcher = null; });
			} catch { /* fall through to polling */ }
			this.tui.requestRender();
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
		if (currentTailWidget) {
			currentTailWidget.dispose();
			currentTailWidget = null;
		}
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

		// If widget already exists, switch its job without recreating to avoid ghosting
		if (currentTailWidget) {
			followedJobId = job.id;
			currentTailWidget.switchJob(job);
		} else {
			followedJobId = job.id;
			ctx.ui.setWidget(
				"bg-follow",
				(tui, theme) => {
					currentTailWidget = new TailWidget(tui, theme, job, jobs);
					return currentTailWidget;
				},
				{ placement: "belowEditor" },
			);
		}
	};

	/**
	 * Full-page scrolling follow overlay. Reads the job's output file
	 * incrementally (like TailWidget) and allows scrolling through the
	 * entire history. Auto-follows new output unless the user has scrolled up.
	 */
	const showFullPageFollow = async (jobRef: string, ctx: ExtensionContext): Promise<void> => {
		const job = resolveJobRef(jobRef);
		if (!job) {
			ctx.ui.notify(`No such job: ${jobRef || "(empty)"}`, "warning");
			return;
		}
		if (!fs.existsSync(job.outputFile)) {
			try { fs.writeFileSync(job.outputFile, ""); } catch { /* ignore */ }
		}

		if (followedJobId) {
			closeFollowWidget(ctx);
		}

		await ctx.ui.custom<void>((tui, theme, kb, done) => {
			let lines: string[] = [];
			let partial = "";
			let readPos = 0;
			let scrollOffset = 0;
			let autoFollow = true;
			let watcher: fs.FSWatcher | null = null;
			let pollInterval: ReturnType<typeof setInterval> | null = null;
			let disposed = false;

			const readNewData = () => {
				let fd: number | null = null;
				try {
					const stat = fs.statSync(job.outputFile);
					if (stat.size <= readPos) return;
					const chunkSize = stat.size - readPos;
					const buf = Buffer.alloc(chunkSize);
					fd = fs.openSync(job.outputFile, "r");
					const bytesRead = fs.readSync(fd, buf, 0, chunkSize, readPos);
					readPos += bytesRead;
					const text = partial + buf.slice(0, bytesRead).toString("utf8");
					const parts = text.split("\n");
					for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i]!);
					partial = parts[parts.length - 1]!;
				} catch { /* file may not exist yet */ }
				finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
			};

			readNewData();

			try {
				watcher = fs.watch(job.outputFile, { persistent: false }, () => {
					if (disposed) return;
					readNewData();
					if (autoFollow) scrollOffset = Math.max(0, lines.length);
					tui.requestRender();
				});
				watcher.on("error", () => { watcher = null; });
			} catch { /* fall through to polling */ }

			pollInterval = setInterval(() => {
				if (disposed) return;
				const before = readPos;
				readNewData();
				if (readPos !== before) {
					if (autoFollow) scrollOffset = Math.max(0, lines.length);
					tui.requestRender();
				}
			}, 500);

			const cleanup = () => {
				if (disposed) return;
				disposed = true;
				if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
				if (pollInterval) { clearInterval(pollInterval); }
				done();
			};

			return {
				render: (width: number) => {
					const innerW = Math.max(1, width - 2);
					const termHeight = process.stdout.rows || 24;
					const result: string[] = [];

					// Title bar
					const jobStatus = jobs.get(job.id)?.status ?? job.status;
					const statusRaw =
						jobStatus === "running" ? "running" :
						jobStatus === "exited" ? "done" :
						jobStatus === "killed" ? "killed" : jobStatus;
					const statusStyled =
						jobStatus === "running" ? theme.fg("warning", "● " + statusRaw) :
						jobStatus === "exited" ? theme.fg("success", "✓ " + statusRaw) :
						jobStatus === "killed" ? theme.fg("error", "✗ " + statusRaw) :
						theme.fg("muted", statusRaw);
					const followIndicator = autoFollow ? theme.fg("success", "FOLLOW") : theme.fg("dim", "SCROLL");
					const titlePlain = ` bg:${job.id} ${statusRaw}  ${autoFollow ? "FOLLOW" : "SCROLL"}  esc close `;
					const titleW = Math.min(visibleWidth(titlePlain), innerW);
					const dashL = Math.floor((innerW - titleW) / 2);
					const dashR = Math.max(0, innerW - titleW - dashL);
					const titleStyled =
						` bg:${theme.fg("accent", job.id)} ${statusStyled}  ${followIndicator}  ` +
						theme.fg("dim", "esc close") + " ";
					result.push(
						theme.fg("border", "╭" + "─".repeat(dashL)) +
						titleStyled +
						theme.fg("border", "─".repeat(dashR) + "╮")
					);

					// Content area: termHeight minus top/bottom margin (5+5) and chrome (title + help + bottom border = 3)
					const contentRows = Math.max(1, termHeight - 10 - 3);
					const display = partial ? [...lines, partial + "▌"] : [...lines];
					if (display.length === 0) display.push("(no output yet)");

					if (autoFollow) {
						scrollOffset = Math.max(0, display.length - contentRows);
					}
					const maxScroll = Math.max(0, display.length - contentRows);
					scrollOffset = Math.max(0, Math.min(scrollOffset, maxScroll));

					const pad = (s: string) => {
						const truncated = truncateToWidth(s, innerW, "");
						return truncated + " ".repeat(Math.max(0, innerW - visibleWidth(truncated)));
					};

					for (let i = 0; i < contentRows; i++) {
						const lineIdx = scrollOffset + i;
						const raw = lineIdx < display.length ? display[lineIdx]! : "";
						const line = theme.fg("border", "│") + pad(theme.fg("toolOutput", raw)) + theme.fg("border", "│");
						result.push(truncateToWidth(line, width, ""));
					}

					// Help bar
					const lineInfo = `${Math.min(scrollOffset + 1, display.length)}-${Math.min(scrollOffset + contentRows, display.length)}/${display.length}`;
					const help = ` ↑↓ scroll • PgUp/PgDn • Home/End • esc close  ${lineInfo} `;
					const helpTruncated = truncateToWidth(theme.fg("dim", help), innerW, "");
					const helpPadding = " ".repeat(Math.max(0, innerW - visibleWidth(helpTruncated)));
					result.push(theme.fg("border", "│") + helpTruncated + helpPadding + theme.fg("border", "│"));

					// Bottom border
					result.push(theme.fg("border", "╰" + "─".repeat(innerW) + "╯"));

					return result;
				},
				invalidate: () => { tui.requestRender(); },
				handleInput: (data: string) => {
					if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "q") || matchesKey(data, "ctrl+f") || matchesKey(data, "ctrl+b")) {
						cleanup();
					} else if (kb.matches(data, "tui.select.up")) {
						autoFollow = false;
						scrollOffset = Math.max(0, scrollOffset - 1);
						tui.requestRender();
					} else if (kb.matches(data, "tui.select.down")) {
						scrollOffset++;
						const display = partial ? lines.length + 1 : lines.length;
						const maxScroll = Math.max(0, display - 1);
						if (scrollOffset >= maxScroll) autoFollow = true;
						tui.requestRender();
					} else if (matchesKey(data, "pageup")) {
						autoFollow = false;
						scrollOffset = Math.max(0, scrollOffset - 20);
						tui.requestRender();
					} else if (matchesKey(data, "pagedown")) {
						scrollOffset += 20;
						autoFollow = true; // will be recalculated on render
						tui.requestRender();
					} else if (matchesKey(data, "home")) {
						autoFollow = false;
						scrollOffset = 0;
						tui.requestRender();
					} else if (matchesKey(data, "end")) {
						autoFollow = true;
						scrollOffset = Math.max(0, lines.length);
						tui.requestRender();
					}
				},
			};
		}, { overlay: true, overlayOptions: { width: "90%", margin: { left: 2, right: 2, top: 5, bottom: 5 } } });
	};

	// ctrl+f cycles: off → follow pane → full follow → off
	let followState: "off" | "tail" | "full" = "off";

	pi.registerShortcut("ctrl+f", {
		description: "Cycle: off → follow pane → full follow → off",
		handler: async (ctx) => {
			refreshLiveness();
			const sorted = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
			jobIndex = sorted.map((j) => j.id);

			if (sorted.length === 0) {
				ctx.ui.notify("No background jobs.", "info");
				followState = "off";
				return;
			}

			if (followState === "off") {
				followJob(jobIndex[0]!, ctx);
				followState = "tail";
			} else if (followState === "tail") {
				closeFollowWidget(ctx);
				followState = "full";
				await showFullPageFollow(jobIndex[0]!, ctx);
				followState = "off";
			} else {
				// "full" — shouldn't normally reach here since full follow
				// blocks until closed, but reset just in case
				closeFollowWidget(ctx);
				followState = "off";
			}
		},
	});

	pi.registerShortcut("ctrl+j", {
		description: "Toggle job selector widget",
		handler: async (ctx) => {
			await showJobSelector(ctx);
		},
	});

	// --- /bb ----------------------------------------------------------

	pi.registerCommand("bb", {
		description: "Rejoin the most recent forked conversation branch",
		handler: async (_args, ctx) => {
			const recent = [...forkStack].reverse().find(f => !f.resumed);
			if (!recent) {
				ctx.ui.notify("No fork points to rejoin.", "info");
				return;
			}
			recent.resumed = true;
			pi.appendEntry(FORK_POINT_TYPE, recent);
			await ctx.navigateTree(recent.leafId);
			updateForkStatus(ctx);
			const prompt = recent.prompt;
			pi.sendUserMessage(`Continue the task you were working on before I interrupted you. The original request was:\n\n<original-request>\n${prompt}\n</original-request>\n\nPick up where you left off.`, { deliverAs: "followUp" });
		},
	});

	// --- /bbb -----------------------------------------------------------

	pi.registerCommand("bbb", {
		description: "Abandon all forks and resume the original (root) task",
		handler: async (_args, ctx) => {
			const unresumed = forkStack.filter(f => !f.resumed);
			if (unresumed.length === 0) {
				ctx.ui.notify("No fork points to abandon.", "info");
				return;
			}

			// Find the earliest (root) fork — that's the one we want to resume
			const root = unresumed.reduce((earliest, f) =>
				f.forkTimestamp < earliest.forkTimestamp ? f : earliest
			);

			// Mark all forks as resumed
			for (const fp of unresumed) {
				fp.resumed = true;
				pi.appendEntry(FORK_POINT_TYPE, fp);
			}

			await ctx.navigateTree(root.leafId);
			updateForkStatus(ctx);

			const prompt = root.prompt;
			pi.sendUserMessage(`Continue the task you were working on before I interrupted you. The original request was:\n\n<original-request>\n${prompt}\n</original-request>\n\nPick up where you left off.`, { deliverAs: "followUp" });
		},
	});

	// --- /b -------------------------------------------------------------

	pi.registerCommand("b", {
		description: "Fork the conversation. /b <message> to fork and send message",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();

			// Fork the conversation (navigateTree for clean branch)
			await runForkFromCommand(ctx);

			// If the user typed text after /s, send it as their first
			// message on the new branch
			if (trimmed) {
				pi.sendUserMessage(trimmed);
			}
		},
	});

}
