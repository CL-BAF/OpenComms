/** Saved project-local intent only. Applying an entry always requires an explicit link or launch action. */
import { randomBytes } from "node:crypto"

export const TEAM_TEMPLATE_SCHEMA_VERSION = 1
export const MAX_TEAM_TEMPLATES = 32
export const TEAM_CAPABILITY_REQUIREMENTS = [
  "push",
  "interrupt",
  "permissions",
  "status",
  "identity",
  "isolated_worktree",
  "model_selection",
] as const
export interface TeamTemplateEntry {
  entry_id: string
  role: string
  role_prompt: string
  host: string
  runtime: string
  model: string | null
  required_capabilities: string[]
}
export interface TeamTemplate {
  id: string
  revision: number
  name: string
  description: string
  entries: TeamTemplateEntry[]
  budgets: { max_runtime_ms: number | null; max_delivered_messages: number | null; max_review_rounds: number }
  created_at: number
  updated_at: number
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max
const positive = (value: unknown, max: number, min = 1): boolean =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max

export function newTeamTemplateId(): string {
  return `tpl_${randomBytes(12).toString("hex")}`
}
export function validTeamTemplate(value: unknown): value is TeamTemplate {
  if (
    !record(value) ||
    typeof value["id"] !== "string" ||
    !/^tpl_[0-9a-f]{24}$/.test(value["id"]) ||
    !positive(value["revision"], Number.MAX_SAFE_INTEGER) ||
    !text(value["name"], 120) ||
    typeof value["description"] !== "string" ||
    value["description"].length > 2_000 ||
    !Number.isFinite(value["created_at"]) ||
    !Number.isFinite(value["updated_at"])
  )
    return false
  const entries = value["entries"]
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > 8 ||
    !entries.every((entry: unknown) => {
      if (!record(entry)) return false
      return (
        typeof entry["entry_id"] === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(entry["entry_id"]) &&
        typeof entry["role"] === "string" &&
        /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/.test(entry["role"]) &&
        text(entry["role_prompt"], 16_000) &&
        typeof entry["host"] === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(entry["host"]) &&
        typeof entry["runtime"] === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(entry["runtime"]) &&
        entry["host"] === entry["runtime"] &&
        (entry["model"] === null || (text(entry["model"], 200) && /^[^\s/]+\/[^\s]+$/.test(entry["model"]))) &&
        Array.isArray(entry["required_capabilities"]) &&
        entry["required_capabilities"].length <= 16 &&
        entry["required_capabilities"].every(
          (cap: unknown) => typeof cap === "string" && TEAM_CAPABILITY_REQUIREMENTS.some((known) => known === cap),
        )
      )
    })
  )
    return false
  const typed = entries as TeamTemplateEntry[]
  if (
    new Set(typed.map((e) => e.entry_id)).size !== typed.length ||
    new Set(typed.map((e) => e.role.toLowerCase())).size !== typed.length
  )
    return false
  const budgets = value["budgets"]
  return (
    record(budgets) &&
    (budgets["max_runtime_ms"] === null || positive(budgets["max_runtime_ms"], 30 * 24 * 60 * 60_000, 60_000)) &&
    (budgets["max_delivered_messages"] === null || positive(budgets["max_delivered_messages"], 1_000_000)) &&
    positive(budgets["max_review_rounds"], 20) &&
    JSON.stringify(value).length <= 100_000
  )
}
