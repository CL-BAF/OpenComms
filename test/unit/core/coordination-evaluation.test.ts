import { test } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

interface CohortReport {
  name: string
  verified_cases: number
  failures: number
  unfinished: number
  human_interventions: number
  runs: Array<{ verified: boolean; usage: unknown }>
}
interface EvaluationModule {
  evaluateCoordination(
    manifest: unknown,
    getTask: (id: string) => Promise<unknown>,
  ): Promise<{ cohorts: CohortReport[] }>
}
const scriptUrl = pathToFileURL(join(process.cwd(), "scripts", "evaluate-coordination.mjs")).href
const evaluator = import(scriptUrl) as Promise<EvaluationModule>

function recordedRuns() {
  const identifier = (prefix: string, n: number) => `${prefix}_${n.toString(16).padStart(24, "0")}`
  const prompt = "Target the nearest hostile entity"
  const criterion = "Attack targets the nearest hostile entity"
  const cohorts = [
    {
      name: "solo",
      agent_ids: [identifier("agt", 1)],
      hosts: ["opencode"],
      host_versions: ["unknown"],
      runs: [{ case_id: "combat", task_id: identifier("tsk", 1), human_interventions: 1 }],
    },
    {
      name: "mixed",
      agent_ids: [identifier("agt", 2), identifier("agt", 3)],
      hosts: ["opencode", "codex"],
      host_versions: ["unknown", "unknown"],
      runs: [{ case_id: "combat", task_id: identifier("tsk", 2), human_interventions: 2 }],
    },
    {
      name: "eight",
      agent_ids: [4, 5, 6, 7, 8, 9, 10, 11].map((i) => identifier("agt", i)),
      hosts: Array<string>(8).fill("opencode"),
      host_versions: Array<string>(8).fill("unknown"),
      runs: [{ case_id: "combat", task_id: identifier("tsk", 3), human_interventions: 3 }],
    },
  ]
  const tasks = new Map(
    cohorts.map((cohort) => [
      cohort.runs[0]!.task_id,
      {
        task_id: cohort.runs[0]!.task_id,
        owner: cohort.agent_ids[0],
        body: prompt,
        acceptance_criteria: [criterion],
        execution_state: "verified_complete",
        review: { outcome: "accepted", reviewer: "operator" },
        evidence: [{ criterion, kind: "behavior", reference: "checks/combat.log", passed: true }],
        assigned_at: 10,
        updated_at: 110,
        review_rounds: 1,
      },
    ]),
  )
  return {
    manifest: {
      version: 1,
      build_version: "test-only",
      tested_revision: "algorithm-fixture",
      cases: [{ id: "combat", prompt, acceptance_criteria: [criterion] }],
      cohorts,
    },
    tasks,
    getTask: async (id: string) => tasks.get(id),
  }
}

test("evaluation consumes identical recorded tasks, counts verified outcomes and preserves unknown usage", async () => {
  const input = recordedRuns()
  const result = await (await evaluator).evaluateCoordination(input.manifest, input.getTask)
  assert.deepEqual(
    result.cohorts.map((c) => c.verified_cases),
    [1, 1, 1],
  )
  assert.deepEqual(
    result.cohorts.map((c) => c.human_interventions),
    [1, 2, 3],
  )
  assert.ok(result.cohorts.every((c) => c.runs[0]?.usage === null))
})

test("evaluation refuses mismatched work, duplicate outcomes and fabricated estimates", async () => {
  const module = await evaluator
  const mismatch = recordedRuns()
  mismatch.tasks.get(mismatch.manifest.cohorts[1]!.runs[0]!.task_id)!.body = "Only compile the project"
  await assert.rejects(
    module.evaluateCoordination(mismatch.manifest, mismatch.getTask),
    /differs from the shared benchmark/,
  )
  const reused = recordedRuns()
  reused.manifest.cohorts[1]!.runs[0]!.task_id = reused.manifest.cohorts[0]!.runs[0]!.task_id
  await assert.rejects(module.evaluateCoordination(reused.manifest, reused.getTask), /distinct durable task id/)
  const estimated = recordedRuns()
  Object.assign(estimated.manifest.cohorts[0]!.runs[0]!, {
    usage: { source: "estimate", tokens: 123, reference: "guess" },
  })
  await assert.rejects(module.evaluateCoordination(estimated.manifest, estimated.getTask), /estimates are excluded/)
})

test("evaluation treats acknowledgement, failed work and unsupported acceptance evidence honestly", async () => {
  const input = recordedRuns()
  const first = input.tasks.get(input.manifest.cohorts[0]!.runs[0]!.task_id)!
  first.execution_state = "assigned"
  const second = input.tasks.get(input.manifest.cohorts[1]!.runs[0]!.task_id)!
  second.execution_state = "failed"
  const third = input.tasks.get(input.manifest.cohorts[2]!.runs[0]!.task_id)!
  third.evidence[0]!.kind = "artifact"
  const result = await (await evaluator).evaluateCoordination(input.manifest, input.getTask)
  assert.deepEqual(
    result.cohorts.map((c) => c.verified_cases),
    [0, 0, 0],
  )
  assert.equal(result.cohorts[0]?.unfinished, 1)
  assert.equal(result.cohorts[1]?.failures, 1)
  assert.equal(result.cohorts[2]?.runs[0]?.verified, false)
})
