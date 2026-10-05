# Coordinator sidecar

The v1.5.0 Tauri shell requires the coordinator built from the same release source. Binary files are generated and gitignored; this directory contains no committed executable.

Build the portable coordinator with the pinned Node 22.14.0 toolchain, then place it under the target-specific name expected by `bundle.externalBin`, for example `opencomms-coordinator-x86_64-pc-windows-msvc.exe` on Windows.

Before packaging, check the sidecar's reported version, checksum, handshake identity, protocol and command allowlist. Generate checksums from the actual release artifacts rather than retaining a checksum from an older build. The bridge probe checks routing and protocol behavior; authenticated vendor sessions and packaged WebView/installer behavior require separate verification.
