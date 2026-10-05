/** Real Chrome + real persisted backend. Native mode emulates Tauri transport, not a packaged WebView. */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { startGuiServer } from "../dist/gui/server.js"
import { OrchestratorStore, newAgentId, pushEvent } from "../dist/orchestrator/state.js"
import { StateStore } from "../dist/core/store.js"
import { joinChannel } from "../dist/core/engine.js"
import { dispatchBridgeCommand } from "../dist/orchestrator/bridge.js"
import { VERSION } from "../dist/version.js"

const packagePath = process.env.OPENCOMMS_PLAYWRIGHT_PATH
const { chromium } = await (packagePath ? import(pathToFileURL(packagePath).href) : import("playwright")).catch(() => {
  throw new Error(
    "Playwright unavailable: install playwright or set OPENCOMMS_PLAYWRIGHT_PATH to its index.mjs. This gate is unverified, not passed.",
  )
})
const root = mkdtempSync(join(tmpdir(), "oc-browser-"))
const project = join(root, "project with spaces")
mkdirSync(project)
process.env.OPENCOMMS_CONFIG_DIR = join(root, "app-config")
const server = await startGuiServer({ projectDir: project, port: 0, hostname: "127.0.0.1" })
const base = `http://127.0.0.1:${server.port}`
const browser = await chromium.launch({ channel: process.env.OPENCOMMS_BROWSER_CHANNEL || "chrome", headless: true })
mkdirSync(".verification", { recursive: true })
const evidence = []
async function appendEvent(orchestrator, message) {
  await orchestrator.withLock(() => {
    const state = orchestrator.load()
    pushEvent(state, {
      type: "browser-check",
      kind: "orchestration",
      message,
      node_id: null,
      agent_id: null,
      task_id: null,
    })
    orchestrator.save(state)
  })
}

/** Persisted authority fixtures exercise the real UI/core; they never launch or impersonate a vendor runtime. */
async function seedWorker(store, orchestrator, channel, prefix) {
  const sessions = ["lead", "worker", "reviewer"].map((role) => `${prefix}-fixture-${role}`)
  await store.withLock(() => {
    const state = store.load()
    for (const [index, session_id] of sessions.entries()) {
      const result = joinChannel(state, {
        channel,
        role: ["Lead", "Worker", "Reviewer"][index],
        role_prompt: "Browser fixture only.",
        session_id,
        project_id: "gui-local-project",
        worktree: project,
        host: "opencode",
        surface: "cli",
        delivery_mode: "pull",
        stale_policy: { mode: "none", window_ms: null },
      })
      assert.equal(result.ok, true, result.message)
    }
    store.save(state)
  })
  const id = newAgentId()
  await orchestrator.withLock(() => {
    const state = orchestrator.load()
    state.agents.push({
      id,
      name: `${prefix} fixture worker`,
      host: "opencode",
      role: "Worker",
      role_prompt: "Browser fixture only.",
      runtime: "opencode",
      node_id: state.local_node_id,
      worktree: project,
      status: "idle",
      host_session_id: sessions[1],
      spawn_cmd_redacted: "persisted test fixture; no host launched",
      designated: null,
      channel_ids: [channel],
      last_heartbeat: Date.now(),
      created_at: Date.now(),
      restart_count: 0,
      model: null,
    })
    orchestrator.save(state)
  })
  return { id, sessions }
}

async function refresh(page) {
  await page.evaluate(async () => {
    while (refreshQueued) await new Promise((resolve) => setTimeout(resolve, 20))
    await refreshCurrent()
  })
}

async function transitionTask(page, state, fill) {
  await page.locator("#taskUpdate").click()
  await page.locator('#modalForm [name="state"]').selectOption(state)
  if (fill) await fill(page.locator("#modalForm"))
  await page.getByRole("button", { name: "Record outcome", exact: true }).click()
  await page.locator("#modalForm").waitFor({ state: "detached" })
  await page.locator("#view").getByText(`Execution: ${state}`, { exact: false }).waitFor()
}
try {
  for (const native of [false, true]) {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    page.setDefaultTimeout(12000)
    const errors = []
    page.on("pageerror", (e) => errors.push(e.message))
    if (native) {
      await page.exposeFunction("__nativeBridge", async (cmd, args) => {
        if (cmd === "pick_project") return project
        const deps = server.bridgeDeps()
        return dispatchBridgeCommand(
          { ...deps, getCoreDeps: server.bridgeDeps, write() {}, error() {} },
          { id: args.operation_id || "browser", cmd, args },
        )
      })
      await page.addInitScript(() => {
        window.__TAURI__ = {
          core: {
            invoke(cmd, payload) {
              return window.__nativeBridge(cmd === "orchestrator_invoke" ? payload.cmd : cmd, payload?.args || {})
            },
          },
        }
      })
    }
    const prefix = native ? "native-contract" : "browser"
    await page.goto(base)
    await page.locator("#teamStrip").waitFor()
    // Simulate an unsupported HTTP picker capability; the native picker is independently available.
    const browseCapability = await page.evaluate(() => capabilityData.folder_browse)
    await page.evaluate(() => {
      capabilityData.folder_browse = "unsupported"
    })
    await page.locator("#projectBtn").click()
    await page.locator("#browseBtn").waitFor()
    assert.equal(await page.locator("#browseBtn").isDisabled(), !native)
    if (!native) assert.match(await page.locator("#browseReason").innerText(), /absolute project path/)
    await page.locator("#projectPathInput").fill(join(project, "missing-directory"))
    await page.locator("#modalForm").getByRole("button", { name: "Open project", exact: true }).click()
    await page.locator("#modalForm .form-error").filter({ hasText: /\S/ }).waitFor()
    assert.equal(
      await page.locator("#browseBtn").isDisabled(),
      !native,
      "Failed submission retains negotiated disabled controls",
    )
    await page.locator("#modalCancel").click()
    await page.evaluate((value) => {
      capabilityData.folder_browse = value
    }, browseCapability)
    await page.locator('[data-nav="sessions"]').click()
    await page.locator("#newBtnInline").waitFor()
    await page.locator("#newBtnInline").click()
    await page.locator("#sessionName").fill(prefix)
    await page.getByRole("button", { name: "Create session", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    await page.locator(`[data-open="${prefix}"]`).click()
    await page.locator("#joinCommand").filter({ hasText: "/OpenComms Join" }).waitFor()
    await page.locator("#hostSel").selectOption("codex")
    await page.locator("#joinCommand").filter({ hasText: "opencomms_join" }).waitFor()
    assert.match(await page.locator("#joinCommand").innerText(), new RegExp(prefix))
    const store = new StateStore(project),
      state = store.load()
    const joined = joinChannel(state, {
      channel: prefix,
      role: "Reviewer",
      role_prompt: "Review",
      session_id: "member_" + prefix,
      project_id: "gui-local-project",
      worktree: project,
      host: "codex",
      delivery_mode: "pull",
    })
    assert.equal(joined.ok, true, joined.message)
    await store.withLock(() => store.save(state))
    await page.reload()
    await page.locator('[data-nav="sessions"]').click()
    await page.locator(`[data-open="${prefix}"]`).click()
    await page.getByRole("button", { name: "Remove Agent", exact: true }).click()
    await page.locator("#modalForm").getByRole("button", { name: "Remove agent", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    await page.getByText("No agents are linked yet.").waitFor()
    assert.equal(store.load().channels[prefix].members.length, 0)
    await page.getByRole("button", { name: "Save Session", exact: true }).click()
    await page.locator("#saveSummary").fill("Browser verified save and identity-preserving removal")
    await page.locator("#modalForm").getByRole("button", { name: "Save session", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    await page.locator('[data-stab="saved"]').click()
    const orchestrator = new OrchestratorStore(project, store)
    await appendEvent(orchestrator, "refresh while saved tab selected")
    await refresh(page)
    assert.match(await page.locator('[data-stab="saved"]').getAttribute("class"), /\bactive\b/)
    assert.equal(await page.evaluate(() => selectedSessionTab), "saved")
    await page.locator(`[data-open="${prefix}"]`).click()
    await page.getByRole("button", { name: "Resume as new session", exact: true }).click()
    await page.locator("#resumeName").fill(prefix + "-resumed")
    await page.getByRole("button", { name: "Resume as new", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    await page.locator('[data-stab="live"]').click()
    await page.locator(`[data-open="${prefix}-resumed"]`).waitFor()
    await page.locator('[data-nav="settings"]').click()
    await page
      .locator("#updatesStatus")
      .getByText("GUI application updates are unavailable on this surface.", { exact: true })
      .waitFor()
    assert.match(await page.locator("#updatesStatus").innerText(), /opencomms update.*CLI/)
    await page.locator('[data-tab="integrations"]').click()
    await page.locator(".integration-row").first().waitFor()
    const onboardingRows = await page.locator(".integration-row").allInnerTexts()
    assert.ok(onboardingRows.length >= 6, "All configured host integrations are visible")
    for (const row of onboardingRows) {
      for (const stage of ["Application:", "Configuration:", "Connection:", "Round trip:"])
        assert.ok(row.includes(stage), `Missing integration onboarding stage ${stage}`)
      assert.match(
        row,
        /Round trip: unverified/,
        "Configuration checks must not claim authenticated host interoperability",
      )
    }
    const verifyLabels = await page.locator('[data-iact="verify"]').allInnerTexts()
    assert.ok(
      verifyLabels.every((label) => label === "Check configuration"),
      "Configuration checks use a scoped label",
    )
    await page.screenshot({ path: `.verification/${prefix}-integrations.png`, fullPage: true })
    await page.locator('[data-tab="diagnostics"]').click()
    await page.locator("#copyDiag").waitFor()
    await page.locator('[data-nav="team"]').click()
    await page.locator("#createAgentBtn").click()
    await page.locator("#modalForm").waitFor()
    // A model/runtime absence must disable submission, not install a no-op callback.
    if ((await page.locator("#agentModel").count()) === 0)
      assert.equal(await page.locator('#modalForm [type="submit"]').isDisabled(), true)
    await page.locator("#modalCancel").click()
    const priorAgents = orchestrator.load().agents.map((agent) => agent.id)
    await page.locator("#teamTemplatesBtn").click()
    await page.locator("#newTemplate").click()
    await page.locator('#modalForm [name="name"]').fill(prefix + " team plan")
    await page.locator('#modalForm [name="description"]').fill("Saved UI fixture intent; never launch a vendor host.")
    await page.locator('#modalForm [name="entries"]').fill(
      JSON.stringify([
        {
          entry_id: "worker",
          role: "Worker",
          role_prompt: "Fixture role prompt preserved by the saved plan.",
          host: "opencode",
          runtime: "opencode",
          model: null,
          required_capabilities: ["push", "status"],
        },
      ]),
    )
    await page.locator('#modalForm [name="runtime_minutes"]').fill("12")
    await page.locator('#modalForm [name="message_budget"]').fill("42")
    await page.getByRole("button", { name: "Save plan", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    const template = orchestrator.load().team_templates.find((item) => item.name === prefix + " team plan")
    assert.ok(template, "Saved plan persists through the backend")
    assert.deepEqual(
      orchestrator.load().agents.map((agent) => agent.id),
      priorAgents,
      "Saving intent never launches an agent",
    )
    await appendEvent(orchestrator, "template refresh")
    await refresh(page)
    await page.locator(`[data-template-apply="${template.id}"]`).click()
    assert.equal(await page.locator('#modalForm [name="isolated_worktree"]').isDisabled(), true)
    assert.match(
      await page.locator('#modalForm [name="isolated_worktree"]').getAttribute("title"),
      /Git|repository|worktree/i,
    )
    await page.locator('#modalForm [name="mode"]').selectOption("linked")
    await page.locator('#modalForm [name="channel"]').fill(prefix + "-plan")
    await page.locator('#modalForm [name="create_channel"]').check()
    await page.getByRole("button", { name: "Prepare / launch selected entry", exact: true }).click()
    await page
      .locator("#modalForm")
      .getByText("Fixture role prompt preserved by the saved plan.", { exact: true })
      .waitFor()
    assert.match(await page.locator("#modalForm").innerText(), /\/OpenComms Join/)
    assert.deepEqual(
      orchestrator.load().agents.map((agent) => agent.id),
      priorAgents,
      "Preparing a link preserves all host identities",
    )
    assert.deepEqual(store.load().channels[prefix + "-plan"].budgets, {
      max_runtime_ms: 720000,
      max_delivered_messages: 42,
    })
    assert.equal(store.load().channels[prefix + "-plan"].members.length, 0)
    await page.locator("#modalCancel").click()
    await page.locator(`[data-template-delete="${template.id}"]`).click()
    await page.locator("#modalForm").getByRole("button", { name: "Delete template", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    assert.ok(!orchestrator.load().team_templates.some((item) => item.id === template.id))
    assert.ok(store.load().channels[prefix + "-plan"], "Deleting intent retains the prepared OpenComms session")
    const channel = prefix + "-resumed"
    const fixture = await seedWorker(store, orchestrator, channel, prefix)
    const criterion = "The UI records evidence and independent review before completing this fixture task."
    const taskTitle = prefix + " acceptance fixture"
    await page.locator('[data-nav="tasks"]').click()
    await page.locator("#assignTaskBtn").click()
    await page.locator("#taskAgent").selectOption(fixture.id)
    await page.locator("#taskTitle").fill(taskTitle)
    await page
      .locator("#taskBody")
      .fill("Persisted backend/UI fixture. No vendor agent runs or implements external behavior.")
    await page.locator("#taskChannel").fill(channel)
    await page.locator('#modalForm [name="acceptance_criteria"]').fill(criterion)
    await page.locator('#modalForm [name="scope"]').fill("UI task lifecycle and backend persistence")
    await page.locator('#modalForm [name="ownership"]').fill("scripts/test-browser-workflows.mjs")
    await page.locator("#modalForm").getByRole("button", { name: "Assign task", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    const assigned = orchestrator.load().tasks.find((task) => task.title === taskTitle)
    assert.ok(assigned, "GUI assignment must persist a task")
    assert.equal(assigned.execution_state, "assigned")
    assert.equal(assigned.delivery_state, "queued")
    const messages = Object.values(store.load().messages).filter((message) =>
      (assigned.related_message_ids || []).includes(message.message_id),
    )
    assert.equal(messages.length, 1)
    assert.equal(messages[0].recipient_session_id, fixture.sessions[1])
    assert.equal((store.load().queues[fixture.sessions[0]] || []).length, 0)
    assert.equal((store.load().queues[fixture.sessions[2]] || []).length, 0)
    await page.locator('#taskSearch input[name="query"]').fill(taskTitle)
    await page.locator("#taskSearch").getByRole("button", { name: "Search", exact: true }).click()
    await appendEvent(orchestrator, "refresh with task filter selected")
    await refresh(page)
    assert.equal(await page.locator('#taskSearch input[name="query"]').inputValue(), taskTitle)
    assert.equal(await page.locator("[data-task]").count(), 1)
    await page.locator(`[data-task-detail="${assigned.task_id}"]`).click()
    await transitionTask(page, "running")
    assert.equal(orchestrator.load().tasks.find((task) => task.task_id === assigned.task_id).execution_state, "running")
    await transitionTask(page, "review")
    await refresh(page)
    assert.equal(await page.evaluate(() => taskDetailId), assigned.task_id)
    assert.equal(orchestrator.load().tasks.find((task) => task.task_id === assigned.task_id).execution_state, "review")
    // A completion click without criterion evidence and review must remain a rejected backend outcome.
    await page.locator("#taskUpdate").click()
    await page.locator('#modalForm [name="state"]').selectOption("verified_complete")
    await page.getByRole("button", { name: "Record outcome", exact: true }).click()
    await page
      .locator("#modalForm .form-error")
      .filter({ hasText: /evidence|review|criterion/i })
      .waitFor()
    assert.equal(orchestrator.load().tasks.find((task) => task.task_id === assigned.task_id).execution_state, "review")
    const artifact = `.verification/${prefix}-task-fixture.json`
    writeFileSync(
      artifact,
      JSON.stringify(
        {
          surface: prefix,
          task_id: assigned.task_id,
          criterion,
          kind: "UI/backend fixture",
          scope: "No authenticated vendor or external attack behavior tested",
        },
        null,
        2,
      ),
    )
    const modal = page.locator("#modalForm")
    await modal.locator('[name="kind_0"]').selectOption("check")
    await modal.locator('[name="reference_0"]').fill(artifact)
    await modal
      .locator('[name="summary_0"]')
      .fill(
        "The persisted task rejected unverified completion and accepted criterion evidence plus independent review through the UI.",
      )
    await modal.locator('[name="passed_0"]').check()
    await modal.locator('[name="artifacts"]').fill(artifact)
    await modal.locator('[name="reviewer"]').fill(prefix + " fixture reviewer")
    await modal
      .locator('[name="review_summary"]')
      .fill("Reviewed UI/backend fixture evidence. This does not claim live vendor execution.")
    await page.getByRole("button", { name: "Record outcome", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    await page.locator("#view").getByText("Execution: verified_complete", { exact: false }).waitFor()
    const completed = orchestrator.load().tasks.find((task) => task.task_id === assigned.task_id)
    assert.equal(completed.execution_state, "verified_complete")
    assert.equal(completed.delivery_state, "queued", "Task evidence does not fabricate host acceptance")
    assert.equal(completed.evidence[0].criterion, criterion)
    assert.equal(completed.evidence[0].passed, true)
    assert.equal(completed.review.outcome, "accepted")
    await page.screenshot({ path: `.verification/${prefix}-task-complete.png`, fullPage: true })
    await page.locator("#taskBack").click()
    await page.locator("#taskSearch").waitFor()
    assert.equal(await page.locator('#taskSearch input[name="query"]').inputValue(), taskTitle)
    await orchestrator.withLock(() => {
      const state = orchestrator.load()
      for (let i = 0; i < 130; i++)
        pushEvent(state, {
          type: "browser-check",
          kind: "orchestration",
          message: "pagination " + i,
          node_id: null,
          agent_id: null,
          task_id: null,
        })
      orchestrator.save(state)
    })
    await page.locator('[data-nav="activity"]').click()
    await page.locator("#olderBtn").waitFor()
    const first = await page.evaluate(() => activityCursor)
    await page.locator("#olderBtn").click()
    await page.waitForFunction((old) => activityCursor > old, first)
    assert.equal(await page.evaluate(() => new Set(activityRows.map((e) => e.seq)).size === activityRows.length), true)
    const cursor = await page.evaluate(() => activityCursor)
    const count = await page.evaluate(() => activityRows.length)
    await appendEvent(orchestrator, prefix + " live refresh retained cursor")
    await refresh(page)
    assert.ok((await page.evaluate(() => activityCursor)) > cursor)
    assert.ok((await page.evaluate(() => activityRows.length)) > count)
    assert.equal(await page.evaluate(() => new Set(activityRows.map((e) => e.seq)).size === activityRows.length), true)
    await page.locator('[data-nav="context"]').click()
    await page.locator("#addContext").click()
    await page.locator('#modalForm [name="title"]').fill(prefix + " finding")
    await page.locator('#modalForm [name="body"]').fill("Scoped browser evidence record")
    await page.getByRole("button", { name: "Record", exact: true }).click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    await page.getByRole("heading", { name: prefix + " finding", exact: true }).waitFor()
    await page.locator('#contextSearch input[name="query"]').fill(prefix + " finding")
    await page.locator("#contextSearch").getByRole("button", { name: "Search", exact: true }).click()
    await appendEvent(orchestrator, "context query refresh")
    await refresh(page)
    assert.equal(await page.locator('#contextSearch input[name="query"]').inputValue(), prefix + " finding")
    await page.getByRole("heading", { name: prefix + " finding", exact: true }).waitFor()
    await page.locator("#emergencyBtn").click()
    await page.getByRole("button", { name: "Stop coordination", exact: true }).last().click()
    await page.locator("#modalForm").waitFor({ state: "detached" })
    assert.equal(
      Object.values(store.load().channels).every((c) => c.paused),
      true,
    )
    await page.screenshot({ path: `.verification/${prefix}-workflows.png`, fullPage: true })
    assert.deepEqual(errors, [], "Uncaught UI errors")
    evidence.push({
      surface: prefix,
      result: "passed",
      task_id: assigned.task_id,
      checks: [
        "create",
        "unsupported folder picker capability disables HTTP only",
        "join query",
        "remove persisted",
        "save",
        "saved tab refresh",
        "resume",
        "diagnostics navigation",
        "unsupported GUI Updates visibly provides CLI recovery",
        "integration onboarding stages and unverified round trip",
        "missing-catalog disabled",
        "team template save and refresh without launch",
        "linked preparation with persisted budgets",
        "unconfigured isolated worktree option disabled with recovery",
        "template delete preserves sessions",
        "three-member targeted task assignment",
        "running and review transitions",
        "unverified completion rejected",
        "criterion evidence and independent review completion",
        "task filter and detail refresh",
        "pagination cursor refresh",
        "context query refresh",
        "emergency pause",
      ],
      uncaught_errors: errors,
    })
    await page.close()
    if (native === false)
      await fetch(base + "/api/emergency-stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      })
  }
  writeFileSync(
    ".verification/browser-workflows.json",
    JSON.stringify(
      {
        version: VERSION,
        node: process.version,
        browser: browser.version(),
        at: new Date().toISOString(),
        evidence,
        limits:
          "Native seam emulation verifies UI routing and persisted backend only; no packaged desktop, authenticated vendor host or external attack behavior. Managed workers are persisted fixtures and are never launched.",
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify(evidence))
} finally {
  await browser.close()
  await server.close()
  rmSync(root, { recursive: true, force: true })
}
