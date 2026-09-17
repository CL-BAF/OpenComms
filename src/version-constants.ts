/**
 * The single static fallback version — imported by src/version.ts AND
 * src/cli/paths.ts so the release number can never drift between the two
 * resolvers (Reviewer P3, 2026-09-15: two hand-synced copies was the drift
 * class that bit the 1.2.0 bump). Bump HERE only, in lockstep with
 * package.json (which the release tooling derives).
 */
export const FALLBACK_VERSION = "1.2.0"
