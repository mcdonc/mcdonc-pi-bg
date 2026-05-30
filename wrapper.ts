/**
 * Wrapper script that runs a command under setsid with a control pipe
 * for detach signaling. Used by the background jobs extension's spawnHook.
 *
 * Usage: node --experimental-strip-types wrapper.ts <pipe_path> <pid_file> <out_file> <command>
 *
 * The inner command's stdout/stderr are redirected directly to out_file.
 * The wrapper tails the file and forwards to its own stdout so pi sees
 * output in real time. On detach, the wrapper exits but the inner process
 * keeps writing to the file — follow widgets can continue tailing it.
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

// Open the output file — inner command writes directly to it
const outFd = fs.openSync(outFile, "a");

// Spawn inner command under setsid with stdout/stderr going to the file
const child = spawn("setsid", ["bash", "-c", `echo $$ > ${shellQuote(pidFile)}; ${command}`], {
	stdio: ["ignore", outFd, outFd],
});

// Tail the output file and forward to our stdout so pi sees it
let tailPos = 0;
const tailInterval = setInterval(() => {
	try {
		const stat = fs.statSync(outFile);
		if (stat.size > tailPos) {
			const buf = Buffer.alloc(stat.size - tailPos);
			const fd = fs.openSync(outFile, "r");
			const n = fs.readSync(fd, buf, 0, buf.length, tailPos);
			fs.closeSync(fd);
			if (n > 0) {
				process.stdout.write(buf.slice(0, n));
				tailPos += n;
			}
		}
	} catch {
		// File may not exist yet
	}
}, 100);

// Open the FIFO non-blocking and keep it open for the lifetime of the wrapper.
// This ensures a writer can connect at any time via O_WRONLY.
let pipeFd: number | null = null;
try {
	pipeFd = fs.openSync(pipePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
} catch {
	// If we can't open the pipe, we can still run — just no detach support
}

// Poll the FIFO for a "detach" message
let detached = false;
const pipeInterval = pipeFd !== null ? setInterval(() => {
	try {
		const buf = Buffer.alloc(64);
		const n = fs.readSync(pipeFd!, buf, 0, 64, null);
		if (n > 0 && buf.slice(0, n).toString("utf8").trim() === "detach") {
			detached = true;
			clearInterval(pipeInterval!);
			clearInterval(tailInterval);
			try { fs.closeSync(pipeFd!); } catch { /* ignore */ }
			try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
			try { fs.closeSync(outFd); } catch { /* ignore */ }
			process.exit(0);
		}
	} catch (e: any) {
		// EAGAIN means no data yet — normal for non-blocking reads
		if (e?.code !== "EAGAIN") {
			clearInterval(pipeInterval!);
		}
	}
}, 100) : null;

// Wait for the child to exit
child.on("close", (code) => {
	if (detached) return;
	// Flush remaining output
	try {
		const stat = fs.statSync(outFile);
		if (stat.size > tailPos) {
			const buf = Buffer.alloc(stat.size - tailPos);
			const fd = fs.openSync(outFile, "r");
			const n = fs.readSync(fd, buf, 0, buf.length, tailPos);
			fs.closeSync(fd);
			if (n > 0) process.stdout.write(buf.slice(0, n));
		}
	} catch { /* ignore */ }
	clearInterval(tailInterval);
	if (pipeInterval) clearInterval(pipeInterval);
	if (pipeFd !== null) try { fs.closeSync(pipeFd); } catch { /* ignore */ }
	try { fs.closeSync(outFd); } catch { /* ignore */ }
	try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
	try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
	process.exit(code ?? 1);
});

function shellQuote(s: string): string {
	return "'" + s.replace(/'/g, "'\\''") + "'";
}
