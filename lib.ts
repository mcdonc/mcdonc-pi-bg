/**
 * Shared utilities for the background jobs extension.
 * Extracted for testability.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function ensureDir(p: string): void {
	fs.mkdirSync(p, { recursive: true });
}

export function shortId(): string {
	return Math.random().toString(36).slice(2, 8);
}

export function fmtAge(ms: number): string {
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
export function slugifyCommand(cmd: string): string {
	if (!cmd) return "unknown";
	const clean = cmd.trim().replace(/\n/g, " ");
	// Try to extract the command name, handling paths with slashes
	let mainCmd = "cmd";
	const firstWord = clean.match(/^(?:(?:nohup|sudo|time|nice)\s+)*([^\s]+)/);
	if (firstWord?.[1]) {
		const base = path.basename(firstWord[1]);
		mainCmd = base.replace(/\.\w+$/, "");
	}
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

export function isPidAlive(pid: number): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e: any) {
		return e?.code === "EPERM"; // exists but not ours
	}
}

export function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Build the command that invokes wrapper.ts to run a command under setsid
 * with a control pipe for detach signaling.
 *
 * @param wrapperScript - absolute path to wrapper.ts
 */
export function buildWrapperCommand(opts: {
	wrapperScript: string;
	pipePath: string;
	pidFile: string;
	outFile: string;
	command: string;
}): string {
	return [
		process.execPath,
		"--experimental-strip-types",
		shellQuote(opts.wrapperScript),
		shellQuote(opts.pipePath),
		shellQuote(opts.pidFile),
		shellQuote(opts.outFile),
		opts.command,
	].join(" ");
}
