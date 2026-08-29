/**
 * MCP identity pinning tests (Reviewer Item 2 model).
 *
 * Contract: tool callers can never choose an identity; a wrong/absent pin
 * is denied fail-closed; two members on one machine cannot send as each
 * other; kicked members lose access immediately.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { authorizeMember, pinnedMember } from "../../../src/mcp/identity.js"
import { createChannel, joinChannel, kickChannel } from "../../../src/core/engine.js"
import { emptyState } from "../../../src/core/store.js"

const PROJECT = "proj-mcp"
const WORKTREE = "C:\\repo"

function seededState() {
  const state = emptyState()
  const created = createChannel(state, {
    channel: "mcp-ch",
    role: "Builder",
    role_prompt: "p",
    session_id: "sess_mcp_builder",
    project_id: PROJECT,
    worktree: WORKTREE,
    host: "claude-code",
    surface: "mcp",
    delivery_mode: "pull",
    stale_policy: { mode: "none", window_ms: null },
  })
  assert.equal(created.ok, true)
  const joined = joinChannel(state, {
    channel: "mcp-ch",
    role: "Reviewer",
    role_prompt: "p",
    session_id: "sess_mcp_reviewer",
    project_id: PROJECT,
    worktree: WORKTREE,
    host: "claude-code",
    surface: "mcp",
    delivery_mode: "pull",
    stale_policy: { mode: "none", window_ms: null },
  })
  assert.equal(joined.ok, true)
  return state
}

test("unpinned environment is denied for every operation (fail closed)", () => {
  const state = seededState()
  const auth = authorizeMember(state, {})
  assert.equal(auth.ok, false)
  if (!auth.ok) assert.match(auth.message, /no pinned member identity/)
})

test("pinned member identity authorizes only that member", () => {
  const state = seededState()
  const ok = authorizeMember(state, { OPENCOMMS_MEMBER_ID: "sess_mcp_builder" })
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.member_id, "sess_mcp_builder")

  const ok2 = authorizeMember(state, { OPENCOMMS_MEMBER_ID: "sess_mcp_reviewer" })
  assert.equal(ok2.ok, true)
  if (ok2.ok) assert.equal(ok2.member_id, "sess_mcp_reviewer")

  // A caller claiming an unknown session id can NEVER authorize: identity
  // comes from the pin, not from arguments â€” there is no argument to abuse.
  const stranger = authorizeMember(state, { OPENCOMMS_MEMBER_ID: "sess_stranger" })
  assert.equal(stranger.ok, false)
})

test("kicked member's pin stops granting access immediately (fail closed)", () => {
  const state = seededState()
  const kick = kickChannel(state, {
    channel: "mcp-ch",
    session_id: "sess_mcp_builder",
    target_role: "Reviewer",
  })
  assert.equal(kick.ok, true, `kick failed: ${kick.message}`)

  const revoked = authorizeMember(state, { OPENCOMMS_MEMBER_ID: "sess_mcp_reviewer" })
  assert.equal(revoked.ok, false, "kicked member's pinned identity must be revoked")
  if (!revoked.ok) assert.match(revoked.message, /not a member of any channel/)
})

test("two members on one machine cannot send as each other (identity is per-instance)", () => {
  const state = seededState()
  // The ONLY identity source is the instance's env pin. Simulating both
  // instances: builder-env vs reviewer-env resolve to different member ids.
  const asBuilder = authorizeMember(state, { OPENCOMMS_MEMBER_ID: "sess_mcp_builder" })
  const asReviewer = authorizeMember(state, { OPENCOMMS_MEMBER_ID: "sess_mcp_reviewer" })
  assert.equal(asBuilder.ok && asReviewer.ok, true)
  if (asBuilder.ok && asReviewer.ok) {
    assert.notEqual(asBuilder.member_id, asReviewer.member_id)
  }
})

test("pinnedMember ignores blank/whitespace ids", () => {
  assert.equal(pinnedMember({ OPENCOMMS_MEMBER_ID: "   " }), null)
  assert.equal(pinnedMember({}), null)
  const pin = pinnedMember({ OPENCOMMS_MEMBER_ID: " sess_x " })
  assert.equal(pin?.member_id, "sess_x")
})
