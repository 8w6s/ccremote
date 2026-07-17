# Contributing

Read [DOCS.md](DOCS.md) before changing behavior. It is the normative architecture and interaction contract.

## Development

1. Use Node.js 22 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` only for local integration testing.
4. Keep `.env`, state, transcripts, and attachments out of Git.
5. Run `npm run check` before opening a pull request.

Every behavior change should include a regression test. Changes to Claude tool schemas must cite official documentation or include a sanitized observed runtime shape. Do not guess optional protocol fields.

Pull requests must not restart or deploy another user's running bot. Integration tests belong in a dedicated staging guild.
