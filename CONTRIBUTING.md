# Contributing

1. Use Node.js 22 or newer.
2. Copy `.env.example` to `.env` and use test credentials only.
3. Run `npm ci`, `npm run check`, and `npm test` before opening a change.
4. Never commit candidate data, resumes, transcripts, logs, or provider credentials.
5. Add tests for storage migrations, provider adapters, and interview state changes.

Keep the default deployment local-only. Features for remote or multi-user deployment
must include authentication, origin validation, and a documented privacy model.
