import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const MAX_LINE_BYTES = 1_048_576

function pingFrame(bytes: number, character: string): string {
  const empty = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { text: "" } })
  const available = bytes - Buffer.byteLength(empty, "utf8")
  const width = Buffer.byteLength(character, "utf8")
  return empty.replace(
    '"text":""',
    `"text":"${character.repeat(Math.floor(available / width))}${"x".repeat(available % width)}"`,
  )
}

// Feed deterministic decoded chunks in a child process so a pipe's OS-specific
// chunk boundaries cannot hide the buffer-limit branch. All parsing, dispatch,
// and output still run through the real server.
function feedChunks(
  chunks: string[],
): Array<{ id: number | null; result?: unknown; error?: { code: number; message: string } }> {
  const moduleUrl = new URL("../../../src/mcp/server.js", import.meta.url).href
  const script = `
    import { readFileSync } from 'node:fs';
    import { McpStdioServer } from ${JSON.stringify(moduleUrl)};
    const chunks = JSON.parse(readFileSync(0, 'utf8'));
    let receive;
    process.stdin.setEncoding = () => process.stdin;
    process.stdin.on = (event, callback) => {
      if (event === 'data') receive = callback;
      return process.stdin;
    };
    process.stdin.resume = () => process.stdin;
    new McpStdioServer({name:'test',version:'1',tools:[]}).listen();
    for (const chunk of chunks) receive(chunk);
    await new Promise(resolve => setImmediate(resolve));
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify(chunks),
    encoding: "utf8",
    timeout: 10_000,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
}

for (const character of ["x", "😀", "界"]) {
  test(`MCP accepts a ${character} frame exactly at the UTF-8 byte limit`, () => {
    const frame = pingFrame(MAX_LINE_BYTES, character)
    assert.equal(Buffer.byteLength(frame, "utf8"), MAX_LINE_BYTES)
    assert.deepEqual(feedChunks([`${frame}\n`]), [{ jsonrpc: "2.0", id: 1, result: {} }])
  })

  test(`MCP rejects a ${character} frame one byte over the limit and recovers`, () => {
    const frame = pingFrame(MAX_LINE_BYTES + 1, character)
    const replies = feedChunks([`${frame}\n`, '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'])
    assert.equal(replies.length, 2)
    assert.equal(replies[0]?.error?.code, -32700)
    assert.match(replies[0]?.error?.message ?? "", /Oversized/)
    assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 2, result: {} })
  })
}

test("MCP accumulates UTF-8 bytes across chunks for the buffer limit and recovers", () => {
  const chunk = "界".repeat(Math.floor(MAX_LINE_BYTES / 3))
  const replies = feedChunks([chunk, chunk, "界", '{"jsonrpc":"2.0","id":2,"method":"ping"}\n'])
  assert.equal(replies.length, 2)
  assert.match(replies[0]?.error?.message ?? "", /Oversized/)
  assert.deepEqual(replies[1], { jsonrpc: "2.0", id: 2, result: {} })
})
