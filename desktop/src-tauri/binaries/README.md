Coordinator sidecar binary (real, release-intended).

`opencomms-coordinator-x86_64-pc-windows-msvc.exe` is the OpenComms SEA
coordinator built by Platform from the pinned 22.14.0 Node toolchain,
per-triple named for Tauri `bundle.externalBin`
(docs/research/m1-m2-runtimes-packaging-secrets.md, official guide
https://v2.tauri.app/learn/sidecar-nodejs/).

Verified by Frontend at integration: `version` answers, standalone
`gui --port N --server` serves the full 7-route console and the orchestrator
API, `doctor` runs. SHA256 at integration:
31351EBD7C214B911DCDF1E6E892D352F181F9280A050B9F4FB1C793F9334FF4
(Platform's formal .sha256 sidecar from build-release.mjs is the release
trail; a mismatch between that and the hash above = drift, escalate).

The file itself is gitignored (`binaries/*.exe`) — release pipelines
produce and place it; the repo carries this README as its provenance note.