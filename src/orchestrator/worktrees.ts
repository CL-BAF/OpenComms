/** Explicit managed isolation; linked sessions and worktrees are never moved. */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"

function git(source: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch {
    throw new Error(
      "Git did not confirm the requested isolated worktree operation; check Git availability, repository HEAD and retained worktree path.",
    )
  }
}
function within(source: string, target: string): boolean {
  const suffix = relative(source, target)
  return suffix.length > 0 && !suffix.startsWith("..") && !isAbsolute(suffix)
}

/** Creates a detached checkout of source HEAD; local uncommitted edits are not copied. */
export function createManagedWorktree(projectDir: string, worktree: string): void {
  const source = realpathSync(resolve(projectDir))
  const target = resolve(worktree)
  if (!within(source, target)) throw new Error("Managed worktree target must stay inside the selected project.")
  if (realpathSync(git(source, ["rev-parse", "--show-toplevel"])) !== source)
    throw new Error("Isolated managed creation requires selecting the Git repository root.")
  const head = git(source, ["rev-parse", "--verify", "HEAD^{commit}"])
  if (!/^[a-f0-9]{40,64}$/i.test(head))
    throw new Error("Git source HEAD is unavailable; an isolated worktree was not created.")
  if (existsSync(target)) throw new Error("Managed worktree path already exists; no files were replaced.")
  let ancestor = dirname(target)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const resolvedAncestor = realpathSync(ancestor)
  if (resolvedAncestor !== source && !within(source, resolvedAncestor))
    throw new Error("Managed worktree parent resolves outside the selected project.")
  mkdirSync(dirname(target), { recursive: true })
  if (!within(source, realpathSync(dirname(target))))
    throw new Error("Managed worktree parent resolves outside the selected project.")
  git(source, ["worktree", "add", "--detach", target, head])
  if (!existsSync(resolve(target, ".git")) || git(target, ["rev-parse", "HEAD"]) !== head)
    throw new Error("Git worktree creation could not be verified; its files were retained for inspection.")
}
