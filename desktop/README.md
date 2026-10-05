# OpenComms Tauri desktop

The Tauri v2 shell loads the same offline console as the browser build from
`dist-shell`. It communicates with the Node coordinator through newline
delimited JSON over the child's stdin/stdout. It does not load a loopback
webpage or expose a generic IPC-to-HTTP proxy.

The Rust host permits only `ALLOWED_COMMANDS` in
`src-tauri/src/main.rs`. Its operation set must match
`src/orchestrator/bridge.ts`; the TypeScript bridge forwards each named
operation to the same backend used by the browser. Backend validation,
project boundaries and owner approval tokens also apply to native requests.
The folder picker returns a candidate directory; the backend validates it.

On the first request the shell starts the bundled coordinator beside the
executable. Development builds may use `node dist/cli/main.js bridge`
from this checkout. Release builds fail with repair instructions when their
sidecar is missing; they do not use a machine-specific build directory.
The sidecar announces its identity, protocol and operation allowlist before
any operation is sent. The shell kills and reaps it on an invalid handshake.

Native handshake reads have an independent 10 second deadline. Operation
writing and response reading share a 120 second deadline. Frames are bounded
and response identifiers must match the originating request. Bridge failures
discard the connection; a later explicit request reconnects. An operation
with an uncertain result is not automatically retried. Check persisted state
before retrying a mutation. Native errors include a request identifier,
operation and whether execution was prevented or the outcome is unknown.

The blocking pipe work runs outside the webview thread. On shell exit the
coordinator child is killed and reaped. Connection logs contain no request
bodies and live under the per-user `OpenComms/bridge-runtime/logs` directory.
The webview has no shell or filesystem permission grant. Its CSP permits
the bundled assets and the Tauri IPC origin only.

## Build and launch

Windows builds require Node.js, a stable Rust toolchain, Visual Studio C++
Build Tools and WebView2. Linux requires the Tauri WebKit/GTK prerequisites.

From the repository root:

```powershell
npm ci
npm run build
node scripts/build-shell-asset.mjs
```

Then from `desktop`:

```powershell
npm ci
npm run tauri dev
```

For a release build, first produce the target-specific coordinator sidecar
using the repository's release scripts, then run `npm run tauri build` in
`desktop`. See the root build documentation for executable and installer
requirements. Never publish a release without separately testing its
packaged executable and installer on Windows.

## Verification

```powershell
# Repository root
npm run build:test
node --test dist-test/test/unit/core/bridge-parity.test.js
node scripts/build-shell-asset.mjs
node scripts/test-native-assets.mjs
node scripts/test-browser-workflows.mjs

# desktop/src-tauri
cargo fmt --check
cargo test
cargo check
```

The bridge test checks Rust/TypeScript allowlist parity, every visible route's
named operation, native create/stop/restart/assign/remove routing, framing,
correlation and exception redaction. Its packaged sidecar probe is skipped
when the Windows executable is absent. When present, the probe checks the
handshake acknowledgement, response correlation and runtime discovery.
Unavailable hosts must report a typed capability state and recovery guidance;
an unknown command or protocol error fails the gate.

The browser workflow gate requires Playwright and Chrome. Set
`OPENCOMMS_PLAYWRIGHT_PATH` to an installed Playwright `index.mjs` when it is
outside this repository's dependencies. It exercises the real persisted
backend through HTTP and a native IPC seam, including task evidence/review,
team plans, disabled capabilities and refresh preservation. It writes its
report and screenshots to `.verification`. The seam uses persisted test
workers and never launches an authenticated vendor host.

The asset gate checks the generated document, external JavaScript, hashes,
version, CSP and named IPC references. Neither these checks nor the browser
seam establish live host interoperability or verify the Tauri installer.

This upgrade environment has Node.js and Windows. A coordinator sidecar was
built separately after initial inspection. The Rust toolchain and packaged
Tauri executable remain unavailable. Rust compilation, Rust unit tests,
native WebView workflows and packaged desktop/installer smoke checks still
require those prerequisites. Skipped checks are not successful verification.
