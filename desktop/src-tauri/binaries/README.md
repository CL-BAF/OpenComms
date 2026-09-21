Coordinator sidecar binary (real, release-intended).

`opencomms-coordinator-x86_64-pc-windows-msvc.exe` is the OpenComms SEA
coordinator built by Platform from the pinned 22.14.0 Node toolchain,
per-triple named for Tauri `bundle.externalBin`
(docs/research/m1-m2-runtimes-packaging-secrets.md, official guide
https://v2.tauri.app/learn/sidecar-nodejs/).

CURRENT INTEGRATION (v1.4.0): SHA256
5700AF1A7F87E6527E774AD900A20AA83E895EA81D3A3E298C0821B71F941753
(identical to the release exe — one reproducible binary). Verified by
Builder via Get-FileHash (exact match) + live bridge probe: handshake
announces runtimes_list + integrations_list, nodes_list -> runtimes_list
returns ok (test/unit/core/bridge-parity.test.ts — the CI drift gate for
this exact failure class; the stale 1.2.0 binary answered the handshake
without runtimes_list).

Prior integration (v1.2.0): SHA256
3B9771097706F9BF604A3EF9054F8C9EE8426E974C4D22C33215D64854D6A583
— superseded by the 1.4.0 build (missing runtimes_list; root cause of the
"coordinator missing IPC command" refusal). Prior to that (v1.1.0-gui):
31351EBD…4FF4. Platform's formal .sha256 sidecar from build-release.mjs is the
release trail; a mismatch between that and the hash above = drift, escalate.

The file itself is gitignored (`binaries/*.exe`) — release pipelines
produce and place it; the repo carries this README as its provenance note.