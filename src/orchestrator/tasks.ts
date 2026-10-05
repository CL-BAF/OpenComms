/** Durable task execution and compact project context, held in orchestrator.json. */
import { randomBytes } from "node:crypto"

export const TASK_SCHEMA_VERSION = 1
export const MAX_TASKS = 2_000
export const MAX_CONTEXT_RECORDS = 500
export const MAX_TASK_REASSIGNMENTS = 16
export const EXECUTION_STATES = [
  "ready",
  "assigned",
  "running",
  "blocked",
  "review",
  "verified_complete",
  "failed",
  "cancelled",
] as const
export type ExecutionState = (typeof EXECUTION_STATES)[number]
export type TaskDeliveryState = "unknown" | "queued" | "in_flight" | "delivered" | "acknowledged" | "failed" | "stale"
export interface VerificationEvidence {
  criterion: string
  kind: "check" | "artifact" | "behavior" | "review"
  reference: string
  summary: string
  passed: boolean
}
export interface TaskReview {
  outcome: "accepted" | "changes_requested"
  reviewer: string
  summary: string
}
export interface TaskReassignment {
  request_id: string
  request_fingerprint: string
  from_owner: string | null
  from_recipient_session_id: string
  from_channel: string
  from_message_id: string | null
  from_execution_state: ExecutionState
  from_review: TaskReview | null
  from_blocker: string | null
  to_owner: string
  to_recipient_session_id: string
  to_channel: string
  reason: string
  handoff_confirmed: boolean
  at: number
  dispatch_state: "dispatching" | "sent" | "failed"
  message_id: string | null
  blocker: string | null
}
export interface TaskRecord {
  task_id: string
  agent_id: string | null
  owner: string | null
  recipient_session_id: string
  channel: string
  title: string
  body: string
  scope: string
  dependencies: string[]
  acceptance_criteria: string[]
  ownership: string[]
  ownership_mode: "advisory"
  execution_state: ExecutionState
  delivery_state: TaskDeliveryState
  acknowledged_at: number | null
  dispatch_state: "dispatching" | "sent" | "failed" | "legacy"
  blocker: string | null
  message_id: string | null
  related_message_ids: string[]
  artifacts: string[]
  evidence: VerificationEvidence[]
  review: TaskReview | null
  review_rounds: number
  max_review_rounds: number
  assigned_at: number
  updated_at: number
  revision: number
  request_id: string | null
  request_fingerprint: string | null
  legacy: boolean
  reassignments?: TaskReassignment[]
}
export interface TaskMessage {
  message_id: string
  channel_id: string
  sender_session_id: string
  recipient_session_id: string
  timestamp: number
  message_type: string
  content: string
  hop_count: number
  correlation_id: string
  delivery_status: string
}
export interface ProjectContextRecord {
  id: string
  kind: "proposal" | "decision" | "constraint" | "finding" | "question" | "rejected"
  status: "proposed" | "accepted" | "verified" | "open" | "rejected"
  title: string
  body: string
  references: string[]
  created_at: number
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max
}
export function stringList(value: unknown, maxItems = 64, maxLength = 2_000): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((v) => text(v, maxLength))
}
export function validEvidence(value: unknown): value is VerificationEvidence {
  return (
    record(value) &&
    text(value["criterion"], 2_000) &&
    ["check", "artifact", "behavior", "review"].includes(String(value["kind"])) &&
    text(value["reference"], 4_000) &&
    text(value["summary"], 4_000) &&
    typeof value["passed"] === "boolean"
  )
}
export function validReview(value: unknown): value is TaskReview {
  return (
    record(value) &&
    ["accepted", "changes_requested"].includes(String(value["outcome"])) &&
    text(value["reviewer"], 200) &&
    text(value["summary"], 4_000)
  )
}
export function validReassignment(value: unknown): value is TaskReassignment {
  return (
    record(value) &&
    typeof value["request_id"] === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(value["request_id"]) &&
    typeof value["request_fingerprint"] === "string" &&
    /^[0-9a-f]{64}$/.test(value["request_fingerprint"]) &&
    (value["from_owner"] === null || text(value["from_owner"], 100)) &&
    typeof value["from_recipient_session_id"] === "string" &&
    text(value["from_channel"], 200) &&
    (value["from_message_id"] === null || text(value["from_message_id"], 200)) &&
    EXECUTION_STATES.includes(value["from_execution_state"] as ExecutionState) &&
    (value["from_review"] === null || validReview(value["from_review"])) &&
    (value["from_blocker"] === null || text(value["from_blocker"], 4_000)) &&
    text(value["to_owner"], 100) &&
    text(value["to_recipient_session_id"], 200) &&
    text(value["to_channel"], 200) &&
    text(value["reason"], 4_000) &&
    typeof value["handoff_confirmed"] === "boolean" &&
    Number.isFinite(value["at"]) &&
    ["dispatching", "sent", "failed"].includes(String(value["dispatch_state"])) &&
    (value["message_id"] === null || text(value["message_id"], 200)) &&
    (value["blocker"] === null || text(value["blocker"], 4_000))
  )
}
export function validTask(value: unknown): value is TaskRecord {
  if (!record(value)) return false
  const shape =
    typeof value["task_id"] === "string" &&
    /^tsk_[0-9a-f]{24}$/.test(value["task_id"]) &&
    (value["agent_id"] === null || text(value["agent_id"], 100)) &&
    (value["owner"] === null || text(value["owner"], 100)) &&
    typeof value["recipient_session_id"] === "string" &&
    text(value["channel"], 200) &&
    text(value["title"], 200) &&
    typeof value["body"] === "string" &&
    value["body"].length <= 90_000 &&
    typeof value["scope"] === "string" &&
    value["scope"].length <= 4_000 &&
    stringList(value["dependencies"]) &&
    stringList(value["acceptance_criteria"]) &&
    stringList(value["ownership"]) &&
    value["ownership_mode"] === "advisory" &&
    EXECUTION_STATES.includes(value["execution_state"] as ExecutionState) &&
    ["unknown", "queued", "in_flight", "delivered", "acknowledged", "failed", "stale"].includes(
      String(value["delivery_state"]),
    ) &&
    (value["acknowledged_at"] === null || Number.isFinite(value["acknowledged_at"])) &&
    ["dispatching", "sent", "failed", "legacy"].includes(String(value["dispatch_state"])) &&
    (value["blocker"] === null || text(value["blocker"], 4_000)) &&
    (value["message_id"] === null || text(value["message_id"], 200)) &&
    stringList(value["related_message_ids"], 256, 200) &&
    stringList(value["artifacts"], 64, 4_000) &&
    Array.isArray(value["evidence"]) &&
    value["evidence"].length <= 128 &&
    value["evidence"].every(validEvidence) &&
    (value["review"] === null || validReview(value["review"])) &&
    Number.isInteger(value["revision"]) &&
    Number(value["revision"]) >= 1 &&
    Number.isInteger(value["review_rounds"]) &&
    Number(value["review_rounds"]) >= 0 &&
    Number.isInteger(value["max_review_rounds"]) &&
    Number(value["max_review_rounds"]) >= 1 &&
    Number(value["max_review_rounds"]) <= 20 &&
    Number.isFinite(value["assigned_at"]) &&
    Number.isFinite(value["updated_at"]) &&
    (value["request_id"] === null || text(value["request_id"], 128)) &&
    (value["request_fingerprint"] === null || text(value["request_fingerprint"], 64)) &&
    typeof value["legacy"] === "boolean" &&
    (value["reassignments"] === undefined ||
      (Array.isArray(value["reassignments"]) &&
        value["reassignments"].length <= MAX_TASK_REASSIGNMENTS &&
        value["reassignments"].every(validReassignment)))
  if (!shape) return false
  if (value["execution_state"] !== "verified_complete") return true
  const task = value as unknown as TaskRecord
  return (
    task.acceptance_criteria.length > 0 &&
    task.review?.outcome === "accepted" &&
    task.review.reviewer !== task.owner &&
    task.acceptance_criteria.every((criterion) =>
      task.evidence.some((e) => e.criterion === criterion && e.passed && e.kind !== "artifact"),
    ) &&
    !task.evidence.some((e) => !e.passed && task.acceptance_criteria.includes(e.criterion))
  )
}
const contextStatuses: Record<ProjectContextRecord["kind"], ProjectContextRecord["status"][]> = {
  proposal: ["proposed"],
  decision: ["accepted"],
  constraint: ["accepted"],
  finding: ["verified"],
  question: ["open"],
  rejected: ["rejected"],
}
export function validContext(value: unknown): value is ProjectContextRecord {
  if (!record(value)) return false
  const statuses = contextStatuses[value["kind"] as ProjectContextRecord["kind"]]
  return (
    typeof value["id"] === "string" &&
    /^ctx_[0-9a-f]{24}$/.test(value["id"]) &&
    Array.isArray(statuses) &&
    statuses.includes(value["status"] as ProjectContextRecord["status"]) &&
    text(value["title"], 200) &&
    text(value["body"], 8_000) &&
    stringList(value["references"], 32, 4_000) &&
    (value["status"] !== "verified" || (value["references"] as string[]).length > 0) &&
    Number.isFinite(value["created_at"])
  )
}
export function newContextId(): string {
  return `ctx_${randomBytes(12).toString("hex")}`
}

/** Legacy acknowledgement carries no evidence about execution. Never mark it complete. */
export function taskViews(
  stored: readonly TaskRecord[],
  messages: Record<string, TaskMessage>,
  agents: readonly { id: string; host_session_id: string | null }[],
): TaskRecord[] {
  const tasks = stored.map((t) => structuredClone(t))
  const byId = new Map(tasks.map((t) => [t.task_id, t]))
  const envelopes = Object.values(messages)
  for (const msg of envelopes) {
    if (msg.message_type !== "review_request") continue
    const taskId = /\[task (tsk_[0-9a-f]{24})\]\s*$/.exec(msg.content)?.[1]
    if (!taskId) continue
    let task = byId.get(taskId)
    if (!task) {
      const owner = agents.find((a) => a.host_session_id === msg.recipient_session_id)?.id ?? null
      task = {
        task_id: taskId,
        agent_id: owner,
        owner,
        recipient_session_id: msg.recipient_session_id,
        channel: msg.channel_id,
        title: msg.content.split("\n")[0]?.slice(0, 200) || "Legacy assignment",
        body: msg.content.replace(/\n*\[task tsk_[0-9a-f]{24}\]\s*$/, "").slice(0, 90_000),
        scope: "",
        dependencies: [],
        acceptance_criteria: [],
        ownership: [],
        ownership_mode: "advisory",
        execution_state: "assigned",
        delivery_state: "unknown",
        acknowledged_at: null,
        dispatch_state: "legacy",
        blocker: null,
        message_id: msg.message_id,
        related_message_ids: [],
        artifacts: [],
        evidence: [],
        review: null,
        review_rounds: 0,
        max_review_rounds: 3,
        assigned_at: msg.timestamp,
        updated_at: msg.timestamp,
        revision: 1,
        request_id: null,
        request_fingerprint: null,
        legacy: true,
      }
      tasks.push(task)
      byId.set(taskId, task)
    }
    // A marker cannot replace the durable recipient/owner of a task.
    if (task.recipient_session_id && task.recipient_session_id !== msg.recipient_session_id) continue
    if (task.message_id && task.message_id !== msg.message_id) continue
    task.message_id = msg.message_id
    if (task.dispatch_state === "dispatching") {
      task.dispatch_state = "sent"
      if (task.execution_state === "ready") task.execution_state = "assigned"
    }
    const handoff = task.reassignments?.find(
      (r) => r.message_id === msg.message_id && r.dispatch_state === "dispatching",
    )
    if (handoff) {
      handoff.dispatch_state = "sent"
      task.blocker = null
    }
    const replies = envelopes.filter(
      (m) =>
        m.channel_id === msg.channel_id &&
        m.correlation_id === msg.correlation_id &&
        m.sender_session_id === msg.recipient_session_id &&
        m.timestamp >= msg.timestamp &&
        (m.message_type === "review_response" || m.hop_count > 0),
    )
    task.related_message_ids = [
      ...new Set([...task.related_message_ids, msg.message_id, ...replies.map((m) => m.message_id)]),
    ].slice(-256)
    if (replies.length) task.acknowledged_at ??= replies[0]!.timestamp
    task.delivery_state =
      task.acknowledged_at !== null
        ? "acknowledged"
        : msg.delivery_status === "delivered"
          ? "delivered"
          : msg.delivery_status === "in_flight"
            ? "in_flight"
            : msg.delivery_status === "failed" || msg.delivery_status === "rejected"
              ? "failed"
              : msg.delivery_status === "stale"
                ? "stale"
                : "queued"
  }
  return tasks.sort((a, b) => b.assigned_at - a.assigned_at)
}

const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  ready: ["assigned", "cancelled"],
  assigned: ["running", "blocked", "failed", "cancelled"],
  running: ["blocked", "review", "failed", "cancelled"],
  blocked: ["running", "failed", "cancelled"],
  review: ["running", "verified_complete", "failed", "cancelled"],
  verified_complete: [],
  failed: [],
  cancelled: [],
}
export function dependencyBlockers(task: TaskRecord, tasks: readonly TaskRecord[]): string[] {
  return task.dependencies.filter((id) => tasks.find((t) => t.task_id === id)?.execution_state !== "verified_complete")
}
export function ownershipConflicts(
  ownership: readonly string[],
  tasks: readonly TaskRecord[],
  exceptId?: string,
): string[] {
  return tasks
    .filter(
      (t) =>
        t.task_id !== exceptId &&
        !["verified_complete", "failed", "cancelled"].includes(t.execution_state) &&
        t.ownership.some((held) =>
          ownership.some((requested) => {
            const a = held.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
            const b = requested.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase()
            return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
          }),
        ),
    )
    .map((t) => t.task_id)
}
export function transitionTaskRecord(
  task: TaskRecord,
  body: Record<string, unknown>,
  tasks: readonly TaskRecord[],
): string | null {
  const next = body["state"] as ExecutionState
  if (!EXECUTION_STATES.includes(next)) return "state must be a supported execution state."
  if (body["expected_revision"] !== task.revision)
    return `Task changed; reload revision ${task.revision} before updating.`
  const actor = body["actor_id"]
  if (typeof actor !== "string" || (actor !== "operator" && actor !== task.owner))
    return "Only the task owner or local operator can change execution state."
  if (!transitions[task.execution_state].includes(next))
    return `Invalid task transition ${task.execution_state} → ${next}.`
  if (body["acceptance_criteria"] !== undefined && (actor !== "operator" || !stringList(body["acceptance_criteria"])))
    return "Only the local operator can set a bounded list of acceptance criteria."
  const acceptanceCriteria = (body["acceptance_criteria"] as string[] | undefined) ?? task.acceptance_criteria
  if (["assigned", "running", "verified_complete"].includes(next)) {
    const blockers = dependencyBlockers(task, tasks)
    if (blockers.length) return `Dependencies are not verified complete: ${blockers.join(", ")}.`
  }
  if (["blocked", "failed"].includes(next) && !text(body["blocker"], 4_000))
    return `${next} requires an actionable blocker.`
  if (
    body["evidence"] !== undefined &&
    (!Array.isArray(body["evidence"]) || body["evidence"].length > 128 || !body["evidence"].every(validEvidence))
  )
    return "evidence requires criterion, kind, reference, summary and passed for each entry."
  if (body["artifacts"] !== undefined && !stringList(body["artifacts"], 64, 4_000))
    return "artifacts must be bounded references."
  if (body["review"] !== undefined && !validReview(body["review"]))
    return "review requires outcome, reviewer and summary."
  const review = (body["review"] as TaskReview | undefined) ?? task.review
  const evidence = (body["evidence"] as VerificationEvidence[] | undefined) ?? task.evidence
  if (next === "review" && task.review_rounds >= task.max_review_rounds)
    return "Review round budget exhausted; cancel or fail this task and scope follow-up work."
  if (task.execution_state === "review" && next === "running" && review?.outcome !== "changes_requested")
    return "Returning to running requires specific changes_requested review feedback."
  if (next === "verified_complete") {
    if (actor !== "operator") return "Only the local operator accepts verified completion."
    if (!acceptanceCriteria.length) return "Acceptance criteria are required before verified completion."
    if (!review || review.outcome !== "accepted") return "Verified completion requires an accepted review."
    if (review.reviewer === task.owner) return "Completion requires review by someone other than the task owner."
    if (
      acceptanceCriteria.some(
        (criterion) => !evidence.some((e) => e.criterion === criterion && e.passed && e.kind !== "artifact"),
      )
    )
      return "Each acceptance criterion requires passing check, behavior or review evidence with a reference."
    if (evidence.some((e) => !e.passed && acceptanceCriteria.includes(e.criterion)))
      return "Resolve failing acceptance evidence before completion."
  }
  task.execution_state = next
  // A host-bound worker report acknowledges receipt; it still says nothing
  // about whether acceptance criteria have been verified.
  if (actor === task.owner) {
    task.acknowledged_at ??= Date.now()
    task.delivery_state = "acknowledged"
  }
  task.acceptance_criteria = [...new Set(acceptanceCriteria)]
  task.blocker = ["blocked", "failed"].includes(next) ? String(body["blocker"]) : null
  task.evidence = structuredClone(evidence)
  task.artifacts = structuredClone((body["artifacts"] as string[] | undefined) ?? task.artifacts)
  task.review = next === "review" ? null : structuredClone(review)
  if (next === "review") task.review_rounds += 1
  task.revision += 1
  task.updated_at = Date.now()
  return null
}
