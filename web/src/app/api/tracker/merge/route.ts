import { execFile, type ExecFileException } from "node:child_process";
import path from "node:path";
import { careerOpsCodeRoot, careerOpsRoot, rootScript } from "@/lib/career-ops";
import { isTrackerWriting } from "@/lib/core/run-registry";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let merging = false;

function trackerNumber(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

type MergeResult = { kept: string; merged: string[]; backup: string | null; changed: boolean };

function resultMatches(value: unknown, keep: string, nums: string[]): value is MergeResult {
  if (value === null || typeof value !== "object") return false;
  const result = value as Partial<MergeResult>;
  return result.kept === keep && typeof result.changed === "boolean"
    && (result.backup === null || typeof result.backup === "string")
    && Array.isArray(result.merged) && new Set(result.merged).size === result.merged.length
    && result.merged.every((n) => typeof n === "string" && n !== keep && nums.includes(n))
    && (!result.changed || result.merged.length === nums.length - 1);
}

export async function POST(req: Request) {
  const body = await readJsonObject<{ keep?: unknown; nums?: unknown; dryRun?: unknown }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const keep = trackerNumber(body.keep);
  const nums = Array.isArray(body.nums) ? body.nums.map(trackerNumber) : [];
  if (!keep || nums.length < 2 || nums.length > 100 || nums.some((n) => n === null)
    || new Set(nums).size !== nums.length || !nums.includes(keep)
    || (body.dryRun !== undefined && typeof body.dryRun !== "boolean")) {
    return Response.json({ error: "Choose 2–100 distinct numeric tracker rows and one row to keep." }, { status: 400 });
  }
  if (isTrackerWriting() || merging) {
    return Response.json({ error: "Your tracker is being updated — try again in a moment." }, { status: 409 });
  }

  const dryRun = body.dryRun === true;
  merging = true;
  try {
    const dataRoot = careerOpsRoot();
    const env: NodeJS.ProcessEnv = { ...process.env, CAREER_OPS_ROOT: dataRoot };
    // EVIDENCE: AGENTS.md defines relative overrides from the repository root.
    // The child runs in the data root, so pass an absolute override.
    if (env.CAREER_OPS_TRACKER?.trim()) {
      env.CAREER_OPS_TRACKER = path.resolve(careerOpsCodeRoot(), env.CAREER_OPS_TRACKER.trim());
    }
    const args = [rootScript("merge-listings"), "--keep", keep, "--nums", nums.join(",")];
    if (dryRun) args.push("--dry-run");

    // The core owns validation, backup, locking and the atomic tracker write.
    const execution = await new Promise<{ error: ExecFileException | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, args, {
        cwd: dataRoot, env, windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    if (execution.error) {
      const message = execution.stderr.trim().split("\n")[0] || execution.error.message || "Merge failed.";
      const status = execution.error.killed ? 504 : /(?:locked|lock timeout|tracker.*busy)/i.test(message) ? 409 : 400;
      return Response.json({ error: message }, { status });
    }

    let result: unknown;
    try {
      result = JSON.parse(execution.stdout);
    } catch {
      return Response.json({ error: "The merge command returned an invalid result. Refresh the pipeline before retrying." }, { status: 502 });
    }
    if (!resultMatches(result, keep, nums as string[])) {
      return Response.json({ error: "The merge command returned an unexpected result. Refresh the pipeline before retrying." }, { status: 502 });
    }
    return Response.json({ ok: true, kept: result.kept, merged: result.merged, backup: result.backup, changed: result.changed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not start the merge command." }, { status: 500 });
  } finally {
    merging = false;
  }
}
