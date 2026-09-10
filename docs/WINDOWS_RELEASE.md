# Windows release

Normal Windows users should download the clearly named `OpenComms-Setup-x.y.z.exe`
from the release artifacts. It is an Inno Setup 6 per-user installer: the
default destination is `%LOCALAPPDATA%\Programs\OpenComms`, a Start Menu entry
and desktop shortcut are enabled by default, and the OpenComms icon is included.
The optional user-PATH integration is opt-in.

The installed shortcuts run `OpenComms.vbs gui` through `wscript.exe`, so no
console window is required. The GUI is an embedded offline HTML/CSS/JavaScript
frontend served by the local loopback backend. It restores a valid recent
project or presents a project picker; it never uses the install directory as a
project merely because the shortcut was launched there.

Build on Windows with Node 22.14.0 and Inno Setup 6.4.x:

```text
npm ci
npm run build:release
npm run test:windows-release
```

The output is `dist-release/`, containing `opencomms.exe`,
`OpenComms-Setup-x.y.z.exe`, and the executable SHA-256 checksum. The release
smoke test installs into an isolated temporary directory, checks both shortcut
targets and arguments, starts the installed GUI over loopback, uninstalls it,
and verifies a separate project `.opencomms` state file is unchanged.

Uninstall removes the installed application and shortcuts. It does not remove
any project-local `.opencomms` state or archives.
