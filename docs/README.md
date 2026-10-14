# Documentation

Everything about how Oh My Days is meant to work, how it was built, and how to
run it. **Current** documents describe the product as released (2.0.0); a
**record** is a plan or check kept as written, with a status line saying what
became of it.

## Product

| Document | What it holds | Kind |
|---|---|---|
| [Product specification](specs/oh-my-days.md) | Scope, behaviour, data rules, and acceptance scenarios. The source of truth | Current |
| [Product context](../PRODUCT.md) | Platform, users, principles, and open decisions in brief | Current |
| [Acceptance matrix](acceptance.md) | Each acceptance scenario and validation item with its evidence | Current |
| [Capacity](capacity.md) | Measured CPU, D1, and request use against the free tiers | Current |

## Design and identity

| Document | What it holds | Kind |
|---|---|---|
| [Identity](identity/oh-my-days.md) | Name, voice, copy rules, logo, and the repository banner | Current |
| [Logo files](identity/logo/) | Mark, lockups, avatar, and banner (SVG and PNG); superseded concepts in `archive/` | Current |
| [Experience brief](design/experience.md) | Telegram flows, connection pages, and the Mini App's layout and behaviour | Current |
| [Screenshots](screenshots/) | Mini App captures with synthetic data, used in the README | Current |

## Engineering

| Document | What it holds | Kind |
|---|---|---|
| [Backend plan](plans/backend.md) | Architecture, data model, and delivery gates; §10 is the implementation record | Current (§10), record (plan) |
| [Architecture decisions](adr/) | Leases and guarded batches, custom domain and OAuth, recurring occurrences, next-due trigger, Mini App sign-in | Current |
| [Improvement plan](plans/improvements.md) | The post-beta improvements, all released in 2.0.0 | Record |
| [Connection-page plan](plans/connection-pages.md) | Layout and states of the Google connection pages, as built | Record |
| [Stage 0 feasibility](feasibility/stage-0.md) | Checks made before anything was provisioned | Record |

## Running it

| Document | What it holds | Kind |
|---|---|---|
| [Deploy runbook](runbooks/deploy.md) | Deploying, secrets, webhook, Mini App setup, releasing a version, rollback | Current |
| [Operations runbook](runbooks/operations.md) | Restore, data deletion, and recovery drills | Current |
| [Changelog](../CHANGELOG.md) | What changed in each release | Current |
| [AGENTS.md](../AGENTS.md) | Rules for contributors and coding agents | Current |
