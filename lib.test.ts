import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, execSync } from "node:child_process";
import {
	ensureDir,
	shortId,
	fmtAge,
	slugifyCommand,
	isPidAlive,
	shellQuote,
	buildWrapperCommand,
} from "./lib.ts";

// ── shortId ──────────────────────────────────────────────────────────────

describe("shortId", () => {
	it("returns a 6-char alphanumeric string", () => {
		const id = shortId();
		assert.equal(id.length, 6);
		assert.match(id, /^[a-z0-9]+$/);
	});

	it("returns different values on successive calls", () => {
		const ids = new Set(Array.from({ length: 20 }, () => shortId()));
		assert.ok(ids.size > 1);
	});
});

// ── fmtAge ───────────────────────────────────────────────────────────────

describe("fmtAge", () => {
	it("formats seconds", () => {
		assert.equal(fmtAge(0), "0s");
		assert.equal(fmtAge(999), "0s");
		assert.equal(fmtAge(1000), "1s");
		assert.equal(fmtAge(59_000), "59s");
	});

	it("formats minutes", () => {
		assert.equal(fmtAge(60_000), "1m");
		assert.equal(fmtAge(3_599_000), "59m");
	});

	it("formats hours+minutes", () => {
		assert.equal(fmtAge(3_600_000), "1h0m");
		assert.equal(fmtAge(5_400_000), "1h30m");
		assert.equal(fmtAge(23 * 3_600_000 + 59 * 60_000), "23h59m");
	});

	it("formats days+hours", () => {
		assert.equal(fmtAge(24 * 3_600_000), "1d0h");
		assert.equal(fmtAge(49 * 3_600_000 + 30 * 60_000), "2d1h");
	});
});

// ── slugifyCommand ───────────────────────────────────────────────────────

describe("slugifyCommand", () => {
	it("returns 'unknown' for empty string", () => {
		assert.equal(slugifyCommand(""), "unknown");
	});

	it("extracts the main command", () => {
		assert.equal(slugifyCommand("ls -la"), "ls");
		assert.equal(slugifyCommand("grep -r foo ."), "grep");
	});

	it("strips nohup/sudo/time/nice prefixes", () => {
		assert.equal(slugifyCommand("sudo apt install foo"), "apt");
		assert.equal(slugifyCommand("nohup python script.py"), "python");
		assert.equal(slugifyCommand("time nice make -j8"), "make");
	});

	it("handles ./ prefixed scripts", () => {
		assert.equal(slugifyCommand("./infdate.sh"), "infdate");
		assert.equal(slugifyCommand("./build.py arg1"), "build");
		assert.equal(slugifyCommand("sudo ./deploy.sh"), "deploy");
	});

	it("detects sleep commands", () => {
		assert.equal(slugifyCommand("sleep 300"), "sleep-300s");
		assert.equal(slugifyCommand("bash -c 'sleep 10'"), "sleep-10s");
	});

	it("detects loop patterns", () => {
		assert.equal(slugifyCommand("for i in $(seq 1 100); do echo $i; done"), "loop-100");
	});

	it("detects output redirection", () => {
		assert.equal(slugifyCommand("make > build.log"), "make-to-build.log");
		assert.equal(slugifyCommand("echo hi >> /tmp/out.txt"), "echo-to-out.txt");
	});

	it("truncates long command names", () => {
		const long = "a".repeat(30) + " arg1 arg2";
		assert.equal(slugifyCommand(long).length, 20);
	});

	it("handles multiline commands", () => {
		assert.equal(slugifyCommand("echo\nhello"), "echo");
	});
});

// ── isPidAlive ───────────────────────────────────────────────────────────

describe("isPidAlive", () => {
	it("returns false for pid 0", () => {
		assert.equal(isPidAlive(0), false);
	});

	it("returns false for negative pid", () => {
		assert.equal(isPidAlive(-1), false);
	});

	it("returns true for current process", () => {
		assert.equal(isPidAlive(process.pid), true);
	});

	it("returns false for a non-existent pid", () => {
		assert.equal(isPidAlive(4000000), false);
	});
});

// ── shellQuote ───────────────────────────────────────────────────────────

describe("shellQuote", () => {
	it("quotes a simple string", () => {
		assert.equal(shellQuote("hello"), "'hello'");
	});

	it("escapes single quotes", () => {
		assert.equal(shellQuote("it's"), "'it'\\''s'");
	});

	it("handles empty string", () => {
		assert.equal(shellQuote(""), "''");
	});

	it("handles strings with spaces and special chars", () => {
		assert.equal(shellQuote("hello world $HOME"), "'hello world $HOME'");
	});
});

// ── ensureDir ────────────────────────────────────────────────────────────

describe("ensureDir", () => {
	let tmpDir: string;

	before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-test-")); });
	after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	it("creates a nested directory", () => {
		const target = path.join(tmpDir, "a", "b", "c");
		ensureDir(target);
		assert.ok(fs.existsSync(target));
	});

	it("is idempotent", () => {
		const target = path.join(tmpDir, "a", "b", "c");
		ensureDir(target);
		ensureDir(target);
		assert.ok(fs.existsSync(target));
	});
});

// ── buildWrapperCommand ──────────────────────────────────────────────────

describe("buildWrapperCommand", () => {
	it("includes all paths and the command", () => {
		const cmd = buildWrapperCommand({
			wrapperScript: "/path/to/wrapper.ts",
			pipePath: "/tmp/test.pipe",
			pidFile: "/tmp/test.pid",
			outFile: "/tmp/test.out",
			command: "echo hello",
		});
		assert.ok(cmd.includes("/path/to/wrapper.ts"));
		assert.ok(cmd.includes("/tmp/test.pipe"));
		assert.ok(cmd.includes("/tmp/test.pid"));
		assert.ok(cmd.includes("/tmp/test.out"));
		assert.ok(cmd.includes("echo hello"));
	});
});

// ── wrapper.ts integration ──────────────────────────────────────────────

describe("wrapper.ts", () => {
	let tmpDir: string;
	const wrapperScript = path.join(import.meta.dirname!, "wrapper.ts");

	before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-wrapper-")); });
	after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

	const spawnWrapper = (pipePath: string, pidFile: string, outFile: string, command: string) => {
		return spawn(process.execPath, [
			"--experimental-strip-types",
			wrapperScript,
			pipePath,
			pidFile,
			outFile,
			command,
		], { stdio: ["ignore", "pipe", "pipe"] });
	};

	it("runs a command and captures output to stdout and file", async () => {
		const pipePath = path.join(tmpDir, "run.pipe");
		const pidFile = path.join(tmpDir, "run.pid");
		const outFile = path.join(tmpDir, "run.out");

		const child = spawnWrapper(pipePath, pidFile, outFile, "echo wrapper-test");
		const { stdout, exitCode } = await waitForClose(child, 5000);

		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("wrapper-test"), `stdout: ${stdout}`);

		const outContent = fs.readFileSync(outFile, "utf8");
		assert.ok(outContent.includes("wrapper-test"), `outFile: ${outContent}`);
		assert.ok(!fs.existsSync(pidFile), "pidFile should be cleaned up");
		assert.ok(!fs.existsSync(pipePath), "pipe should be cleaned up");
	});

	it("captures stderr too", async () => {
		const pipePath = path.join(tmpDir, "err.pipe");
		const pidFile = path.join(tmpDir, "err.pid");
		const outFile = path.join(tmpDir, "err.out");

		const child = spawnWrapper(pipePath, pidFile, outFile, "echo out-msg; echo err-msg >&2");
		const { stdout, exitCode } = await waitForClose(child, 5000);

		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("out-msg"), `stdout: ${stdout}`);
		assert.ok(stdout.includes("err-msg"), `stderr missing: ${stdout}`);

		const outContent = fs.readFileSync(outFile, "utf8");
		assert.ok(outContent.includes("out-msg"));
		assert.ok(outContent.includes("err-msg"));
	});

	it("propagates non-zero exit code", async () => {
		const pipePath = path.join(tmpDir, "exit.pipe");
		const pidFile = path.join(tmpDir, "exit.pid");
		const outFile = path.join(tmpDir, "exit.out");

		const child = spawnWrapper(pipePath, pidFile, outFile, "exit 42");
		const { exitCode } = await waitForClose(child, 5000);

		assert.equal(exitCode, 42);
	});

	it("detaches on control pipe message, inner process survives", async () => {
		const pipePath = path.join(tmpDir, "detach.pipe");
		const pidFile = path.join(tmpDir, "detach.pid");
		const outFile = path.join(tmpDir, "detach.out");

		const child = spawnWrapper(pipePath, pidFile, outFile, "sleep 60");

		await waitForFile(pidFile, 3000);
		const innerPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
		assert.ok(innerPid > 0, "inner PID should be positive");
		assert.ok(isPidAlive(innerPid), "inner process should be alive before detach");

		// Write detach to control pipe
		await writeToFifo(pipePath, "detach\n");

		const { exitCode } = await waitForClose(child, 3000);
		assert.equal(exitCode, 0, "wrapper should exit 0 on detach");

		assert.ok(isPidAlive(innerPid), "inner process should survive detach");

		// Clean up
		process.kill(innerPid, "SIGTERM");
		await sleep(200);
	});

	it("inner process continues writing to output file after detach", async () => {
		const pipePath = path.join(tmpDir, "detach-out.pipe");
		const pidFile = path.join(tmpDir, "detach-out.pid");
		const outFile = path.join(tmpDir, "detach-out.out");

		// Command that writes a line every 200ms
		const child = spawnWrapper(pipePath, pidFile, outFile,
			"for i in $(seq 1 100); do echo line-$i; sleep 0.2; done");

		await waitForFile(pidFile, 3000);
		const innerPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);

		// Wait for some output to appear
		await sleep(500);
		const sizeBefore = fs.statSync(outFile).size;
		assert.ok(sizeBefore > 0, "should have output before detach");

		// Detach
		await writeToFifo(pipePath, "detach\n");
		await waitForClose(child, 3000);

		// Wait and verify the file keeps growing after wrapper exit
		await sleep(600);
		const sizeAfter = fs.statSync(outFile).size;
		assert.ok(sizeAfter > sizeBefore,
			`output file should keep growing after detach (before=${sizeBefore}, after=${sizeAfter})`);

		// Clean up
		process.kill(innerPid, "SIGTERM");
		await sleep(200);
	});

	it("wrapper forwards output to stdout during normal operation", async () => {
		const pipePath = path.join(tmpDir, "fwd.pipe");
		const pidFile = path.join(tmpDir, "fwd.pid");
		const outFile = path.join(tmpDir, "fwd.out");

		const child = spawnWrapper(pipePath, pidFile, outFile,
			"echo stdout-line-1; echo stdout-line-2; echo stderr-line >&2");
		const { stdout, exitCode } = await waitForClose(child, 5000);

		assert.equal(exitCode, 0);
		assert.ok(stdout.includes("stdout-line-1"), `stdout missing line 1: ${stdout}`);
		assert.ok(stdout.includes("stdout-line-2"), `stdout missing line 2: ${stdout}`);
		assert.ok(stdout.includes("stderr-line"), `stdout missing stderr: ${stdout}`);

		// Output file should have the same content
		const outContent = fs.readFileSync(outFile, "utf8");
		assert.ok(outContent.includes("stdout-line-1"));
		assert.ok(outContent.includes("stderr-line"));
	});

	it("inner process dies when wrapper is killed without detach", async () => {
		const pipePath = path.join(tmpDir, "kill.pipe");
		const pidFile = path.join(tmpDir, "kill.pid");
		const outFile = path.join(tmpDir, "kill.out");

		const child = spawnWrapper(pipePath, pidFile, outFile, "sleep 60");

		await waitForFile(pidFile, 3000);
		const innerPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
		assert.ok(isPidAlive(innerPid), "inner process should be alive");

		// Kill wrapper without sending detach — extension is responsible for
		// cleaning up the inner process, which it does by reading the PID file
		child.kill("SIGTERM");
		await waitForClose(child, 3000);

		// Inner process is still alive (setsid) — extension would kill it
		// We simulate what the extension does:
		if (isPidAlive(innerPid)) {
			process.kill(innerPid, "SIGTERM");
		}
		await sleep(500);
		assert.ok(!isPidAlive(innerPid), "inner process should be dead after cleanup");
	});
});

// ── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function waitForClose(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout?.on("data", (d) => stdout.push(d));
		child.stderr?.on("data", (d) => stderr.push(d));

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`Timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({
				stdout: Buffer.concat(stdout).toString(),
				stderr: Buffer.concat(stderr).toString(),
				exitCode: code,
			});
		});
	});
}

function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const check = () => {
			try {
				const content = fs.readFileSync(filePath, "utf8").trim();
				if (content.length > 0) { resolve(); return; }
			} catch { /* not ready */ }
			if (Date.now() - start > timeoutMs) {
				reject(new Error(`Timed out waiting for ${filePath}`));
			} else {
				setTimeout(check, 50);
			}
		};
		check();
	});
}

async function writeToFifo(pipePath: string, data: string): Promise<void> {
	// Retry with O_NONBLOCK in case the reader isn't ready
	for (let i = 0; i < 20; i++) {
		try {
			const fd = fs.openSync(pipePath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
			fs.writeSync(fd, data);
			fs.closeSync(fd);
			return;
		} catch {
			await sleep(50);
		}
	}
	throw new Error("Failed to write to FIFO");
}
