import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Plan, Run } from "./types.ts";

/** Runs live on disk, not in the session, so a run survives a restart, a compaction, and a
 *  branch switch. The session only ever holds the run id. */

export function runsDir(cwd: string): string {
	return join(cwd, ".pi", "research");
}

export function newRunId(): string {
	return randomUUID().replace(/-/g, "").slice(0, 16);
}

/** Canonical hash of a plan: what approval names, so a plan cannot change between the render
 *  the user read and the keypress that approved it. */
export function hashPlan(plan: Plan): string {
	const canonical = JSON.stringify({
		title: plan.title,
		steps: plan.steps.map((step) => ({ title: step.title, query: step.query })),
	});
	return createHash("sha256").update(canonical).digest("hex");
}

export async function saveRun(cwd: string, run: Run): Promise<void> {
	const dir = runsDir(cwd);
	await mkdir(dir, { recursive: true });
	const target = join(dir, `${run.id}.json`);
	const temp = `${target}.${process.pid}.tmp`;
	// Write-then-rename: a crash mid-write leaves the previous run readable rather than a
	// half-written file that fails to parse on resume.
	await writeFile(temp, JSON.stringify({ ...run, updatedAt: Date.now() }, null, 2), "utf8");
	await rename(temp, target);
}

export async function loadRun(cwd: string, id: string): Promise<Run | null> {
	try {
		return JSON.parse(await readFile(join(runsDir(cwd), `${id}.json`), "utf8")) as Run;
	} catch {
		return null;
	}
}

export async function listRuns(cwd: string): Promise<Run[]> {
	let names: string[];
	try {
		names = await readdir(runsDir(cwd));
	} catch {
		return [];
	}
	const runs: Run[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const run = await loadRun(cwd, name.slice(0, -5));
		if (run) runs.push(run);
	}
	return runs.sort((a, b) => b.createdAt - a.createdAt);
}

export function setPlan(run: Run, plan: Plan): Run {
	run.plan = plan;
	run.planRevision += 1;
	run.planHash = hashPlan(plan);
	run.updatedAt = Date.now();
	return run;
}

/** Approval is refused unless it names the exact revision and hash that were on screen. */
export function canApprove(run: Run, revision: number, hash: string): boolean {
	return run.planRevision === revision && run.planHash === hash;
}
