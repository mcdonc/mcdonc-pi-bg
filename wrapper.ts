/**
 * Wrapper script that runs a command under setsid with a control pipe
 * for detach signaling. Used by the background jobs extension's spawnHook.
 *
 * Usage: node --experimental-strip-types wrapper.ts <pipe_path> <pid_file> <out_file> <command>
 *
 * The command runs under setsid in its own session. Output goes to both
 * stdout (so pi sees it) and the out_file (so follow widgets can tail it).
 *
 * If "detach" is written to the control pipe, the wrapper exits 0 and the
 * inner process keeps running. If the wrapper is killed without a detach
 * message, the inner process is an orphan — the extension is responsible
 * for cleaning it up.
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";

const [pipePath, pidFile, outFile, ...cmdParts] = process.argv.slice(2);
const command = cmdParts.join(" ");

if (!pipePath || !pidFile || !outFile || !command) {
	process.stderr.write("Usage: wrapper.ts <pipe> <pidfile> <outfile> <command>\n");
	process.exit(1);
}

// Create the control pipe (FIFO)
try {
	execSync(`mkfifo ${shellQuote(pipePath)}`, { stdio: "ignore" });
} catch {
	// May already exist
}

// Spawn inner command under setsid
const child = spawn("setsid", ["bash", "-c", `echo $$ > ${shellQuote(pidFile)}; ${command}`], {
	stdio: ["ignore", "pipe", "pipe"],
});

// Tee stdout and stderr to both stdout and the output file
const outFd = fs.openSync(outFile, "a");

child.stdout?.on("data", (chunk: Buffer) => {
	process.stdout.write(chunk);
	fs.writeSync(outFd, chunk);
});

child.stderr?.on("data", (chunk: Buffer) => {
	process.stdout.write(chunk);
	fs.writeSync(outFd, chunk);
});

// Open the FIFO non-blocking so we don't get stuck
let pipeFd: number | null = null;
try {
	pipeFd = fs.openSync(pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
} catch {
	// If we can't open the pipe, we can still run — just no detach support
}

// Poll the FIFO for a "detach" message
let detached = false;
const pollInterval = pipeFd !== null ? setInterval(() => {
	try {
		const buf = Buffer.alloc(64);
		const n = fs.readSync(pipeFd!, buf, 0, 64, null);
		if (n > 0 && buf.slice(0, n).toString("utf8").trim() === "detach") {
			detached = true;
			clearInterval(pollInterval!);
			try { fs.closeSync(pipeFd!); } catch { /* ignore */ }
			try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
			try { fs.closeSync(outFd); } catch { /* ignore */ }
			process.exit(0);
		}
	} catch (e: any) {
		// EAGAIN means no data yet — that's normal for non-blocking reads
		if (e?.code !== "EAGAIN") {
			clearInterval(pollInterval!);
		}
	}
}, 100) : null;

// Wait for the child to exit
child.on("close", (code) => {
	if (detached) return;
	if (pollInterval) clearInterval(pollInterval);
	if (pipeFd !== null) try { fs.closeSync(pipeFd); } catch { /* ignore */ }
	try { fs.closeSync(outFd); } catch { /* ignore */ }
	try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
	try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
	process.exit(code ?? 1);
});

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}
