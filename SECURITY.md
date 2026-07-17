# Security policy

## Reporting a vulnerability

Do not publish credentials, transcripts, filesystem paths, or exploitable details in a public issue. Contact the maintainer privately through the security contact on the GitHub profile. Include the affected version, impact, reproduction steps, and a minimal sanitized payload.

## Supported versions

Security fixes target the latest release. Self-hosters should update Claude Code, Node.js, and clauderemote together after reviewing release notes.

## Security boundary

clauderemote executes the local Claude Code CLI with the permissions of its operating-system account. Discord authorization, allowed cwd roots, Claude permission mode, and host isolation all matter. `bypassPermissions` is intentionally dangerous. Never expose the bot to an untrusted guild or reuse its token.

Never commit `.env`, local state, Claude JSONL transcripts, temporary attachments, logs, PID files, or API tokens. Rotate a token immediately if it is exposed.
