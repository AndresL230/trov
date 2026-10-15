repo: AndresL230/trov
branch: main
path: web/src

## Last sync
date: 2026-10-14T22:43:47Z

### Updated in this project
- Code, CI & deploys, Usage › Product and Planning tabs pulled from repo.ts with repo-sample.ts data
- App shell (sidebar, header, tab bar, panel) rebuilt from sidebar.ts, render.ts, repo.ts and trov.css tokens
- Repo screen redesigned for every repo setup: apps, targets, deploys, releases, seven layout rules
- Org settings › Repositories › Apps setup flow

## Screen map
| Screen | Repo files |
| --- | --- |
| Sidebar.dc.html | web/src/sidebar.ts, web/src/org-picker.ts, web/src/org-logo.ts, shared/mark.ts, web/src/trov.css |
| RepoScreen.dc.html | web/src/repo.ts, web/src/render.ts (header), web/src/tabs.ts, web/src/segmented.ts, web/src/trov.css |
| Mark.dc.html | web/src/marks.ts |
| EnvCard, DriftStrip, NotShipped, UsageTarget | web/src/repo.ts (overviewTab, ciTab, usageEnv) |
| AppsTable, ProductionCard, PreviewsList, ReleaseBlock, NeedsAttention, FoundApps, ScopeMenu | new; styled from web/src/repo.ts, web/src/dropdown.ts, web/src/trov.css |
| OrgSetup.dc.html | web/src/org-settings.ts, web/src/org-ui.ts, web/src/confirm.ts |
| Repo Screen Redesign / Repo Scenarios A-G / H-N / Phone and Dark / Setup | canvas pages composing the above |
