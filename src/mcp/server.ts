/**
 * Minimal MCP (Model Context Protocol) stdio server.
 *
 * Dependency-free JSON-RPC 2.0 over newline-delimited stdin/stdout — the
 * documented transport for local MCP servers in Claude Code (.mcp.json),
 * Claude Desktop (.mcpb), and Codex (config.toml). No network listener:
 * the host spawns this process and speaks over stdio only.
 *
 * Implemented (all documented surface OpenComms needs):
 *   initialize / notifications/initialized / ping
 *   tools/list / tools/call
 * Everything else -> JSON-RPC error -32601.
 *
 * Tool authorization: every tool call resolves the caller from the PINNED
 * member identity in this process's environment (OPENCOMMS_MEMBER_ID,
 * written by the installer) and validates it against the live state roster,
 * failing closed. Tool arguments can never choose an identity.
 */

import { isMember, joinChannel } from "../core/engine.js"
import {
  createChannel,
  disconnectChannel,
  history,
  inbox,
  kickChannel,
  pauseChannel,
  resumeChannel,
  sendMessage,
  status,
  updateRole,
} from "../core/engine.js"
import type { HostSurface, SenderMessageType, State, ToolResult } from "../core/types.js"

export interface McpToolDef {
  name: string
  description: string
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] }
  execute(args: Record<string, unknown>): Promise<ToolPayload>
}

export interface ToolPayload {
  text: string
  isError?: boolean
}

interface JsonRpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method: string
  params?: Record<string, unknown>
}

const PROTOCOL_VERSION = "2024-11-05"

export class McpStdioServer {
  private readonly tools: McpToolDef[]
  private readonly serverInfo: { name: string; version: string }
  private running = false

  /** Max inbound JSON-RPC line size (memory-exhaustion DoS guard). */
  private static readonly MAX_LINE_BYTES = 1_048_576 // 1 MiB
  /** Silently swallowed buffer beyond which we hard-drop the connection. */
  private static readonly MAX_BUFFER_BYTES = 2 * McpStdioServer.MAX_LINE_BYTES

  constructor(opts: { name: string; version: string; tools: McpToolDef[] }) {
    this.serverInfo = { name: opts.name, version: opts.version }
    this.tools = opts.tools
  }

  /** Serve until stdin closes. Diagnostics go to stderr ONLY. */
  listen(): void {
    if (this.running) return
    this.running = true
    let buffer = ""
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk
      if (buffer.length > McpStdioServer.MAX_BUFFER_BYTES) {
        // Oversized frame flood: drop the buffer and signal protocol error.
        this.log(`inbound buffer exceeded ${McpStdioServer.MAX_BUFFER_BYTES} bytes; discarding`)
        this.write({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: `Oversized message (max ${McpStdioServer.MAX_LINE_BYTES} bytes per frame)` },
        })
        buffer = ""
        return
      }
      let idx: number
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        if (line.length > McpStdioServer.MAX_LINE_BYTES) {
          this.write({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: `Oversized message (max ${McpStdioServer.MAX_LINE_BYTES} bytes per frame)`,
            },
          })
          continue
        }
        void this.handleLine(line)
      }
    })
    process.stdin.on("end", () => process.exit(0))
    process.stdin.resume()
  }

  log(message: string): void {
    process.stderr.write(`[opencomms-mcp] ${message}\n`)
  }

  private write(payload: unknown): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }

  private async handleLine(line: string): Promise<void> {
    let req: JsonRpcRequest
    try {
      req = JSON.parse(line) as JsonRpcRequest
    } catch {
      this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
      return
    }
    const isNotification = req.id === undefined || req.id === null
    try {
      const result = await this.dispatch(req)
      if (result !== undefined && !isNotification) {
        this.write({ jsonrpc: "2.0", id: req.id, result })
      }
    } catch (error) {
      const code = error instanceof McpMethodError ? error.code : -32603
      const message = error instanceof McpMethodError ? error.message : "Internal error"
      if (!isNotification) this.write({ jsonrpc: "2.0", id: req.id, error: { code, message } })
      if (!(error instanceof McpMethodError)) {
        this.log(`dispatch failed: ${(error as Error).message}`)
      }
    }
  }

  private async dispatch(req: JsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: this.serverInfo,
        }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined
      case "ping":
        return {}
      case "tools/list":
        return {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        }
      case "tools/call": {
        const params = req.params ?? {}
        const name = typeof params["name"] === "string" ? params["name"] : ""
        const tool = this.tools.find((t) => t.name === name)
        if (!tool) throw new McpMethodError(`Unknown tool: ${name}`, -32602)
        const args = isRecord(params["arguments"]) ? params["arguments"] : {}
        for (const key of tool.inputSchema.required ?? []) {
          if (!(key in args)) throw new McpMethodError(`Missing required argument: ${key}`, -32602)
        }
        const payload = await tool.execute(args)
        return { content: [{ type: "text", text: payload.text }], isError: payload.isError === true }
      }
      default:
        throw new McpMethodError(`Method not found: ${req.method}`, -32601)
    }
  }
}

export class McpMethodError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
