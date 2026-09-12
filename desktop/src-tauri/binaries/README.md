SPIKE placeholder (M0, disposable) — NOT the real coordinator.

This file exists only so `bundle.externalBin` validates during the Tauri
spike build. It is a copy of a local debug binary standing in for the real
Node coordinator sidecar that Platform/Backend will produce (per-triple
renamed Node bundle: docs/research/m1-m2-runtimes-packaging-secrets.md,
official guide https://v2.tauri.app/learn/sidecar-nodejs/).

Never shipped; replaced in M1 by the real per-triple coordinator artifact.