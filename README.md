# Oh My Days

A little less to keep in your head.

A private Telegram scheduling and task assistant, with Google Calendar as the
calendar interface. Under construction: the Telegram foundation, safe-operation
core, and Google Calendar connection and setup exist and are tested locally.
Events, tasks, and reminders are not implemented yet, and nothing is deployed.

- [Product specification](docs/specs/oh-my-days.md)
- [Backend architecture and build order](docs/plans/backend.md)
- [Connection-page implementation plan](docs/plans/connection-pages.md)
- [Application identity](docs/identity/oh-my-days.md)
- [Telegram and connection-page experience](docs/design/experience.md)
- [Product context](PRODUCT.md)
- [Contributor and agent instructions](AGENTS.md)

Work happens in `feature/<purpose>` or `bugfix/<purpose>` branches from
`develop`, with incremental commits.
Never commit directly to `main` or `master`, and never push without specific approval.

## Development

Requires Node.js 24+. Everything below runs locally; no Cloudflare, Google, or
Telegram account is needed for tests.

```sh
npm ci
cp .dev.vars.example .dev.vars   # local secrets; never commit .dev.vars
npm run check                    # lint + typecheck + tests
```

| Command | Purpose |
|---|---|
| `npm run lint` | Biome lint and formatting check (`npm run format` fixes) |
| `npm run typecheck` | TypeScript strict type check |
| `npm test` | Vitest inside the Workers runtime with a local D1 (unit and integration) |
| `npm run db:migrate:local` | Apply `migrations/` to the local D1 used by `wrangler dev` |
| `npm run dev` | Local Worker at `http://localhost:8787` |

Configuration lives in `wrangler.jsonc` (non-secret `vars`) and Worker secrets;
`.dev.vars.example` lists every setting. The production origin is
`https://ohmydays.xinweichong.com` ([ADR 0002](docs/adr/0002-custom-domain-and-oauth-verification.md)).
Set `CONTACT_EMAIL` to show a contact address in the privacy policy.

Tests reset and re-migrate the local database before each test and use fake
clocks, IDs, and provider clients. Real-account smoke tests are separate and need
explicit authorization.
