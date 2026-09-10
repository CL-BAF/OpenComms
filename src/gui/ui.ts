/**
 * OpenComms GUI — single-page frontend (v1, work order 2026-09-08).
 *
 * Visual direction (per spec): very dark greys (#111111 page, #1c1c1c
 * cards, #272727 nested, #333333 borders), near-white text, muted grey
 * secondary; colour ONLY for member states (Working / Idle / Offline).
 * No bright dashboard RGB.
 *
 * Provider-independent: every action talks to /api/sessions* (the same
 * provider-neutral backend the CLI uses). The join command shown is the
 * REAL one for the selected host (never fabricated).
 */

export const GUI_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OpenComms</title>
<style>
  :root {
    --page: #111111; --card: #1c1c1c; --nested: #272727; --border: #333333;
    --text: #e8e8e8; --secondary: #9a9a9a;
    --working: #c2a36b; --idle: #7fa878; --offline: #a86b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--text); font: 14px/1.5 "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; }
  h1 span { color: var(--secondary); font-weight: 400; }
  button { background: var(--nested); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  button:hover { border-color: #4a4a4a; }
  button.danger { color: #d99a9a; }
  button.primary { border-color: #555; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; cursor: pointer; }
  .card:hover { border-color: #4a4a4a; }
  .card h3 { margin: 0 0 4px; font-size: 15px; }
  .card .desc { color: var(--secondary); min-height: 20px; }
  .card .meta { color: var(--secondary); font-size: 12px; margin-top: 8px; }
  .agents-line { color: var(--secondary); font-size: 12px; margin-top: 6px; }
  .section { color: var(--secondary); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin: 22px 0 8px; }
  .detail { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
  .detail h2 { margin: 0 0 4px; font-size: 17px; }
  .nested { background: var(--nested); border: 1px solid var(--border); border-radius: 8px; padding: 12px; margin: 10px 0; }
  .cmd { font-family: Consolas, monospace; font-size: 12.5px; color: var(--text); word-break: break-all; user-select: all; }
  .row { display: flex; gap: 8px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
  .agent { display: flex; align-items: center; justify-content: space-between; background: var(--nested); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
  .agent .who { color: var(--secondary); font-size: 12px; }
  .state { font-size: 12px; border-radius: 10px; padding: 2px 10px; border: 1px solid var(--border); }
  .state.Working { color: var(--working); }
  .state.Idle { color: var(--idle); }
  .state.Offline { color: #a86b6b; }
  .muted { color: var(--secondary); }
  input[type=text] { background: var(--nested); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 7px 10px; font-size: 14px; width: 240px; }
  select { background: var(--nested); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }
  .toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); background: var(--nested); border: 1px solid var(--border); color: var(--text); padding: 10px 18px; border-radius: 8px; display: none; }
  a.back { color: var(--secondary); text-decoration: none; cursor: pointer; }
  .lifecycle { font-size: 11px; border-radius: 10px; padding: 2px 8px; border: 1px solid var(--border); color: var(--secondary); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>OpenComms <span>— local session console</span></h1>
    <button id="newBtn" class="primary">+ New Session</button>
  </header>
  <div id="view" class="wrap" style="padding:0"></div>
</div>
<script>
const $ = (sel) => document.querySelector(sel);
let currentDetail = null;
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  return res.json();
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const toast = (msg) => {
  const t = document.createElement("div");
  t.className = "toast"; t.style.display = "block"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
};

async function renderMain() {
  currentDetail = null;
  const payload = await (await fetch("/api/sessions")).json();
  const live = payload.data.live, archived = payload.data.archived;
  const card = (title, agents, desc, meta, onClick, badge) => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = '<h3>' + esc(title) + '</h3>' +
      '<div class="desc">' + esc(desc) + '</div>' +
      '<div class="agents-line">' + esc(agents) + '</div>' +
      '<div class="meta">' + esc(meta) + '</div>';
    el.onclick = () => renderDetail(title);
    return el;
  };
  let html = "";
  html += '<div class="section">Active sessions</div><div class="grid" id="liveGrid"></div>';
  html += '<div class="section">Saved sessions</div><div class="grid" id="archGrid"></div>';
  $("#view").innerHTML = html;
  const liveGrid = $("#liveGrid");
  if (live.length === 0) liveGrid.innerHTML = '<div class="muted">No active sessions. Create one or resume an archive.</div>';
  for (const s of live) {
    const el = document.createElement("div");
    el.className = "card";
    const agentList = s.agents.map((a) => a.role).join(", ");
    el.innerHTML = '<h3>' + esc(s.name) + (s.paused ? ' <span class="lifecycle">paused</span>' : '') + '</h3>' +
      '<div class="muted">' + esc(s.description) + '</div>' +
      '<div class="agents-line">' + esc(s.agents.length + "/" + s.max_members + " agents") + '</div>' +
      '<div class="meta">' + esc(s.agents.map((a) => a.role).join(", ")) + '</div>';
    el.onclick = () => renderDetail(s.name);
    liveGrid.appendChild(el);
  }
  const archGrid = $("#archGrid") || document.createElement("div");
  archGrid.className = "grid";
  $("#view").appendChild(archGrid);
  for (const a of payload.data.archived) {
    const el = document.createElement("div");
    el.className = "card";
    const date = new Date(a.saved_at).toISOString().slice(0, 10);
    el.innerHTML = '<h3>' + esc(a.name) + ' <span class="lifecycle">saved ' + esc(date) + '</span></h3>' +
      '<div class="muted">' + esc(a.description || "No description yet") + '</div>' +
      '<div class="agents-line">' + esc(a.member_count + " agents | " + a.message_count + " messages") + '</div>';
    el.onclick = () => renderDetail(a.name);
    archGrid.appendChild(el);
  }
}

async function renderDetail(name) {
  currentDetail = name;
  const payload = await (await fetch("/api/sessions/" + encodeURIComponent(name) + "/members")).json();
  if (!payload.ok) { $("#view").innerHTML = '<p class="muted">' + esc(payload.message) + '</p>'; return; }
  const d = payload.data;
  const saved = d.lifecycle === "saved";
  let html = '<p><a class="back" onclick="renderMain()">← all sessions</a></p>';
  html += '<div class="detail">';
  html += '<h2>' + esc(d.name) + (saved ? ' <span class="lifecycle">SAVED</span>' : '') + '</h2>';
  html += '<div class="muted">' + esc(d.description) + '</div>';
  html += '<div class="section">Join command (pick a host)</div>';
  html += '<div class="nested"><div class="row"><select id="hostSel">' +
    ["opencode","claude-code","codex","claude-desktop","chatgpt"].map((h) => '<option>' + h + '</option>').join("") +
    '</select><button id="copyBtn">Copy</button></div>' +
    '<div class="row muted" id="whereTxt"></div>' +
    '<div class="cmd" id="cmdTxt" style="margin-top:8px"></div></div>';
  html += '<div class="section">Agents (' + esc(String(d.agents.length)) + (d.max_members ? '/' + esc(String(d.max_members)) : '') + ')</div>';
  html += '<div id="agentList"></div>';
  if (saved) {
    html += '<div class="section">Archive</div><div class="nested muted" id="summary"></div>';
    html += '<div class="row"><button id="resumeBtn">Resume as new session</button></div>';
  } else {
    html += '<div class="row" style="margin-top:18px"><button id="saveBtn">Save Session</button>' +
      '<button class="danger" id="deleteBtn">Delete Session</button></div>';
  }
  html += '</div>';
  $("#view").innerHTML = html;

  const agentList = $("#agentList");
  for (const a of d.agents) {
    const row = document.createElement("div");
    row.className = "agent";
    row.innerHTML = '<div><div>' + esc(a.role) + '</div><div class="who">' +
      esc(a.session_id + " | " + a.host + " | " + a.delivery_mode) + '</div></div>' +
      '<div style="display:flex;gap:10px;align-items:center">' +
      '<span class="state ' + esc(a.state) + '">' + esc(a.state) + '</span>' +
      (saved ? "" : '<button class="rm">Remove</button>') + '</div>';
    if (!saved) {
      row.querySelector(".rm").onclick = async (e) => {
        e.stopPropagation();
        if (!confirm("Remove " + a.role + " from OpenComms? (Its provider process is NOT terminated)")) return;
        const r = await fetch("/api/sessions/" + encodeURIComponent(name) + "/members/remove", {
          method: "POST", body: JSON.stringify({ target_session_id: a.session_id })
        }).then((r) => r.json());
        toast(r.message); renderDetail(name);
      };
    }
    agentList.appendChild(row);
  }
  if (saved && $("#summary")) $("#summary").textContent = d.summary || "(no summary recorded)";

  async function loadCmd() {
    const host = $("#hostSel").value;
    const r = await (await fetch("/api/sessions/" + encodeURIComponent(name) + "/join-command?host=" + host)).json();
    $("#whereTxt").textContent = r.data ? r.data.where : r.message;
    $("#cmdTxt").textContent = r.data ? r.data.command : "";
  }
  $("#hostSel").onchange = loadCmd; loadCmd();
  $("#copyBtn").onclick = async () => {
    try { await navigator.clipboard.writeText($("#cmdTxt").textContent); toast("Join command copied"); }
    catch { toast("Copy failed — select the text manually"); }
  };
  if (!saved) {
    $("#saveBtn").onclick = async () => {
      const summary = prompt("Structured summary for future agents (purpose, decisions, completed work, known issues). Leave empty to skip:");
      if (summary === null) return;
      const r = await fetch("/api/sessions/" + encodeURIComponent(name) + "/save", { method: "POST", body: JSON.stringify({ summary }) }).then((r) => r.json());
      toast(r.message); renderMain();
    };
    $("#deleteBtn").onclick = async () => {
      if (!confirm("DELETE session '" + name + "' permanently (no future context)?")) return;
      const r = await fetch("/api/sessions/" + encodeURIComponent(name), { method: "DELETE" }).then((r) => r.json());
      toast(r.message); renderMain();
    };
  } else {
    $("#resumeBtn").onclick = async () => {
      const newName = prompt("New session name (blank = same name):") ?? "";
      const r = await fetch("/api/sessions/" + encodeURIComponent(name) + "/resume", { method: "POST", body: JSON.stringify({ new_name: newName }) }).then((r) => r.json());
      toast(r.message); renderMain();
    };
  }
}

$("#newBtn").onclick = () => {
  const name = prompt("Session name (lowercase letters/digits/-/_):");
  if (!name) return;
  fetch("/api/sessions", { method: "POST", body: JSON.stringify({ name }) }).then((r) => r.json()).then((r) => {
    toast(r.message); renderMain();
  });
};

const es = new EventSource("/api/events");
es.addEventListener("refresh", () => { currentDetail ? renderDetail(currentDetail) : renderMain(); });
// Reconnect = the stream died or the server restarted: refetch immediately
// so the console NEVER shows stale data after a connection interruption.
es.addEventListener("open", () => { currentDetail ? renderDetail(currentDetail) : renderMain(); });
renderMain();
</script>
</body>
</html>`
