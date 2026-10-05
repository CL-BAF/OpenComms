#!/usr/bin/env node
/** Read-only, opt-in comparison of real task outcomes; never launches agents. */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const terminal = new Set(["verified_complete", "failed", "cancelled"])
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const boundedText = (value, max = 200) => typeof value === "string" && value.trim() && value.length <= max

export async function evaluateCoordination(manifest, getTask) {
  if (manifest?.version !== 1 || !boundedText(manifest.build_version) || !boundedText(manifest.tested_revision))
    throw new Error(
      "Manifest requires version:1, build_version and tested_revision (use source-archive if no Git revision is available).",
    )
  if (!Array.isArray(manifest.cases) || !manifest.cases.length || manifest.cases.length > 16)
    throw new Error("Provide 1–16 identical representative cases for all cohorts.")
  const cases = new Map()
  for (const benchmark of manifest.cases) {
    if (
      !boundedText(benchmark.id) ||
      cases.has(benchmark.id) ||
      !boundedText(benchmark.prompt, 90_000) ||
      !Array.isArray(benchmark.acceptance_criteria) ||
      !benchmark.acceptance_criteria.length ||
      !benchmark.acceptance_criteria.every((c) => boundedText(c, 2_000))
    )
      throw new Error("Each case requires a unique id, exact task prompt and nonempty acceptance criteria.")
    cases.set(benchmark.id, benchmark)
  }
  if (!Array.isArray(manifest.cohorts) || manifest.cohorts.length !== 3)
    throw new Error("Provide exactly solo, mixed and eight cohorts.")
  const names = new Set()
  const taskIds = new Set()
  const cohorts = []
  for (const cohort of manifest.cohorts) {
    if (
      !["solo", "mixed", "eight"].includes(cohort.name) ||
      names.has(cohort.name) ||
      !Array.isArray(cohort.agent_ids) ||
      new Set(cohort.agent_ids).size !== cohort.agent_ids.length ||
      !cohort.agent_ids.every((id) => /^agt_[0-9a-f]{24}$/.test(id))
    )
      throw new Error("Cohorts require unique solo/mixed/eight names and explicit distinct managed agent ids.")
    names.add(cohort.name)
    const size = cohort.agent_ids.length
    if (
      (cohort.name === "solo" && size !== 1) ||
      (cohort.name === "mixed" && (size < 2 || size > 4)) ||
      (cohort.name === "eight" && (size < 5 || size > 8))
    )
      throw new Error("Use 1 agent for solo, 2–4 for mixed, and 5–8 for eight.")
    if (
      !Array.isArray(cohort.hosts) ||
      cohort.hosts.length !== size ||
      !cohort.hosts.every((h) => boundedText(h)) ||
      !Array.isArray(cohort.host_versions) ||
      cohort.host_versions.length !== size ||
      !cohort.host_versions.every((h) => boundedText(h))
    )
      throw new Error("Record one actual host and host version (or explicitly unknown) per participant.")
    if (cohort.name === "mixed" && new Set(cohort.hosts).size < 2)
      throw new Error("The mixed cohort must use at least two actual integration hosts.")
    if (
      !Array.isArray(cohort.runs) ||
      cohort.runs.length !== cases.size ||
      new Set(cohort.runs.map((r) => r.case_id)).size !== cases.size
    )
      throw new Error("Every cohort must record one actual run of each identical case.")
    const runs = []
    for (const run of cohort.runs) {
      const benchmark = cases.get(run.case_id)
      if (
        !benchmark ||
        !/^tsk_[0-9a-f]{24}$/.test(run.task_id) ||
        taskIds.has(run.task_id) ||
        !Number.isInteger(run.human_interventions) ||
        run.human_interventions < 0
      )
        throw new Error(
          "Runs require the known case id, distinct durable task id and recorded human intervention count.",
        )
      taskIds.add(run.task_id)
      const task = await getTask(run.task_id)
      if (!task || task.task_id !== run.task_id || !cohort.agent_ids.includes(task.owner))
        throw new Error(`Task ${run.task_id} is not owned by a declared cohort participant.`)
      const criteriaMatch =
        JSON.stringify([...task.acceptance_criteria].sort()) ===
        JSON.stringify([...benchmark.acceptance_criteria].sort())
      if (task.body !== benchmark.prompt || !criteriaMatch)
        throw new Error(`Task ${run.task_id} differs from the shared benchmark prompt or acceptance criteria.`)
      const verified =
        task.execution_state === "verified_complete" &&
        task.review?.outcome === "accepted" &&
        task.review.reviewer !== task.owner &&
        benchmark.acceptance_criteria.every((criterion) =>
          task.evidence.some(
            (e) =>
              e.criterion === criterion &&
              e.passed === true &&
              e.kind !== "artifact" &&
              boundedText(e.reference, 4_000),
          ),
        ) &&
        !task.evidence.some((e) => e.passed === false && benchmark.acceptance_criteria.includes(e.criterion))
      let usage = null
      if (run.usage !== undefined) {
        if (
          run.usage.source !== "host_telemetry" ||
          !boundedText(run.usage.reference, 4_000) ||
          (run.usage.tokens !== undefined && !finite(run.usage.tokens)) ||
          (run.usage.cost !== undefined && !finite(run.usage.cost))
        )
          throw new Error(
            "Usage is optional and must identify a real host_telemetry reference; estimates are excluded.",
          )
        usage = {
          source: "host_telemetry",
          reference: run.usage.reference,
          tokens: run.usage.tokens ?? null,
          cost: run.usage.cost ?? null,
          currency: run.usage.currency ?? null,
        }
      }
      runs.push({
        case_id: run.case_id,
        task_id: run.task_id,
        execution_state: task.execution_state,
        verified,
        terminal: terminal.has(task.execution_state),
        failed: task.execution_state === "failed",
        cancelled: task.execution_state === "cancelled",
        human_interventions: run.human_interventions,
        elapsed_ms:
          finite(task.assigned_at) && finite(task.updated_at) ? Math.max(0, task.updated_at - task.assigned_at) : null,
        elapsed_basis: "durable assignment to last recorded execution transition",
        review_rounds: task.review_rounds,
        evidence_references: task.evidence.filter((e) => e.passed).map((e) => e.reference),
        usage,
      })
    }
    cohorts.push({
      name: cohort.name,
      participant_count: size,
      hosts: cohort.hosts,
      host_versions: cohort.host_versions,
      verified_cases: runs.filter((r) => r.verified).length,
      total_cases: runs.length,
      failures: runs.filter((r) => r.failed).length,
      unfinished: runs.filter((r) => !r.terminal).length,
      human_interventions: runs.reduce((sum, r) => sum + r.human_interventions, 0),
      elapsed_ms: runs.reduce((sum, r) => sum + (r.elapsed_ms ?? 0), 0),
      runs,
    })
  }
  return {
    evaluation_schema_version: 1,
    build_version: manifest.build_version,
    tested_revision: manifest.tested_revision,
    recorded_at: new Date().toISOString(),
    verification_basis: "durable task state plus acceptance evidence and independent accepted review",
    participant_visibility:
      "Declared participants and host versions; task ownership proves the lead endpoint only, not every participant's contribution.",
    cohorts,
  }
}

async function main(argv) {
  const arg = (name) => {
    const index = argv.indexOf(name)
    return index < 0 ? undefined : argv[index + 1]
  }
  if (argv.includes("--help") || !argv.includes("--allow-evaluation")) {
    console.log(
      "Usage: node scripts/evaluate-coordination.mjs --allow-evaluation --manifest <runs.json> --output <report.json> [--base http://127.0.0.1:4919]\nReads real recorded tasks; does not launch agents, create tasks or fabricate live verification. See docs/TASK_EXECUTION.md.",
    )
    return argv.includes("--help") ? 0 : 2
  }
  if (!arg("--manifest") || !arg("--output")) throw new Error("--manifest and --output are required.")
  const base = new URL(arg("--base") ?? "http://127.0.0.1:4919")
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password
  )
    throw new Error(
      "Evaluation reads the authenticated local coordinator only; a public or credential-bearing URL is refused.",
    )
  const manifest = JSON.parse(readFileSync(resolve(arg("--manifest")), "utf8"))
  const result = await evaluateCoordination(manifest, async (taskId) => {
    const response = await fetch(new URL(`/api/orchestrator/tasks/${taskId}`, base), {
      signal: AbortSignal.timeout(10_000),
    })
    const payload = await response.json()
    if (!response.ok || !payload.ok)
      throw new Error(
        `Task ${taskId} unavailable (HTTP ${response.status}); check the selected project and coordinator.`,
      )
    return payload.data.task
  })
  writeFileSync(resolve(arg("--output")), JSON.stringify(result, null, 2) + "\n", "utf8")
  for (const cohort of result.cohorts)
    console.log(
      `${cohort.name}: ${cohort.verified_cases}/${cohort.total_cases} verified; ${cohort.failures} failed; ${cohort.unfinished} unfinished; ${cohort.human_interventions} recorded human interventions`,
    )
  return result.cohorts.every((c) => c.verified_cases === c.total_cases) ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 2
    })
}
