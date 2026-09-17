Coordinator sidecar binary (real, release-intended).

`opencomms-coordinator-x86_64-pc-windows-msvc.exe` is the OpenComms SEA
coordinator built by Platform from the pinned 22.14.0 Node toolchain,
per-triple named for Tauri `bundle.externalBin`
(docs/research/m1-m2-runtimes-packaging-secrets.md, official guide
https://v2.tauri.app/learn/sidecar-nodejs/).

CURRENT INTEGRATION (v1.2.0): SHA256
3B9771097706F9BF604A3EF9054F8C9EE8426E974C4D22C33215D64854D6A583
(identical to the release exe — one reproducible binary). Verified by
Frontend at re-integration: `version` answers 1.2.0, standalone
`gui --port N --server` serves the full 7-route console + orchestrator API
(diagnostics healthy 1.2.0, nodes/agents/trust ok, `designated` present on
every agents item), `doctor` runs.

Prior integration (v1.1.0-gui): 31351EBD…4FF4 — superseded by the 1.2.0
build. Platform's formal .sha256 sidecar from build-release.mjs is the
release trail; a mismatch between that and the hash above = drift, escalate.

The file itself is gitignored (`binaries/*.exe`) — release pipelines
produce and place it; the repo carries this README as its provenance note.