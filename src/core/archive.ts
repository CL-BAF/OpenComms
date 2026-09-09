/**
 * Session archive (Save Session, work order 2026-09-08).
 *
 * A SAVED session moves OUT of the live state into a per-session archive
 * file: `.opencomms/archives/<channel_id>.json`. Archiving is NOT deleting:
 * everything OpenComms legitimately received is preserved (metadata, final
 * roster, role prompts, full message history within the retention cap), so
 * future agents can QUERY the archive — compact context first, full
 * messages on demand, never auto-dumped into a model context.
 *
 * Layered structure (not one giant transcript): summary + purpose +
 * members + message history + final-state note. Hidden chain-of-thought is
 * never assumed — OpenComms only ever saw tool calls and messages.
 *
 * Files are machine-local (same trust boundary as state.json), written
 * atomically, and sized by the same retention cap as live state.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { MAX_PERSISTED_MESSAGES } from "./engine.js"
import type { Channel, Member, MessageEnvelope, SessionLifecycle } from "./types.js"

export const ARCHIVES_DIR = "archives"
export const ARCHIVE_SCHEMA = 1

/** What the first agent is asked to return at save time (≤2000 chars). */
export interface SessionArchive {
  schema: number
  channel_id: string
  name: string
  parent_channel_id: string | null
  description: string | null
  summary: string
  members: Member[]
  budgets: { max_runtime_ms: number | null; max_delivered_messages: number | null } | null
  created_at: number
  saved_at: number
  saved_by: string | null
  saved_by_role: string | null
  message_count: number
  messages: MessageEnvelope[]
  final_state_note: string | null
}

export interface ArchiveSummary {
  channel_id: string
  name: string
  description: string | null
  summary: string
  saved_at: number
  saved_by_role: string | null
  member_count: number
  message_count: number
  parent_channel_id: string | null
}

export class ArchiveStore {
  readonly dir: string

  constructor(projectDir: string) {
    this.dir = join(projectDir, ".opencomms", ARCHIVES_DIR)
  }

  private fileFor(channelId: string): string {
    // channel ids are engine-minted (chn_<hex>) — validated before use.
    if (!/^chn_[A-Za-z0-9_-]{1,64}$/.test(channelId)) throw new Error(`invalid archive id: ${channelId.slice(0, 12)}`)
    return join(this.dir, `${channelId}.json`)
  }

  /**
   * Build the archive record for a channel from the live state. Accepts the
   * live Channel shape ({id}) or the engine's archive_inputs shape
   * ({channel_id}) so buildSessionArchive output feeds in directly.
   */
  fromChannel(
    channel: {
      id?: string
      channel_id?: string
      name: string
      parent_channel_id?: string | null
      description?: string | null
      members: Member[]
      budgets?: { max_runtime_ms: number | null; max_delivered_messages: number | null } | null
      created_at?: number
    },
    messages: MessageEnvelope[],
    savedBy: string | null,
    savedByRole: string | null,
    summary: string | null,
  ): SessionArchive {
    const channelId = channel.id ?? channel.channel_id ?? ""
    if (!channelId) throw new Error("archive source has no channel id")
    const sorted = [...messages].sort((a, b) => a.timestamp - b.timestamp)
    const newest = sorted.slice(-MAX_PERSISTED_MESSAGES)
    const lastContent = newest.at(-1)?.content ?? ""
    return {
      schema: ARCHIVE_SCHEMA,
      channel_id: channelId,
      name: channel.name,
      parent_channel_id: channel.parent_channel_id ?? null,
      description: channel.description ?? null,
      summary: (summary ?? "").trim().slice(0, 2000),
      members: channel.members.map((m) => ({ ...m })),
      budgets: channel.budgets ?? null,
      created_at: channel.created_at ?? Date.now(),
      saved_at: Date.now(),
      saved_by: savedBy,
      saved_by_role: savedByRole,
      message_count: newest.length,
      messages: newest,
      final_state_note: lastContent ? lastContent.slice(0, 400) : null,
    }
  }

  /** Atomic write (temp + rename, same discipline as state.json). */
  save(archive: SessionArchive): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.fileFor(archive.channel_id)
    const tmp = join(this.dir, `.arch.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
    writeFileSync(tmp, JSON.stringify(archive, null, 2), "utf8")
    try {
      renameSync(tmp, file)
    } catch {
      // Windows AV/OneDrive race: one blocking retry, then direct write.
      try {
        renameSync(tmp, file)
      } catch {
        writeFileSync(file, JSON.stringify(archive, null, 2), "utf8")
      }
    }
  }

  /** Parse + structurally validate one archive file; null when absent/broken. */
  private read(file: string): SessionArchive | null {
    if (!existsSync(file)) return null
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown
      const rec = parsed as Record<string, unknown>
      if (rec["schema"] !== ARCHIVE_SCHEMA) return null
      if (typeof rec["channel_id"] !== "string" || typeof rec["name"] !== "string") return null
      if (!Array.isArray(rec["members"]) || !Array.isArray(rec["messages"])) return null
      if (typeof rec["saved_at"] !== "number") return null
      return parsed as SessionArchive
    } catch {
      return null
    }
  }

  get(channelId: string): SessionArchive | null {
    try {
      return this.read(this.fileFor(channelId))
    } catch {
      return null
    }
  }

  /** Latest archive for a session NAME (resumes may reuse names). */
  findByName(name: string): SessionArchive | null {
    const all = this.list()
      .filter((a) => a.name === name.trim().toLowerCase())
      .sort((a, b) => b.saved_at - a.saved_at)
    return all.length > 0 ? this.get(all[0]!.channel_id) : null
  }

  list(): ArchiveSummary[] {
    if (!existsSync(this.dir)) return []
    let entries: string[] = []
    try {
      entries = readdirSync(this.dir).filter((f) => f.endsWith(".json") && !f.startsWith("."))
    } catch {
      return []
    }
    const out: ArchiveSummary[] = []
    for (const entry of entries) {
      const archive = this.read(join(this.dir, entry))
      if (!archive) continue
      out.push({
        channel_id: archive.channel_id,
        name: archive.name,
        description: archive.description,
        summary: archive.summary,
        saved_at: archive.saved_at,
        saved_by_role: archive.saved_by_role,
        member_count: archive.members.length,
        message_count: archive.message_count,
        parent_channel_id: archive.parent_channel_id,
      })
    }
    return out.sort((a, b) => b.saved_at - a.saved_at)
  }

  delete(channelId: string): boolean {
    try {
      const file = this.fileFor(channelId)
      if (!existsSync(file)) return false
      unlinkSync(file)
      return true
    } catch {
      return false
    }
  }
}

/**
 * COMPACT archived context for resumed sessions and join hints: purpose,
 * decisions/work summary, roster, and HOW to read more — NEVER the full
 * transcript. Future agents query the archive when they need depth.
 */
export function buildArchiveContext(archive: SessionArchive, forChannelName: string): string {
  const roles = archive.members.map((m) => `${m.role} (${m.host})`).join(", ")
  const lines = [
    `[OpenComms archived context — session "${archive.name}" → resumed as "${forChannelName}"]`,
    `Saved: ${new Date(archive.saved_at).toISOString()} | Messages archived: ${archive.message_count}`,
    archive.description ? `Purpose: ${archive.description}` : "Purpose: (no description was recorded)",
    archive.summary ? `Summary of prior work:\n${archive.summary}` : "Summary: (none recorded)",
    `Final roster: ${roles}`,
    archive.final_state_note ? `Last state note: ${archive.final_state_note}` : "",
    `FULL ARCHIVED HISTORY is NOT included here. Read it on demand via the opencomms_archive tool (mode="summary" for the brief view, mode="messages" for the full record) referencing session "${archive.name}".`,
  ]
  return lines.filter((l) => l !== "").join("\n")
}

/** Mechanical fallback summary when the agent did not supply one. */
export function mechanicalSummary(archive: SessionArchive): string {
  const roles = archive.members.map((m) => m.role).join(", ")
  return `Session "${archive.name}" archived. ${archive.description ?? "No description recorded."} Participants: ${roles}. ${archive.message_count} message(s) preserved in this archive.`
}

/** Lifecycle helper for views. */
export function lifecycleLabel(l: SessionLifecycle): string {
  return l === "active" ? "Active" : l === "saved" ? "Saved" : "Deleted"
}
