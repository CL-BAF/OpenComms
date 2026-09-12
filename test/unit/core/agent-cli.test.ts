import { test } from "node:test"
import assert from "node:assert/strict"
import { runAgentCommand, setAgentCommandDeps } from "../../../src/cli/agent.js"

/** Rejecting fetch: simulates the console being down WITHOUT real network. */
function rejectingFetch(error: Error) {
  return async () => {
    throw error
  }
}

test("agent CLI: missing required flags pre-validate with exit 2 and no HTTP call", async () => {
  setAgentCommandDeps(null)
  const result = await runAgentCommand(["create"])
  assert.equal(result.code, 2)
  assert.match(result.output, /agent create requires:/)
  assert.match(result.output, /--name/)
  assert.match(result.output, /--host/)
  assert.match(result.output, /--role/)
})

test("agent CLI: unknown subcommand exits 2 with usage", async () => {
  setAgentCommandDeps(null)
  const result = await runAgentCommand(["frobnicate"])
  assert.equal(result.code, 2)
  assert.match(result.output, /Usage: opencomms agent/)
})

test("agent CLI: stop/restart/status require a positional agent id (exit 2)", async () => {
  setAgentCommandDeps(null)
  for (const sub of ["stop", "restart", "status"]) {
    const result = await runAgentCommand([sub])
    assert.equal(result.code, 2, `${sub} without agent_id should exit 2`)
    assert.match(result.output, new RegExp(`Usage: opencomms agent ${sub}`))
  }
})

test("agent CLI: connection failure maps to exit 1 with the console hint (injected fetch)", async () => {
  // CI-root-cause fix: the previous version of this test performed a REAL
  // fetch against 127.0.0.1:4919; on v22 runners the ECONNREFUSED surfaced
  // as an unhandled runner error. Injected fetch keeps the behavior covered
  // without any network I/O.
  setAgentCommandDeps({
    fetch: rejectingFetch(new Error("connect ECONNREFUSED 127.0.0.1:4919")),
    base: "http://127.0.0.1:4919",
  })
  try {
    const result = await runAgentCommand(["list"])
    assert.equal(result.code, 1)
    assert.match(result.output, /opencomms gui --server/)
    assert.match(result.output, /ECONNREFUSED/)
  } finally {
    setAgentCommandDeps(null)
  }
})

test("agent CLI: --json emits the raw envelope; 403 maps to exit 4 (injected fetch)", async () => {
  setAgentCommandDeps({
    fetch: async () =>
      new Response(JSON.stringify({ ok: false, message: "trust denied" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    base: "http://127.0.0.1:4919",
  })
  try {
    const json = await runAgentCommand(["list", "--json"])
    assert.equal(json.code, 4)
    assert.deepEqual(JSON.parse(json.output), { ok: false, message: "trust denied" })
    const human = await runAgentCommand(["list"])
    assert.equal(human.code, 4)
    assert.match(human.output, /trust denied/)
  } finally {
    setAgentCommandDeps(null)
  }
})

test("agent CLI: list rendering + --json success envelope (injected fetch)", async () => {
  setAgentCommandDeps({
    fetch: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            agents: [
              {
                id: "agt_1",
                name: "coder-1",
                role: "Coder",
                host: "opencode",
                status: "running",
                node_id: "node_local",
                model: "opencode/glm-5.3",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    base: "http://127.0.0.1:4919",
  })
  try {
    const human = await runAgentCommand(["list"])
    assert.equal(human.code, 0)
    assert.match(
      human.output,
      /agt_1 coder-1 \| Coder \(opencode\) \| running \| node=node_local model=opencode\/glm-5\.3/,
    )
    const json = await runAgentCommand(["list", "--json"])
    const envelope = JSON.parse(json.output)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.data.agents.length, 1)
  } finally {
    setAgentCommandDeps(null)
  }
})

test("agent CLI: 409 conflict maps to exit 3, 404 to exit 5, 500 to exit 6 (injected fetch)", async () => {
  const cases: Array<[number, number]> = [
    [409, 3],
    [404, 5],
    [500, 6],
  ]
  for (const [status, expected] of cases) {
    setAgentCommandDeps({
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, message: `HTTP ${status}` }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      base: "http://127.0.0.1:4919",
    })
    try {
      const result = await runAgentCommand(["status", "agt_x"])
      assert.equal(result.code, expected, `HTTP ${status} should exit ${expected}`)
    } finally {
      setAgentCommandDeps(null)
    }
  }
})
