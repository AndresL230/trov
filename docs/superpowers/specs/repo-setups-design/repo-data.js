// Trov · Repo screen for every repo setup — scenario data and the layout rules.
// One engine: raw facts per scenario (apps, environments, targets, deploys) go in, and
// `buildScreen` decides the Overview's layout from those facts alone. Nothing is chosen at
// view time; the same data always draws the same screen.

const G = 'var(--green)', AM = 'var(--amber)', RD = 'var(--red)', N = 'var(--fg-55)', BL = 'var(--blue)', OFF = 'var(--fg-40)', AC = 'var(--accent)';

export const MARKS = {
  healthy: { shape: 'dot', tone: G, word: 'Healthy', tip: 'Checks pass on the branch head and every app here is live.' },
  degraded: { shape: 'triangle', tone: AM, word: 'Degraded', tip: 'Checks are failing on the branch head.' },
  failing: { shape: 'diamond', tone: RD, word: 'Failing', tip: 'A deploy here failed.' },
  down: { shape: 'square', tone: RD, word: 'Down', tip: 'Its health check gets no answer.' },
  unknown: { shape: 'ring', tone: N, word: 'Unknown', tip: 'Trov has not seen a deploy here yet.' },
  outOfStep: { shape: 'triangle', tone: AM, word: 'Out of step', tip: 'Apps in this environment run different commits.' },
  queued: { shape: 'ring', tone: N, word: 'Queued', tip: 'Waiting for the host to start.' },
  building: { shape: 'ring', tone: BL, word: 'Building', pulse: true, tip: 'The host is building this commit now.' },
  live: { shape: 'dot', tone: G, word: 'Live', tip: 'Serving traffic.' },
  failed: { shape: 'diamond', tone: RD, word: 'Failed', tip: 'The deploy did not finish.' },
  cancelled: { shape: 'square', tone: OFF, word: 'Cancelled', tip: 'Stopped before it finished.' },
  superseded: { shape: 'square', tone: OFF, word: 'Superseded', tip: 'A newer deploy replaced it first.' },
  rolledBack: { shape: 'triangle', tone: AM, word: 'Rolled back', tip: 'Runs an older commit than the deploy before it.' },
  stale: { shape: 'ring', tone: N, word: 'No recent reading', tip: 'The source has not reported for over 30 minutes.' },
  waiting: { shape: 'triangle', tone: AM, word: 'Waiting', tip: 'Merged, not deployed yet.' },
  connected: { shape: 'dot', tone: G, word: 'Connected' },
  notConnected: { shape: 'ring', tone: N, word: 'Not connected' },
  accepted: { shape: 'check', tone: AC, word: 'Accepted' },
  ignored: { shape: 'square', tone: OFF, word: 'Ignored' },
  found: { shape: 'ring', tone: BL, word: 'Suggested' },
  // pull-request progress glyphs (marks.ts GLYPH)
  draft: { shape: 'g-todo', tone: N, word: 'Draft' },
  review: { shape: 'g-half', tone: BL, word: 'In review' },
  approved: { shape: 'g-most', tone: G, word: 'Approved' },
  merged: { shape: 'g-done', tone: AC, word: 'Merged' },
};
export const mark = (k, o) => Object.assign({}, MARKS[k], o || {});
export const shapeOnly = (k, o) => Object.assign({}, MARKS[k], { word: '' }, o || {});

export const PEOPLE = {
  andres: ['moss', 'Andres Lopez'], 'jose-a': ['moss', 'Jose Alvarez'], meilin: ['sky', 'Mei Lin'], 'dev-raj': ['plum', 'Dev Raj'],
  sanaok: ['rose', 'Sana Okafor'], 'priya-k': ['fern', 'Priya Kumar'], 'tom-h': ['rust', 'Tom Hale'], 'ana-r': ['slate', 'Ana Ruiz'], 'kenji-m': ['ochre', 'Kenji Mori'],
};
export const person = (h) => ({ handle: h, color: (PEOPLE[h] || ['stone'])[0], name: (PEOPLE[h] || [null, h])[1], initials: ((PEOPLE[h] || [null, h])[1] || h).split(/[\s-]/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() });

const ORGS = {
  sapling: { name: 'SaplingLearn', me: 'andres', repos: ['SaplingLearn/sapling', 'AndresL230/trov'] },
  acme: { name: 'Acme', me: 'priya-k', repos: ['acme/storefront', 'acme/platform', 'acme/payments', 'acme/ingest', 'acme/ui-kit', 'acme/core', 'acme/web-app', 'acme/web-api', 'acme/site', 'acme/dashboard'] },
  acmeNew: { name: 'Acme Labs', me: 'priya-k', repos: ['acme/new-thing', 'acme/mobile'] },
};

// ── the layout rules ─────────────────────────────────────────────────────────
export const RULES = {
  found: { id: 'R1', name: 'Found apps', opener: 'Found-apps card, then today’s pull requests, CI and figures', when: 'No app accepted yet, and the scan found at least one' },
  unseen: { id: 'R2', name: 'Nothing recognised', opener: '“Trov does not see deploys” card with what it does see, then pull requests, CI and figures', when: 'No app accepted, and the scan found nothing' },
  release: { id: 'R3', name: 'Release block', opener: 'Latest release, what has merged since, release cadence', when: 'Apps exist, and none has a target (packages only)' },
  production: { id: 'R4', name: 'Production card', opener: 'One Production card with its last 20 deploys, then the Previews list', when: 'One app with a target, one named environment' },
  chain: { id: 'R5', name: 'Promotion chain', opener: 'Environment cards in promotion order, one row each, with drift between each step', when: 'One app with a target, two or more named environments' },
  envCards: { id: 'R6', name: 'Environment cards', opener: 'Environment cards with a row per app, and drift when environments ship from different branches', when: '2 or 3 apps with targets, all in the same environments' },
  appsTable: { id: 'R7', name: 'Apps table', opener: 'A row per app; columns Production, then Previews (or the other environment), then Not shipped', when: '4 or more apps with targets, or apps whose environments differ' },
};

export function decide(s) {
  const apps = s.apps || [];
  if (!apps.length) return (s.found && s.found.apps.length) ? 'found' : 'unseen';
  const dep = apps.filter((a) => a.kind !== 'Package' && envsOf(s, a.name).length);
  if (!dep.length) return 'release';
  const sets = dep.map((a) => envsOf(s, a.name).join('|'));
  const same = sets.every((x) => x === sets[0]);
  if (dep.length === 1) return envsOf(s, dep[0].name).length <= 1 ? 'production' : 'chain';
  if (dep.length <= 3 && same) return 'envCards';
  return 'appsTable';
}
const envsOf = (s, app) => (s.envs || []).map((e) => e.name).filter((e) => (s.targets || []).some((t) => t.app === app && t.env === e));

// ── scenarios ────────────────────────────────────────────────────────────────
const D20 = (fails = [], extra = {}) => Array.from({ length: 20 }, (_, i) => extra[i] || (fails.includes(i) ? 'failed' : 'live'));

const SC = {
  A: (v) => {
    const oos = v === 'outOfStep', down = v === 'trouble';
    return {
      letter: 'A', title: 'Frontend and backend', org: 'sapling', repo: 'SaplingLearn/sapling',
      envs: [{ name: 'Staging', branch: 'main' }, { name: 'Production', branch: 'production' }],
      apps: [{ name: 'web', folder: 'web/', kind: 'Worker', host: 'Cloudflare', prs: 4 }, { name: 'api', folder: 'api/', kind: 'Service', host: 'Railway', prs: 3 }],
      targets: [
        { app: 'web', env: 'Staging', sha: '3e9a1f2', age: '26m', by: 'dev-raj', url: 'staging.saplinglearn.com', ms: 142 },
        down ? { app: 'api', env: 'Staging', sha: '3e9a1f2', age: '2m', by: 'dev-raj', url: 'api.staging.saplinglearn.com', state: 'building', prev: { sha: 'd94ea08', age: '21h' }, health: 'stale', staleFor: '34m' }
          : { app: 'api', env: 'Staging', sha: '3e9a1f2', age: '28m', by: 'dev-raj', url: 'api.staging.saplinglearn.com', ms: 88 },
        down ? { app: 'web', env: 'Production', sha: 'b4c21de', age: '2h', by: 'jose-a', url: 'saplinglearn.com', health: 'down', downFor: '6m' }
          : { app: 'web', env: 'Production', sha: 'b4c21de', age: '2h', by: 'jose-a', url: 'saplinglearn.com', ms: 131 },
        oos ? { app: 'api', env: 'Production', sha: '71f0e3a', age: '2d', by: 'meilin', url: 'api.saplinglearn.com', ms: 94, behind: { n: 3, of: 'web' } }
          : { app: 'api', env: 'Production', sha: 'b4c21de', age: '2h', by: 'jose-a', url: 'api.saplinglearn.com', ms: 94 },
      ],
      ci: { Staging: ['pass', 'All 14 checks passing on 3e9a1f2'], Production: ['pass', 'All 14 checks passing on b4c21de'] },
      drift: [{ from: 'main', to: 'production', ahead: 9, groups: [
        { tag: '#214', kind: 'pr', title: 'Tutor sessions resume from the last message', meta: 'meilin · merged 5h ago', commits: [['3e9a1f2', 'Resume tutor session from last message id', '5h'], ['9b02c4e', 'Store last message id on the session', '6h']] },
        { tag: '#212', kind: 'pr', title: 'Quiz timer drifts when the tab is hidden', meta: 'dev-raj · merged 1d ago', commits: [['a71d3f0', 'Use performance.now for the quiz timer', '1d'], ['4c8e912', 'Pause the timer on visibilitychange', '1d'], ['e2f6b07', 'Test: hidden tab keeps time', '1d']] },
        { tag: '#209', kind: 'pr', title: 'api: rate limit /tutor/ask per user', meta: 'jose-a · merged 2d ago', commits: [['5d1c8a4', 'Token bucket per user on /tutor/ask', '2d'], ['0e7f2b9', 'Return Retry-After on 429', '2d']] },
        { tag: 'Pushed', kind: 'direct', title: '2 commits pushed straight to main', meta: 'kenji-m, tom-h', commits: [['8a6e1d3', 'chore: bump wrangler 4.86', '1d'], ['c2b94f0', 'docs: staging seed notes', '2d']] },
      ] }],
      attention: oos ? [{ k: 'outOfStep', text: 'Production: api runs 71f0e3a, 3 commits behind web (b4c21de). Railway has not deployed api since the last promotion.', action: 'Open api on Railway', ext: true }]
        : down ? [{ k: 'down', text: 'Production: web is down. saplinglearn.com has not answered its health check for 6 minutes.', action: 'Open saplinglearn.com', ext: true },
          { k: 'stale', text: 'Staging: api’s health reading is 34 minutes old. Railway is building 3e9a1f2.', action: 'Open api on Railway', ext: true }] : [],
      week: [['Merged PRs', 12, 3], ['Deploys', 18, 2], ['Failed deploys', 1, -1, true], ['Open PRs', 7, 0]],
      links: [['Code', '7 open pull requests'], ['CI & deploys', '18 deploys this week'], ['Usage', 'from Cloudflare and Railway'], ['Planning', 'Roadmap and issues']],
      usage: [
        { app: 'web', env: 'Production', kind: 'traffic', source: 'Cloudflare', req: '1.24M', reqT: [150, 165, 172, 180, 176, 190, 184], err: '0.21%', errT: [0.24, 0.2, 0.19, 0.25, 0.22, 0.18, 0.21], errTone: 'good' },
        { app: 'web', env: 'Staging', kind: 'traffic', source: 'Cloudflare', req: '86.2K', reqT: [10, 12, 14, 11, 16, 13, 12], err: '0.41%', errT: [0.3, 0.5, 0.4, 0.3, 0.6, 0.4, 0.41], errTone: 'good' },
        { app: 'api', env: 'Production', kind: 'compute', source: 'Railway', cpu: '23%', cpuT: [18, 21, 26, 24, 22, 27, 23], cpuOf: 'of 2 vCPU', mem: '412 MB', memT: [380, 390, 402, 398, 405, 410, 412], memOf: 'of 1 GB' },
        down ? { app: 'api', env: 'Staging', kind: 'compute', source: 'Railway', state: 'stale', last: '47m ago', cpuT: [3, 4, 5, 4, 4], memT: [170, 176, 180, 178, 180] }
          : { app: 'api', env: 'Staging', kind: 'compute', source: 'Railway', cpu: '4%', cpuT: [3, 4, 5, 4, 4, 3, 4], cpuOf: 'of 1 vCPU', mem: '180 MB', memT: [170, 176, 180, 178, 180, 179, 180], memOf: 'of 512 MB' },
      ],
    };
  },

  B: (v) => {
    const failed = v === 'failed', tr = v === 'trouble';
    const t = failed ? { app: 'trov', env: 'Production', sha: 'c41e7d9', age: '1d', by: 'andres', url: 'trov.dev', ms: 96, state: 'failed', failedSha: 'e07b3a2', failedAge: '12m', failedBy: 'andres', failedWhy: 'Build failed in Workers Builds: tsc found 2 errors' }
      : tr ? { app: 'trov', env: 'Production', sha: 'c41e7d9', age: '8m', by: 'andres', url: 'trov.dev', ms: 102, state: 'rolledBack', rolledFrom: 'e07b3a2', next: { sha: 'f19ad20', age: '2m', state: 'building' } }
        : { app: 'trov', env: 'Production', sha: 'c41e7d9', age: '41m', by: 'andres', url: 'trov.dev', ms: 96 };
    return {
      letter: 'B', title: 'One Worker, main to production', org: 'sapling', repo: 'AndresL230/trov',
      envs: [{ name: 'Production', branch: 'main' }],
      apps: [{ name: 'trov', folder: '/', kind: 'Worker', host: 'Cloudflare', prs: 2, previews: true }],
      targets: [t],
      deploys: failed ? D20([2], { 19: 'failed' }) : tr ? D20([2], { 18: 'rolledBack', 19: 'building' }) : D20([7]),
      ci: { Production: failed ? ['fail', '2 of 9 checks failing on e07b3a2'] : tr ? ['run', 'Checks running on f19ad20'] : ['pass', 'All 9 checks passing on c41e7d9'] },
      previews: [
        { pr: 318, title: 'Repo screen: apps and targets', branch: 'repo-apps', by: 'andres', state: 'live', age: '40m', url: 'repo-apps.trov.workers.dev' },
        { pr: 316, title: 'Usage: Railway poller', branch: 'railway-poller', by: 'jose-a', state: 'failed', age: tr ? '3d' : '3h', since: tr ? 'Failing for 3 days, last 4 builds' : null },
      ],
      notShipped: failed ? { app: 'trov', env: 'Production', count: 1, age: '12m', groups: [{ tag: '#320', kind: 'pr', title: 'Repo: read deploy signals per target', meta: 'andres · merged 14m ago', commits: [['e07b3a2', 'Read deploy signals per target', '14m']] }] }
        : tr ? { app: 'trov', env: 'Production', count: 2, age: '30m', groups: [{ tag: '#320', kind: 'pr', title: 'Repo: read deploy signals per target', meta: 'andres · merged 34m ago', commits: [['e07b3a2', 'Read deploy signals per target', '34m'], ['f19ad20', 'Fix: signal reader handles a missing environment', '3m']] }] } : null,
      attention: failed ? [{ k: 'failed', text: 'Production deploy e07b3a2 failed 12m ago on Cloudflare. c41e7d9 is still serving.', action: 'View build log', ext: true }]
        : tr ? [{ k: 'rolledBack', text: 'Production was rolled back to c41e7d9 by andres 8m ago. e07b3a2 is no longer live; f19ad20 is building.', action: 'Compare', ext: true },
          { k: 'failed', text: 'Preview for #316 has failed for 3 days, on the last 4 builds.', action: 'View build log', ext: true }] : [],
      week: [['Merged PRs', 9, 2], ['Deploys', 11, 1], ['Failed deploys', failed ? 1 : 0, failed ? 1 : 0, true], ['Open PRs', 2, -1]],
      usageByRange: {
        '24h': [{ app: 'trov', env: 'Production', kind: 'traffic', source: 'Cloudflare', req: '48.6K', reqT: [1.2, 0.9, 0.7, 0.6, 0.8, 1.6, 2.4, 3.1, 3.4, 3.2, 2.9, 3.3, 3.6, 3.0, 2.6, 2.2, 1.9, 1.7, 1.5, 1.4, 1.3, 1.1, 1.0, 0.9], err: failed ? '0.62%' : '0.19%', errT: failed ? [0.2, 0.2, 0.1, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.3, 0.2, 0.9, 1.8, 2.1, 1.6, 1.2] : [0.2, 0.2, 0.1, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.3, 0.2, 0.2, 0.2, 0.3, 0.2, 0.2, 0.1, 0.2, 0.2, 0.2], errTone: failed ? 'warn' : 'good', users: '23', usersT: [3, 2, 1, 1, 2, 5, 9, 14, 17, 16, 15, 18, 19, 16, 13, 11, 9, 8, 7, 6, 5, 5, 4, 4] }],
        '7d': [{ app: 'trov', env: 'Production', kind: 'traffic', source: 'Cloudflare', req: '335K', reqT: [41, 52, 55, 49, 58, 31, 28, 47, 54, 60, 57, 63, 36, 34], err: failed ? '0.31%' : '0.25%', errT: failed ? [0.22, 0.26, 0.24, 0.3, 0.27, 0.21, 0.2, 0.25, 0.23, 0.28, 0.26, 0.24, 0.31, 0.62] : [0.22, 0.26, 0.24, 0.3, 0.27, 0.21, 0.2, 0.25, 0.23, 0.28, 0.26, 0.24, 0.25, 0.25], errTone: failed ? 'warn' : 'good', users: '61', usersT: [38, 44, 47, 42, 49, 22, 19, 45, 51, 55, 53, 58, 27, 24] }],
        '30d': [{ app: 'trov', env: 'Production', kind: 'traffic', source: 'Cloudflare', req: '1.38M', reqT: [180, 205, 214, 198, 226, 120, 112, 232, 240, 251, 247, 262, 140, 133, 268, 274, 281, 276, 290, 151, 146, 296, 302, 311, 307, 318, 166, 160, 322, 335], err: '0.23%', errT: [0.21, 0.24, 0.22, 0.25, 0.23, 0.2, 0.19, 0.24, 0.22, 0.26, 0.25, 0.23, 0.21, 0.2, 0.24, 0.23, 0.25, 0.22, 0.24, 0.2, 0.21, 0.23, 0.25, 0.24, 0.22, 0.26, 0.21, 0.2, 0.24, 0.25], errTone: 'good', users: '112', usersT: [60, 64, 66, 63, 69, 34, 31, 70, 73, 75, 74, 78, 40, 38, 80, 82, 84, 83, 86, 44, 42, 88, 90, 93, 92, 95, 48, 46, 97, 112] }],
      },
      links: [['Code', '2 open pull requests'], ['CI & deploys', '11 deploys this week'], ['Usage', 'from Cloudflare'], ['Planning', 'Roadmap and issues']],
    };
  },

  C: () => ({
    letter: 'C', title: 'Static site with previews', org: 'acme', repo: 'acme/site',
    envs: [{ name: 'Production', branch: 'main' }],
    apps: [{ name: 'site', folder: '/', kind: 'Site', host: 'Netlify', prs: 6, previews: true }],
    targets: [{ app: 'site', env: 'Production', sha: '5f2c0e8', age: '3h', by: 'ana-r', url: 'acme.com', ms: 48 }],
    deploys: D20([11]),
    ci: { Production: ['pass', 'All 4 checks passing on 5f2c0e8'] },
    previews: [
      { pr: 88, title: 'Pricing page: annual toggle', branch: 'pricing-annual', by: 'ana-r', state: 'live', age: '20m', url: 'deploy-preview-88--acme-site.netlify.app' },
      { pr: 87, title: 'Blog: RSS feed', branch: 'blog-rss', by: 'tom-h', state: 'live', age: '2h', url: 'deploy-preview-87--acme-site.netlify.app' },
      { pr: 86, title: 'Launch hero copy', branch: 'hero-copy', by: 'meilin', state: 'building', age: '1m' },
      { pr: 85, title: 'Footer links on mobile', branch: 'fix-footer', by: 'dev-raj', state: 'live', age: '5h', url: 'deploy-preview-85--acme-site.netlify.app' },
      { pr: 84, title: 'Case studies index', branch: 'case-studies', by: 'ana-r', state: 'live', age: '1d', url: 'deploy-preview-84--acme-site.netlify.app' },
      { pr: 83, title: 'Docs navigation', branch: 'docs-nav', by: 'kenji-m', state: 'failed', age: '1d' },
    ],
    usageNote: 'Netlify',
    week: [['Merged PRs', 5, 1], ['Deploys', 7, 0], ['Failed deploys', 0, 0, true], ['Open PRs', 6, 2]],
    links: [['Code', '6 open pull requests'], ['CI & deploys', '7 deploys this week'], ['Usage', 'not available from Netlify'], ['Planning', 'Roadmap and issues']],
  }),

  D: () => ({
    letter: 'D', title: 'Full-stack on one host', org: 'acme', repo: 'acme/dashboard',
    envs: [{ name: 'Production', branch: 'main' }],
    apps: [{ name: 'dashboard', folder: '/', kind: 'Site', host: 'Vercel', prs: 3, previews: true }],
    targets: [{ app: 'dashboard', env: 'Production', sha: '8b31f6d', age: '1h', by: 'priya-k', url: 'dashboard.acme.com', ms: 211 }],
    deploys: D20([4, 13]),
    ci: { Production: ['pass', 'All 6 checks passing on 8b31f6d'] },
    previews: [
      { pr: 402, title: 'Orders: CSV export', branch: 'orders-export', by: 'tom-h', state: 'live', age: '35m', url: 'dashboard-git-orders-export-acme.vercel.app' },
      { pr: 399, title: 'Settings: team roles', branch: 'team-roles', by: 'kenji-m', state: 'live', age: '4h', url: 'dashboard-git-team-roles-acme.vercel.app' },
      { pr: 397, title: 'Move API routes to the app router', branch: 'app-router-api', by: 'priya-k', state: 'live', age: '1d', url: 'dashboard-git-app-router-api-acme.vercel.app' },
    ],
    usageNote: 'Vercel',
    week: [['Merged PRs', 8, 2], ['Deploys', 10, 3], ['Failed deploys', 0, -1, true], ['Open PRs', 3, 0]],
    links: [['Code', '3 open pull requests'], ['CI & deploys', '10 deploys this week'], ['Usage', 'not available from Vercel'], ['Planning', 'Roadmap and issues']],
  }),

  E: () => ({
    letter: 'E', title: 'Turborepo, five apps', org: 'acme', repo: 'acme/storefront',
    envs: [{ name: 'Production', branch: 'main' }],
    apps: [
      { name: 'web', folder: 'apps/web', kind: 'Site', host: 'Vercel', prs: 4, previews: true },
      { name: 'api', folder: 'apps/api', kind: 'Service', host: 'Render', prs: 3, previews: true },
      { name: 'docs', folder: 'apps/docs', kind: 'Site', host: 'Cloudflare Pages', prs: 1, previews: true },
      { name: 'jobs', folder: 'apps/jobs', kind: 'Job', host: 'Fly.io', via: 'deploy-jobs.yml', prs: 1 },
      { name: 'ui', folder: 'packages/ui', kind: 'Package', usedBy: 'web, docs', prs: 2 },
    ],
    targets: [
      { app: 'web', env: 'Production', sha: '9c4e2b1', age: '2d', by: 'tom-h', url: 'storefront.acme.com', ms: 188 },
      { app: 'api', env: 'Production', sha: '2b8e6c4', age: '3d', by: 'kenji-m', url: 'api.storefront.acme.com', ms: 102, state: 'failed', failedSha: '7f3a9d0', failedAge: '25m', failedBy: 'priya-k', failedWhy: 'Render: build exited with status 1' },
      { app: 'docs', env: 'Production', sha: 'a1d07e3', age: '5h', by: 'ana-r', url: 'docs.storefront.acme.com', ms: 64 },
      { app: 'jobs', env: 'Production', sha: 'e5b2f19', age: '1d', by: 'kenji-m', via: 'deploy-jobs.yml' },
    ],
    previewsByApp: { web: ['live', 'live', 'building'], api: ['live'], docs: ['live'] },
    notShippedByApp: { web: [4, '2d'], api: [1, '25m'], docs: [0], jobs: [0] },
    notShipped: { app: 'web', env: 'Production', count: 4, age: '2d', groups: [
      { tag: '#651', kind: 'pr', title: 'Checkout: saved addresses', meta: 'tom-h · merged 2d ago', commits: [['c8a1e40', 'Saved addresses on checkout', '2d'], ['13fd9b2', 'Address book API client', '2d']] },
      { tag: '#648', kind: 'pr', title: 'web: lazy-load the product gallery', meta: 'ana-r · merged 2d ago', commits: [['6e02a7c', 'Lazy-load gallery images', '2d']] },
      { tag: 'Pushed', kind: 'direct', title: '1 commit pushed straight to main', meta: 'dev-raj', commits: [['f4b7d21', 'fix: typo in the cart drawer', '2d']] },
    ] },
    attention: [
      { k: 'failed', text: 'api: production deploy 7f3a9d0 failed 25m ago on Render. 2b8e6c4 is still serving.', action: 'View logs on Render', ext: true },
      { k: 'waiting', text: 'web: 4 commits merged 2 days ago are not in production.', action: 'See what is waiting' },
    ],
    week: [['Merged PRs', 21, 4], ['Deploys', 26, 5], ['Failed deploys', 2, 1, true], ['Open PRs', 11, 1]],
    links: [['Code', '11 open pull requests'], ['CI & deploys', '26 deploys this week'], ['Usage', 'from Render and Cloudflare'], ['Planning', 'Roadmap and issues']],
  }),

  F: () => {
    const A = [
      ['checkout', 'services/checkout', 'Service', 'Render', 'failed', '41b7e09', '18m', 'tom-h', [3, '1h'], ['live', 'failed']],
      ['search', 'services/search', 'Service', 'Fly.io', 'failed', 'd2a6f31', '52m', 'kenji-m', [1, '52m'], []],
      ['admin', 'apps/admin', 'Site', 'Vercel', 'building', '7c19e5a', '3m', 'ana-r', [0], ['live', 'live']],
      ['web', 'apps/web', 'Site', 'Vercel', 'live', '0f4d8b2', '2h', 'priya-k', [0], ['live', 'live', 'live', 'building']],
      ['api', 'services/api', 'Service', 'Render', 'live', 'b83e2c7', '4h', 'dev-raj', [0], ['live']],
      ['auth', 'services/auth', 'Service', 'Render', 'live', '5a0c9d4', '1d', 'meilin', [0], []],
      ['billing', 'services/billing', 'Service', 'Render', 'live', 'e61f3b8', '3d', 'sanaok', [2, '3d'], []],
      ['notifications', 'workers/notifications', 'Worker', 'Cloudflare', 'live', '92d4a7e', '6h', 'jose-a', [0], ['live']],
      ['media', 'workers/media', 'Worker', 'Cloudflare', 'live', '3be8f10', '1d', 'kenji-m', [0], []],
      ['docs', 'apps/docs', 'Site', 'Cloudflare Pages', 'live', 'aa47c62', '5h', 'ana-r', [0], ['live']],
      ['status', 'apps/status', 'Site', 'Netlify', 'live', '1c9e0f5', '9d', 'tom-h', [0], []],
      ['reports', 'jobs/reports', 'Job', 'Fly.io', 'live', '6f2b3d1', '1d', 'dev-raj', [0], []],
      ['sdk', 'packages/sdk', 'Package', null],
      ['tokens', 'packages/tokens', 'Package', null],
    ];
    return {
      letter: 'F', title: 'Large monorepo, 14 apps', org: 'acme', repo: 'acme/platform',
      envs: [{ name: 'Production', branch: 'main' }],
      apps: A.map(([name, folder, kind, host, , , , , , pv]) => ({ name, folder, kind, host, previews: !!(pv && pv.length), prs: pv ? pv.length : 1, usedBy: kind === 'Package' ? (name === 'sdk' ? 'web, admin, checkout' : 'web, admin, docs, status') : null })),
      targets: A.filter((a) => a[3]).map(([app, , , , state, sha, age, by]) => ({ app, env: 'Production', sha, age, by, state: state === 'live' ? undefined : state, ms: 80, url: `${app}.platform.acme.com`,
        ...(state === 'failed' ? { sha: app === 'checkout' ? 'c07a1e2' : '88e4b10', age: app === 'checkout' ? '2d' : '4d', failedSha: sha, failedAge: age } : {}),
        ...(state === 'building' ? { prev: { sha: '2d91c08', age: '1d' } } : {}) })),
      previewsByApp: Object.fromEntries(A.filter((a) => a[3]).map((a) => [a[0], a[9]])),
      notShippedByApp: Object.fromEntries(A.filter((a) => a[3]).map((a) => [a[0], a[8]])),
      attention: [
        { k: 'failed', text: 'checkout: production deploy 41b7e09 failed 18m ago on Render. c07a1e2 is still serving.', action: 'View logs on Render', ext: true },
        { k: 'failed', text: 'search: production deploy d2a6f31 failed 52m ago on Fly.io. 88e4b10 is still serving.', action: 'View logs on Fly.io', ext: true },
      ],
      week: [['Merged PRs', 64, 9], ['Deploys', 83, 12], ['Failed deploys', 5, 2, true], ['Open PRs', 23, -3]],
      links: [['Code', '23 open pull requests'], ['CI & deploys', '83 deploys this week'], ['Usage', 'from Render, Fly.io and Cloudflare'], ['Planning', 'Roadmap and issues']],
    };
  },

  G: (v) => {
    const after = v === 'after';
    const env2 = [{ name: 'Production', branch: 'production' }, { name: 'Staging', branch: 'main' }];
    const S = [['gateway', 'services/gateway'], ['ledger', 'services/ledger'], ['notifier', 'services/notifier'], ['settle', 'jobs/settle']];
    const known = { gateway: [['Production', '6d0b3f9', '1d', 'sanaok'], ['Staging', 'a24e81c', '3h', 'dev-raj']], ledger: [['Production', '6d0b3f9', '1d', 'sanaok'], ['Staging', 'a24e81c', '3h', 'dev-raj', 'building']], notifier: [['Production', 'f13c9a7', '6d', 'meilin'], ['Staging', 'a24e81c', '3h', 'dev-raj']], settle: [['Production', '6d0b3f9', '1d', 'sanaok'], ['Staging', 'a24e81c', '3h', 'dev-raj']] };
    return {
      letter: 'G', title: 'Backend services only', org: 'acme', repo: 'acme/payments',
      envs: env2,
      apps: S.map(([name, folder]) => ({ name, folder, kind: name === 'settle' ? 'Job' : 'Service', host: 'Railway', prs: name === 'ledger' ? 2 : 1 })),
      targets: S.flatMap(([app]) => known[app].map(([env, sha, age, by, st]) => after ? { app, env, sha, age, by, state: st, ms: app === 'settle' ? null : 70 } : { app, env, unknown: true })),
      notShippedByApp: after ? { gateway: [3, '3h'], ledger: [3, '3h'], notifier: [5, '6d'], settle: [3, '3h'] } : { gateway: [null], ledger: [null], notifier: [null], settle: [null] },
      connect: after ? null : { host: 'Railway', text: 'Railway does not report deploys to GitHub, so Trov cannot see what is running in Staging or Production yet. Connect Railway once and every service here fills in, with CPU and memory too.', action: 'Connect Railway', alt: 'Members see this note too; only an admin can connect a host.' },
      attention: after ? [{ k: 'waiting', text: 'notifier: Production runs f13c9a7 from 6 days ago; 5 commits are waiting.', action: 'See what is waiting' }] : [],
      week: [['Merged PRs', 7, 1], after ? ['Deploys', 14, 2] : ['Deploys', null, null], after ? ['Failed deploys', 0, 0, true] : ['Failed deploys', null, null], ['Open PRs', 5, 0]],
      links: [['Code', '5 open pull requests'], ['CI & deploys', after ? '14 deploys this week' : 'CI only until Railway is connected'], ['Usage', after ? 'from Railway' : 'not connected'], ['Planning', 'Roadmap and issues']],
    };
  },

  H: () => ({
    letter: 'H', title: 'Containers by GitHub Actions', org: 'acme', repo: 'acme/ingest',
    envs: [{ name: 'Staging', branch: 'main' }, { name: 'Production', branch: 'production' }],
    apps: [{ name: 'collector', folder: 'collector/', kind: 'Service', host: 'Fly.io', via: 'deploy-collector.yml', prs: 2 }, { name: 'normalizer', folder: 'normalizer/', kind: 'Service', host: 'Cloud Run', via: 'deploy-normalizer.yml', prs: 1 }],
    targets: [
      { app: 'collector', env: 'Staging', sha: '4e1a9c7', age: '1h', by: 'kenji-m', via: 'deploy-collector.yml', url: 'collector-staging.fly.dev', ms: 61 },
      { app: 'normalizer', env: 'Staging', sha: '4e1a9c7', age: '4m', by: 'kenji-m', via: 'deploy-normalizer.yml', state: 'building', prev: { sha: '0b72d3e', age: '1d' }, runStep: 'Run 412 · step 4 of 6, pushing image' },
      { app: 'collector', env: 'Production', sha: '0b72d3e', age: '1d', by: 'sanaok', via: 'deploy-collector.yml', url: 'collector.fly.dev', ms: 58 },
      { app: 'normalizer', env: 'Production', sha: '0b72d3e', age: '1d', by: 'sanaok', via: 'deploy-normalizer.yml', url: 'normalizer-prod-4kq.a.run.app', ms: 140 },
    ],
    ci: { Staging: ['run', 'deploy-normalizer.yml running on 4e1a9c7'], Production: ['pass', 'All 7 checks passing on 0b72d3e'] },
    drift: [{ from: 'main', to: 'production', ahead: 3, groups: [
      { tag: '#77', kind: 'pr', title: 'normalizer: drop events older than 7 days', meta: 'kenji-m · merged 1h ago', commits: [['4e1a9c7', 'Drop stale events before normalising', '1h'], ['9c3d0e1', 'Config: max event age', '1h']] },
      { tag: 'Pushed', kind: 'direct', title: '1 commit pushed straight to main', meta: 'tom-h', commits: [['ba0f6e2', 'ci: pin flyctl 0.3.40', '5h']] },
    ] }],
    usageNote: null,
    week: [['Merged PRs', 4, 0], ['Deploys', 9, 1], ['Failed deploys', 0, 0, true], ['Open PRs', 3, 1]],
    links: [['Code', '3 open pull requests'], ['CI & deploys', '1 workflow running'], ['Usage', 'not connected'], ['Planning', 'Roadmap and issues']],
  }),

  I: () => ({
    letter: 'I', title: 'Package with releases only', org: 'acme', repo: 'acme/ui-kit',
    envs: [], apps: [{ name: 'ui-kit', folder: '/', kind: 'Package', prs: 6 }], targets: [],
    release: {
      tag: 'v2.4.0', age: '9 days ago', by: 'meilin', date: '5 Oct',
      notes: 'Select gains async options and a loading state. Tooltip waits 300 ms before opening. Fixes focus return in Dialog when it closes from Escape.',
      since: { commits: 18, prs: 5 },
      waiting: [
        { pr: 231, title: 'feat: DatePicker range mode', by: 'ana-r', age: 'merged 2d ago', state: 'merged', feature: true },
        { pr: 228, title: 'feat: Toast stacking and swipe to dismiss', by: 'tom-h', age: 'merged 4d ago', state: 'merged', feature: true },
        { pr: 230, title: 'fix: Menu keeps scroll position on reopen', by: 'dev-raj', age: 'merged 3d ago', state: 'merged' },
        { pr: 227, title: 'docs: theming guide', by: 'meilin', age: 'merged 6d ago', state: 'merged' },
        { pr: 226, title: 'chore: bump Storybook 9.1', by: 'kenji-m', age: 'merged 8d ago', state: 'merged' },
      ],
      cadence: [{ tag: 'v2.1.0', d: 91 }, { tag: 'v2.2.0', d: 70 }, { tag: 'v2.3.0', d: 56 }, { tag: 'v2.3.1', d: 35 }, { tag: 'v2.3.2', d: 23 }, { tag: 'v2.4.0', d: 9 }],
      gaps: 'The gaps before it were 14, 12, 21, 21 and 21 days.',
    },
    week: [['Merged PRs', 5, 1], ['Commits', 18, 6], ['Releases', 0, -1], ['Open PRs', 6, 2]],
    links: [['Code', '6 open pull requests'], ['CI', 'All checks passing on main'], ['Planning', 'Roadmap and issues']],
  }),

  J: () => ({
    letter: 'J', title: 'Three environments, promotion chain', org: 'acme', repo: 'acme/core',
    envs: [{ name: 'Dev', branch: 'develop' }, { name: 'Staging', branch: 'main' }, { name: 'Production', branch: 'release' }],
    apps: [{ name: 'core', folder: '/', kind: 'Service', host: 'Render', prs: 5 }],
    targets: [
      { app: 'core', env: 'Dev', sha: '7aa3c90', age: '18m', by: 'dev-raj', url: 'core-dev.onrender.com', ms: 120 },
      { app: 'core', env: 'Staging', sha: '2f6e14b', age: '1d', by: 'meilin', url: 'core-staging.onrender.com', ms: 104 },
      { app: 'core', env: 'Production', sha: 'c90b5d2', age: '8d', by: 'sanaok', url: 'core.acme.com', ms: 97 },
    ],
    ci: { Dev: ['fail', '1 of 11 checks failing on 7aa3c90'], Staging: ['pass', 'All 11 checks passing on 2f6e14b'], Production: ['pass', 'All 11 checks passing on c90b5d2'] },
    drift: [
      { from: 'develop', to: 'main', ahead: 6, groups: [{ tag: '#305', kind: 'pr', title: 'Batch writes in the outbox relay', meta: 'dev-raj · merged into develop 18m ago', commits: [['7aa3c90', 'Batch outbox writes', '18m'], ['31be7c2', 'Outbox relay metrics', '1h']] }, { tag: '#303', kind: 'pr', title: 'Retry policy per queue', meta: 'jose-a · merged into develop 1d ago', commits: [['e0d1f48', 'Retry policy per queue', '1d'], ['b5c2a91', 'Default retry policy', '1d'], ['44f7e0d', 'Docs: retry policy', '1d'], ['0c3b6aa', 'Test: retry backoff', '1d']] }] },
      { from: 'main', to: 'release', ahead: 14, groups: [{ tag: '#298', kind: 'pr', title: 'Tenant export endpoint', meta: 'meilin · merged into main 1d ago', commits: [['2f6e14b', 'Tenant export endpoint', '1d']] }, { tag: '+ 6 PRs', kind: 'direct', title: '13 more commits since c90b5d2', meta: 'merged into main over 8 days', commits: [] }] },
    ],
    attention: [{ k: 'degraded', text: 'Dev: 1 of 11 checks fails on develop (integration: outbox relay).', action: 'View the run', ext: true }],
    week: [['Merged PRs', 9, 2], ['Deploys', 12, 0], ['Failed deploys', 0, 0, true], ['Open PRs', 5, 0]],
    links: [['Code', '5 open pull requests'], ['CI & deploys', '12 deploys this week'], ['Usage', 'from Render'], ['Planning', 'Roadmap and issues']],
  }),

  K: () => ({
    letter: 'K', title: 'One product across two repos', org: 'acme', repo: 'acme/web-app',
    envs: [{ name: 'Staging', branch: 'main' }, { name: 'Production', branch: 'production' }],
    apps: [{ name: 'web-app', folder: '/', kind: 'Site', host: 'Vercel', prs: 4, previews: true }],
    targets: [
      { app: 'web-app', env: 'Staging', sha: '1e8d4a0', age: '35m', by: 'ana-r', url: 'staging.app.acme.com', ms: 150 },
      { app: 'web-app', env: 'Production', sha: '9f02b6c', age: '1d', by: 'ana-r', url: 'app.acme.com', ms: 142 },
    ],
    ci: { Staging: ['pass', 'All 8 checks passing on 1e8d4a0'], Production: ['pass', 'All 8 checks passing on 9f02b6c'] },
    drift: [{ from: 'main', to: 'production', ahead: 3, groups: [{ tag: '#121', kind: 'pr', title: 'Checkout reads prices from web-api v2', meta: 'ana-r · merged 35m ago', commits: [['1e8d4a0', 'Use /v2/prices', '35m'], ['6b3f9c2', 'Price cache per region', '2h'], ['d05e7a1', 'Test: v2 price shape', '2h']] }] }],
    week: [['Merged PRs', 6, 1], ['Deploys', 9, 2], ['Failed deploys', 0, 0, true], ['Open PRs', 4, 0]],
    links: [['Code', '4 open pull requests'], ['CI & deploys', '9 deploys this week'], ['Usage', 'not available from Vercel'], ['Planning', 'Roadmap and issues']],
  }),

  L: () => ({
    letter: 'L', title: 'Just connected', org: 'acmeNew', repo: 'acme/new-thing',
    apps: [], envs: [], targets: [],
    found: {
      apps: [
        { folder: 'apps/web', kind: 'Site', host: 'Vercel', evidence: 'from apps/web/vercel.json' },
        { folder: 'apps/worker', kind: 'Worker', host: 'Cloudflare', evidence: 'from apps/worker/wrangler.toml' },
        { folder: 'packages/shared', kind: 'Package', host: null, evidence: 'from packages/shared/package.json' },
      ],
      signals: [['Production – new-thing-web', 'Vercel', 12], ['Preview – new-thing-web', 'Vercel', 41]],
    },
    week: [['Merged PRs', 6, null], ['Commits', 31, null], ['CI runs', 48, null], ['Open PRs', 4, null]],
  }),

  M: () => ({
    letter: 'M', title: 'Nothing recognised', org: 'acmeNew', repo: 'acme/mobile',
    apps: [], envs: [], targets: [], found: { apps: [], signals: [] },
    unseen: {
      looked: 'vercel.json, netlify.toml, wrangler.toml, fly.toml, render.yaml, railway.json, a Dockerfile with a deploy workflow',
      sees: [['Tags', '14 tags; the latest is v1.8.0, 6 days ago'], ['Pull requests', '4 open, 9 merged this month'], ['CI', 'eas-build.yml and test.yml, on every push'], ['GitHub deployments', 'None reported in 30 days']],
      tags: [['v1.8.0', '6d', 'ana-r'], ['v1.7.2', '19d', 'tom-h'], ['v1.7.1', '27d', 'tom-h'], ['v1.7.0', '41d', 'ana-r']],
    },
    week: [['Merged PRs', 9, 2], ['Commits', 37, 4], ['CI runs', 52, 6], ['Open PRs', 4, 0]],
  }),
};
SC.N = (v) => (v === 'trov' ? SC.B('trouble') : SC.A('trouble'));
export const SCENARIO_TITLES = { A: 'Frontend and backend', B: 'One Worker, main to production', C: 'Static site with previews', D: 'Full-stack on one host', E: 'Turborepo, five apps', F: 'Large monorepo, 14 apps', G: 'Backend services only', H: 'Containers by GitHub Actions', I: 'Package with releases only', J: 'Promotion chain', K: 'One product, two repos', L: 'Just connected', M: 'Nothing recognised', N: 'Trouble states' };

// ── view model ───────────────────────────────────────────────────────────────
const CODE = (s) => s;
const ciLine = (c) => c ? { glyph: c[0] === 'pass' ? '✓' : c[0] === 'fail' ? '✕' : '', dot: c[0] === 'run', tone: c[0] === 'pass' ? G : c[0] === 'fail' ? RD : AM, text: c[1] } : null;

function rowFor(s, t, app) {
  const host = app.host + (t.via || app.via ? ` via ${t.via || app.via}` : '');
  if (t.unknown) return { app: app.name, sha: '', unknown: true, meta: `${app.host} does not report deploys to GitHub`, url: null, health: '', healthMark: null, state: mark('unknown'), line: null, flag: null };
  const r = { app: app.name, sha: t.sha, meta: `${t.age} ago · by ${t.by} · ${host}`, url: t.url || null, href: t.url ? `https://${t.url}` : null, health: t.ms ? `${t.ms} ms` : '', healthMark: null, state: null, line: null, flag: null };
  if (t.health === 'down') { r.healthMark = mark('down'); r.health = ''; r.line = { m: shapeOnly('down'), text: `No answer from ${t.url} for ${t.downFor}` }; }
  if (t.health === 'stale') { r.healthMark = mark('stale', { word: `Reading ${t.staleFor} old` }); r.health = ''; }
  if (t.state === 'failed') { r.line = { m: shapeOnly('failed'), text: `${t.failedSha} failed ${t.failedAge} ago${t.failedWhy ? ` · ${t.failedWhy}` : ''}. ${t.sha} is still serving.` }; r.state = null; }
  if (t.state === 'building') { r.state = mark('building'); r.line = { m: null, text: t.runStep ? `${t.runStep}. ${t.prev.sha} is serving until it finishes.` : `${t.prev.sha} is serving until it finishes.` }; }
  if (t.state === 'rolledBack') { r.state = mark('rolledBack'); r.line = { m: null, text: `Rolled back from ${t.rolledFrom} by ${t.by} ${t.age} ago.` }; }
  if (t.behind) r.flag = { m: shapeOnly('outOfStep'), text: `${t.behind.n} commits behind ${t.behind.of}` };
  return r;
}
function verdictFor(s, env, rows, targets) {
  if (targets.every((t) => t.unknown)) return mark('unknown');
  if (targets.some((t) => t.health === 'down')) return mark('down');
  if (targets.some((t) => t.state === 'failed')) return mark('failing');
  if (targets.some((t) => t.behind)) return mark('outOfStep');
  const ci = (s.ci || {})[env];
  if (ci && ci[0] === 'fail') return mark('degraded');
  return mark('healthy');
}
function envCards(s) {
  return s.envs.map((e) => {
    const ts = s.targets.filter((t) => t.env === e.name);
    const rows = ts.map((t) => rowFor(s, t, s.apps.find((a) => a.name === t.app)));
    return { name: e.name, branch: e.branch, verdict: verdictFor(s, e.name, rows, ts), rows, ci: ciLine((s.ci || {})[e.name]), unknown: ts.every((t) => t.unknown) };
  });
}
function appsTable(s) {
  const named = s.envs.map((e) => e.name);
  const anyPreview = s.apps.some((a) => a.previews);
  const second = anyPreview ? 'Previews' : (named.find((n) => n !== 'Production') || null);
  const rows = s.apps.filter((a) => a.kind !== 'Package').map((a) => {
    const p = s.targets.find((t) => t.app === a.name && t.env === 'Production');
    const pv = (s.previewsByApp || {})[a.name];
    const ns = (s.notShippedByApp || {})[a.name] || [0];
    let status = shapeOnly('live'), rank = 4, cell = { sha: p && p.sha, age: p && p.age ? `${p.age} ago` : '', sub: p && p.url ? p.url : (p && p.via ? `via ${p.via}` : ''), m: null };
    if (!p || p.unknown) { status = shapeOnly('unknown'); rank = 3; cell = { sha: '', age: '', sub: '', m: mark('unknown'), unknown: true }; }
    else if (p.state === 'failed') { status = shapeOnly('failed'); rank = 0; cell = { sha: p.sha, age: `${p.age} ago`, m: mark('failed', { word: `${p.failedSha} failed ${p.failedAge} ago` }), sub: `${p.sha} still serving` }; }
    else if (p.state === 'building') { status = shapeOnly('building'); rank = 1; cell = { sha: p.sha, age: `${p.age} ago`, m: mark('building'), sub: `${p.prev.sha} serving until it finishes` }; }
    else if (ns[0] && ns[0] > 2) { status = shapeOnly('waiting'); rank = 2; }
    let sec = null;
    if (second === 'Previews') sec = a.previews ? { kind: 'previews', count: pv ? pv.length : 0, text: pv && pv.length ? `${pv.length} open` : 'None open', marks: (pv || []).slice(0, 4).map((x) => shapeOnly(x)) } : { kind: 'none', text: 'No preview target' };
    else if (second) { const t2 = s.targets.find((t) => t.app === a.name && t.env === second); sec = t2 && !t2.unknown ? { kind: 'env', sha: t2.sha, age: `${t2.age} ago`, m: t2.state === 'building' ? mark('building') : null } : { kind: 'env', sha: '', age: '', m: mark('unknown') }; }
    const nsCell = ns[0] === null ? { text: 'Unknown', sub: '', quiet: true } : ns[0] ? { text: `${ns[0]} ${ns[0] === 1 ? 'commit' : 'commits'}`, sub: `oldest ${ns[1]}`, warn: ns[0] > 2 } : { text: 'Up to date', sub: '', quiet: true };
    return { name: a.name, folder: a.folder, kind: a.kind, host: a.host + (a.via ? ` via ${a.via}` : ''), status, rank, prod: cell, sec, ns: nsCell, healthy: rank === 4 };
  }).sort((x, y) => x.rank - y.rank);
  const packages = s.apps.filter((a) => a.kind === 'Package').map((a) => ({ name: a.name, folder: a.folder, usedBy: a.usedBy, text: `Not deployed on its own; ships inside ${a.usedBy}.` }));
  return { secLabel: second, rows, packages, total: s.apps.length };
}

function driftModel(s) {
  if (!s.drift || !s.drift.length) return null;
  const chain = s.envs.length >= 3;
  return {
    chain,
    text: s.drift.length === 1 ? { head: s.drift[0].from, n: s.drift[0].ahead, base: s.drift[0].to } : null,
    steps: s.drift.map((d) => ({ from: d.from, to: d.to, n: d.ahead, groups: d.groups.map((g) => ({ ...g, pr: g.kind === 'pr', commits: g.commits.map(([sha, msg, at]) => ({ sha, msg, at })) })) })),
  };
}

function productionModel(s, now) {
  const t = s.targets[0]; const a = s.apps[0]; const e = s.envs[0];
  const r = rowFor(s, t, a);
  const strip = (s.deploys || []).map((st, i) => ({ st, color: st === 'failed' ? RD : st === 'building' ? BL : st === 'rolledBack' ? AM : st === 'cancelled' ? OFF : G, pulse: st === 'building', last: i === 19 }));
  const fails = strip.filter((x) => x.st === 'failed').length;
  return {
    env: e.name, branch: e.branch, verdict: verdictFor(s, e.name, [r], [t]), row: r, ci: ciLine((s.ci || {})[e.name]), strip,
    stripText: `Last 20 deploys · ${strip.filter((x) => x.st === 'live').length} live${fails ? `, ${fails} failed` : ''}${strip.some((x) => x.st === 'rolledBack') ? ', 1 rolled back' : ''}${strip.some((x) => x.st === 'building') ? ', 1 building' : ''}`,
    failed: t.state === 'failed' ? { sha: t.failedSha, age: t.failedAge, by: t.failedBy, why: t.failedWhy } : null,
    next: t.next ? { sha: t.next.sha, age: t.next.age, m: mark('building') } : null,
    host: a.host, kind: a.kind,
  };
}
function previewsModel(s) {
  if (!s.previews) return null;
  return { count: s.previews.length, rows: s.previews.map((p) => ({ ...p, who: person(p.by), m: p.state === 'live' ? null : mark(p.state === 'failed' ? 'failed' : 'building'), since: p.since || null, link: p.url ? p.url : null })) };
}
function notShippedModel(ns) {
  if (!ns) return null;
  return { title: `${ns.count} ${ns.count === 1 ? 'commit' : 'commits'} on ${ns.app} not in ${ns.env}`, sub: `oldest ${ns.age} ago`, groups: ns.groups.map((g) => ({ ...g, pr: g.kind === 'pr', commits: g.commits.map(([sha, msg, at]) => ({ sha, msg, at })) })) };
}
function releaseModel(r) {
  if (!r) return null;
  const max = 100;
  return { ...r, waiting: r.waiting.map((w) => ({ ...w, who: person(w.by), m: mark(w.state) })), ticks: r.cadence.map((c) => ({ tag: c.tag, left: `${100 - (c.d / max) * 100}%`, last: c.tag === r.tag })) };
}
function attentionModel(s) {
  return (s.attention || []).map((a) => ({ m: shapeOnly(a.k === 'waiting' ? 'waiting' : a.k), text: a.text, action: a.action + (a.ext ? ' ↗' : '') }));
}
function headerPills(s) {
  if (!s.envs || !s.envs.length || !s.targets.length) return [];
  return envCards(s).map((c) => ({ name: c.name, tone: c.verdict.tone, pulse: c.verdict.shape !== 'dot' && c.verdict.shape !== 'ring', tip: `${c.name}: ${c.verdict.word}` }));
}
const weekModel = (s) => (s.week || []).map(([label, value, d, inverse]) => ({ label, value: value === null ? '—' : String(value), delta: d === null || d === undefined ? '' : d > 0 ? `▲ ${d}` : d < 0 ? `▼ ${Math.abs(d)}` : '—', tone: d === null || !d ? 'var(--fg-40)' : (inverse ? d > 0 : d < 0) ? RD : G, vs: d === null ? (value === null ? 'unknown until Railway is connected' : 'since connecting') : 'vs last week' }));

export const TABS = (s) => (decide(s) === 'release'
  ? [['overview', 'Overview'], ['code', 'Code'], ['ci', 'CI'], ['planning', 'Planning']]
  : [['overview', 'Overview'], ['code', 'Code'], ['ci', 'CI & deploys'], ['usage', 'Usage'], ['planning', 'Planning']]);

function narrow(s, app) {
  if (!app || app === '__repo' || !s.apps.some((a) => a.name === app)) return s;
  const pick = (obj) => (obj ? { [app]: obj[app] } : obj);
  const a = s.apps.find((x) => x.name === app);
  const pv = (s.previewsByApp || {})[app] || [];
  return { ...s, apps: [a], targets: s.targets.filter((t) => t.app === app), previewsByApp: pick(s.previewsByApp), notShippedByApp: pick(s.notShippedByApp),
    deploys: s.deploys || D20(s.targets.some((t) => t.app === app && t.state === 'failed') ? [19] : []),
    previews: s.previews || (a.previews ? pv.map((st, i) => ({ pr: 650 - i * 3, title: `${app}: preview ${i + 1}`, branch: `${app}-change-${i + 1}`, by: ['tom-h', 'ana-r', 'kenji-m', 'dev-raj'][i % 4], state: st, age: ['20m', '2h', '1d', '2d'][i % 4], url: st === 'live' ? `${app}-pr-${650 - i * 3}.preview.acme.dev` : null })) : null),
    notShipped: s.notShipped && s.notShipped.app === app ? s.notShipped : null,
    drift: s.drift, attention: (s.attention || []).filter((x) => x.text.startsWith(app + ':')) };
}

export function buildScreen(o) {
  const s = narrow(SC[o.scenario](o.variant), o.app);
  const full = SC[o.scenario](o.variant);
  const org = ORGS[s.org];
  const ruleKey = decide(s);
  const rule = RULES[ruleKey];
  const dep = (s.apps || []).filter((a) => a.kind !== 'Package' && envsOf(s, a.name).length);
  const canGroup = dep.length >= 2 && s.envs.length >= 2;
  let opener = ruleKey;
  if (canGroup && o.group === 'app') opener = 'appsTable';
  if (canGroup && o.group === 'env') opener = 'envCards';
  const appMenu = (full.apps || []).length >= 2 ? [{ name: 'All apps', value: null, n: full.apps.reduce((x, a) => x + (a.prs || 0), 0), on: !o.app }, ...full.apps.map((a) => ({ name: a.name, value: a.name, sub: a.folder, n: a.prs || 0, on: o.app === a.name })), { name: 'Repo-wide only', value: '__repo', sub: 'files outside every app', n: 1, on: o.app === '__repo', divider: true }] : null;
  const tabs = TABS(s).map(([value, label]) => ({ value, label, on: value === (o.tab || 'overview') }));
  const v = {
    s, letter: s.letter, title: s.title, ruleKey, rule, opener, org: { name: org.name, letter: org.name[0], me: person(org.me) },
    repo: s.repo, repos: org.repos.map((r) => ({ name: r, value: r, on: r === s.repo })), multiRepo: org.repos.length > 1,
    appMenu, appLabel: o.app ? (o.app === '__repo' ? 'Repo-wide only' : o.app) : 'All apps',
    tabs, tab: o.tab || 'overview',
    pills: headerPills(s),
    canGroup, group: opener === 'appsTable' ? 'app' : 'env',
    attention: attentionModel(s),
    connect: s.connect || null,
    envCards: (opener === 'envCards' || opener === 'chain') ? envCards(s) : null,
    drift: (opener === 'envCards' || opener === 'chain') ? driftModel(s) : null,
    table: opener === 'appsTable' ? appsTable(s) : null,
    production: opener === 'production' ? productionModel(s) : null,
    previews: opener === 'production' ? previewsModel(s) : null,
    notShipped: notShippedModel(s.notShipped),
    release: opener === 'release' ? releaseModel(s.release) : null,
    found: opener === 'found' ? s.found : null,
    unseen: opener === 'unseen' ? s.unseen : null,
    week: weekModel(s),
    links: (s.links || []).map(([tab, text]) => ({ tab, text })),
    usageNote: s.usageNote || null,
    usage: s.usage || null,
  };
  return v;
}

// ── the other tabs' data ─────────────────────────────────────────────────────
export const CODE_E_API = {
  scope: 'Pull requests that touch apps/api/** or packages/db/**',
  tiles: [['Open PRs', '3', '1 waiting on review'], ['Merged this week', '6', 'into main'], ['Commits', '24', 'last 7 days'], ['Contributors', '4', 'this week']],
  prs: [
    { t: 'api: idempotent order webhooks', n: 642, br: 'webhook-idempotency', by: 'priya-k', st: 'review', ck: 'pass', at: '40m', touches: 'api' },
    { t: 'db: index orders.created_at', n: 639, br: 'orders-index', by: 'kenji-m', st: 'approved', ck: 'pass', at: '3h', touches: 'api, jobs', shared: 'packages/db' },
    { t: 'api: fix Render build on Node 22', n: 644, br: 'node22-build', by: 'priya-k', st: 'draft', ck: 'fail', at: '20m', touches: 'api' },
    { t: 'Money formatting in one place', n: 636, br: 'money-format', by: 'tom-h', st: 'merged', ck: 'pass', at: '1d', touches: 'api, web, docs', shared: 'packages/ui, packages/db' },
    { t: 'api: carts expire after 30 days', n: 633, br: 'cart-expiry', by: 'dev-raj', st: 'merged', ck: 'pass', at: '2d', touches: 'api' },
    { t: 'db: migrate to drizzle 0.40', n: 630, br: 'drizzle-040', by: 'kenji-m', st: 'merged', ck: 'pass', at: '3d', touches: 'api, jobs', shared: 'packages/db' },
  ],
};
export const CI_E = {
  apps: [
    { app: 'web', host: 'Vercel', rows: [['Production', 'llllllllll', 'last 2d ago · 10 of 10 live'], ['Previews', 'llblllflll', 'last 6m ago · 8 of 10 live']] },
    { app: 'api', host: 'Render', rows: [['Production', 'lllflllllf', 'last 25m ago · 8 of 10 live'], ['Previews', 'llllll', 'last 1h ago · 6 of 6 live']] },
    { app: 'docs', host: 'Cloudflare Pages', rows: [['Production', 'llllllllll', 'last 5h ago · 10 of 10 live'], ['Previews', 'lllc', 'last 1d ago · 3 of 4 live']] },
    { app: 'jobs', host: 'Fly.io via deploy-jobs.yml', rows: [['Production', 'llllllll', 'last 1d ago · 8 of 8 live']] },
  ],
  fails: [
    { wf: 'ci.yml', br: 'node22-build', job: 'api › build', at: '20m', app: 'api' },
    { wf: 'deploy-api (Render)', br: 'main', job: 'Render build', at: '25m', app: 'api' },
    { wf: 'ci.yml', br: 'checkout-addresses', job: 'web › e2e', at: '1d', app: 'web' },
  ],
  rate: '4.2%', runs: '143 runs this week',
};
export const CODE_L = {
  tiles: [['Open PRs', '4', '2 waiting on review'], ['Merged this week', '6', 'into main'], ['Commits', '31', 'last 7 days'], ['Contributors', '3', 'this week']],
  prs: [
    { t: 'web: onboarding checklist', n: 19, br: 'onboarding', by: 'ana-r', st: 'review', ck: 'pass', at: '1h' },
    { t: 'worker: queue retries', n: 18, br: 'queue-retries', by: 'kenji-m', st: 'draft', ck: 'run', at: '3h' },
    { t: 'shared: zod schemas for events', n: 17, br: 'event-schemas', by: 'priya-k', st: 'approved', ck: 'pass', at: '5h' },
    { t: 'ci: cache pnpm store', n: 16, br: 'ci-cache', by: 'tom-h', st: 'merged', ck: 'pass', at: '1d' },
  ],
};

// ── tab bodies (generic, from the same facts) ────────────────────────────────
export function sparkPoints(arr, w = 100, h = 26, pad = 3) {
  if (!arr || arr.length < 2) return '';
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = (mx - mn) || 1;
  return arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(h - pad - ((v - mn) / rg) * (h - 2 * pad)).toFixed(1)}`).join(' ');
}
const NO_USAGE_API = ['Vercel', 'Netlify'];
const SEED = (str) => { let h = 7; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 9973; return h; };
const series = (k, n, base, amp) => Array.from({ length: n }, (_, i) => base + ((SEED(k + 'x' + i * 7) % 100) / 100) * amp * (0.6 + 0.4 * Math.sin(i * 1.3 + SEED(k) % 5)));

export function buildUsage(o) {
  const s = SC[o.scenario](o.variant);
  if (!s.apps || !s.apps.length) return { blank: true, text: 'Usage is read per target. Accept the apps Trov found in Org settings, give each a target and a host connection, and their traffic or CPU and memory show here.' };
  const list = s.usageByRange ? s.usageByRange[o.range || '7d'] : s.usage ? s.usage : s.targets.map((t) => {
    const a = s.apps.find((x) => x.name === t.app);
    const traffic = a.kind === 'Site' || a.kind === 'Worker';
    const base = { app: t.app, env: t.env, kind: traffic ? 'traffic' : 'compute', source: a.host };
    if (NO_USAGE_API.includes(a.host)) return { ...base, state: 'notAvailable' };
    if (t.unknown || a.host === 'Railway' && o.variant !== 'after' || a.via || a.host === 'Cloud Run' || a.host === 'Fly.io') return { ...base, state: 'notConnected' };
    const k = t.app + t.env;
    return traffic ? { ...base, req: `${(SEED(k) % 900 + 40)}K`, reqT: series(k, 7, 100, 60), err: `0.${(SEED(k) % 40 + 10)}%`, errT: series(k + 'e', 7, 0.2, 0.2), errTone: 'good' }
      : { ...base, cpu: `${SEED(k) % 40 + 6}%`, cpuT: series(k, 7, 10, 20), cpuOf: 'of 1 vCPU', mem: `${SEED(k) % 500 + 120} MB`, memT: series(k + 'm', 7, 200, 80), memOf: 'of 1 GB' };
  });
  return { blank: false, items: list.map((x) => usageItem({ ...x, range: o.range || '7d' })), cols: Math.min(2, s.envs.length || 1) };
}
function usageItem(u) {
  const state = u.state || 'ok';
  const src = { Cloudflare: 'from Cloudflare', 'Cloudflare Pages': 'from Cloudflare', Railway: 'from Railway', Render: 'from Render', Vercel: 'Vercel', Netlify: 'Netlify', 'Fly.io': 'Fly.io', 'Cloud Run': 'Google Cloud Run' }[u.source] || u.source;
  const metrics = u.kind === 'traffic'
    ? [{ label: `Requests · ${u.range || '7d'}`, value: u.req, pts: sparkPoints(u.reqT), stroke: 'var(--accent)', color: 'var(--fg)', of: '' }, { label: 'Error rate', value: u.err, pts: sparkPoints(u.errT), stroke: u.errTone === 'warn' ? AM : G, color: u.errTone === 'warn' ? AM : G, of: '' }].concat(u.users ? [{ label: 'Active users', value: u.users, pts: sparkPoints(u.usersT), stroke: 'var(--blue)', color: 'var(--fg)', of: '' }] : [])
    : [{ label: 'CPU', value: u.cpu, pts: sparkPoints(u.cpuT), stroke: 'var(--accent)', color: 'var(--fg)', of: u.cpuOf || '' }, { label: 'Memory', value: u.mem, pts: sparkPoints(u.memT), stroke: 'var(--blue)', color: 'var(--fg)', of: u.memOf || '' }];
  return {
    kind: u.kind, sourceName: u.source, raw: u,
    title: u.app, env: u.env, source: state === 'ok' || state === 'stale' ? src : '', state,
    ok: state === 'ok', stale: state === 'stale', nc: state === 'notConnected', na: state === 'notAvailable',
    metrics: metrics.map((m) => ({ ...m, staleText: state === 'stale' ? `last reading ${u.last}` : '' })),
    what: u.kind === 'traffic' ? 'requests and error rate' : 'CPU and memory',
    ncText: `Connect ${u.source} to see ${u.kind === 'traffic' ? 'requests and error rate' : 'CPU and memory'} for ${u.app} in ${u.env}.`,
    ncAction: `Connect ${u.source}`,
    naText: `${u.source} has no usage API, so traffic is not shown for ${u.app}.`,
    naSub: 'Deploys and previews still come through GitHub.',
    staleNote: state === 'stale' ? `Railway has not reported since ${u.last}. Readings resume when it does; nothing is assumed in between.` : '',
  };
}

export function buildCI(o) {
  const s = SC[o.scenario](o.variant);
  if (o.scenario === 'E') return { groups: CI_E.apps.map((a) => ({ app: a.app, host: a.host, rows: a.rows.map(([env, dots, note]) => ({ env, note, dots: dots.split('').map((c) => ({ color: c === 'f' ? RD : c === 'b' ? BL : c === 'c' ? OFF : G, pulse: c === 'b' })) })) })), fails: CI_E.fails, rate: CI_E.rate, runs: CI_E.runs, deploys: true };
  const pkg = decide(s) === 'release';
  if (pkg || !s.targets.length) return { groups: [], deploys: false, noDeploys: pkg ? null : (s.found && s.found.signals.length ? `Deploys show once an app has a target. Trov has seen ${s.found.signals.length} deploy names it can match: ${s.found.signals.map((x) => x[0]).join(' and ')}.` : 'Trov sees no deploys for this repository. Add a target by hand in Org settings › Repositories.'), fails: [], rate: null, runs: pkg ? '64 runs this week' : '48 runs this week' };
  const groups = s.apps.filter((a) => a.kind !== 'Package').map((a) => ({ app: a.name, host: a.host + (a.via ? ` via ${a.via}` : ''), rows: s.targets.filter((t) => t.app === a.name).map((t) => {
    if (t.unknown) return { env: t.env, note: `unknown · ${a.host} does not report to GitHub`, dots: [], unknown: true };
    const ds = (s.deploys && s.deploys.slice(-10)) || Array.from({ length: 10 }, (_, i) => (t.state === 'failed' && i === 9) ? 'failed' : (t.state === 'building' && i === 9) ? 'building' : 'live');
    const live = ds.filter((x) => x === 'live').length;
    return { env: t.env, note: `last ${t.age} ago · ${live} of ${ds.length} live`, dots: ds.map((c) => ({ color: c === 'failed' ? RD : c === 'building' ? BL : c === 'rolledBack' ? AM : G, pulse: c === 'building' })) };
  }) }));
  return { groups, deploys: true, fails: [], rate: null, runs: '61 runs this week' };
}

export function buildCode(o) {
  const d = o.scenario === 'E' && o.app === 'api' ? CODE_E_API : CODE_L;
  return { scope: d.scope || null, tiles: d.tiles.map(([label, value, sub]) => ({ label, value, sub })), showTouches: !!d.scope || o.scenario === 'E', prs: d.prs.map((p) => ({ ...p, who: person(p.by), m: mark(p.st), ck: p.ck === 'pass' ? '✓' : p.ck === 'fail' ? '✕' : '', ckRun: p.ck === 'run', ckTone: p.ck === 'pass' ? G : p.ck === 'fail' ? RD : AM, touches: p.touches || 'Repo-wide', shared: p.shared ? `via ${p.shared}` : '' })) };
}

// ── block models for the System page ─────────────────────────────────────────
export function systemModels() {
  const b = (o) => buildScreen(o);
  const cards = (sc, v) => envCards(SC[sc](v));
  const A = b({ scenario: 'A' }), Aoos = b({ scenario: 'A', variant: 'outOfStep' }), Atr = b({ scenario: 'A', variant: 'trouble' });
  const Efail = Object.assign({}, envCards(narrow(SC.E(), 'api'))[0]);
  const usageA = buildUsage({ scenario: 'A' }).items, usageAtr = buildUsage({ scenario: 'A', variant: 'trouble' }).items;
  const usageH = buildUsage({ scenario: 'H' }).items, usageC = buildUsage({ scenario: 'C' }).items;
  const E = b({ scenario: 'E' });
  return {
    marks: [
      { title: 'Environment verdict', items: ['healthy', 'degraded', 'failing', 'down', 'unknown', 'outOfStep'].map((k) => ({ m: mark(k), tip: MARKS[k].tip })) },
      { title: 'Deploy', items: ['queued', 'building', 'live', 'failed', 'cancelled', 'superseded', 'rolledBack'].map((k) => ({ m: mark(k), tip: MARKS[k].tip })) },
      { title: 'Readings and setup', items: ['stale', 'notConnected', 'connected', 'found', 'accepted', 'ignored', 'waiting'].map((k) => ({ m: mark(k), tip: MARKS[k].tip || '' })) },
      { title: 'Pull request', items: ['draft', 'review', 'approved', 'merged'].map((k) => ({ m: mark(k), tip: '' })) },
    ],
    env: { healthy: A.envCards[0], oos: Aoos.envCards[1], down: Atr.envCards[1], building: b({ scenario: 'H' }).envCards[0], unknown: b({ scenario: 'G', group: 'env' }).envCards[0], degraded: b({ scenario: 'J' }).envCards[0], failing: Efail },
    tableE: E.table, tableG: b({ scenario: 'G' }).table,
    prod: { calm: b({ scenario: 'B' }).production, failed: b({ scenario: 'B', variant: 'failed' }).production, rolled: b({ scenario: 'B', variant: 'trouble' }).production },
    previews: b({ scenario: 'C' }).previews, previewsEmpty: { count: 0, rows: [] },
    drift: A.drift, chain: b({ scenario: 'J' }).drift,
    notShipped: E.notShipped, notShippedEmpty: { title: 'web is up to date in Production', sub: '', groups: [] },
    release: b({ scenario: 'I' }).release,
    attention: E.attention,
    appMenu: E.appMenu, repos: E.repos,
    usage: { traffic: usageA[0], compute: usageA[2], nc: usageH[0], stale: usageAtr[3], na: usageC[0] },
    found: SC.L().found,
  };
}
export function productView() {
  const app = SC.K(), api = { targets: [{ app: 'web-api', env: 'Staging', sha: '5c7e2a9', age: '1h', by: 'kenji-m', url: 'api-staging.acme.com', ms: 72 }, { app: 'web-api', env: 'Production', sha: 'a90d1f3', age: '3d', by: 'kenji-m', url: 'api.acme.com', ms: 66 }] };
  return ['Staging', 'Production'].map((env) => {
    const t1 = app.targets.find((t) => t.env === env), t2 = api.targets.find((t) => t.env === env);
    return { name: env, branch: env === 'Staging' ? 'main' : 'production', verdict: mark('healthy'), ci: null,
      rows: [Object.assign(rowFor(app, t1, { name: 'web-app', host: 'Vercel' }), { meta: `${t1.age} ago · by ${t1.by} · Vercel · acme/web-app` }), Object.assign(rowFor(app, t2, { name: 'web-api', host: 'Render' }), { meta: `${t2.age} ago · by ${t2.by} · Render · acme/web-api` })] };
  });
}

// ── what the Repo screen shows today (web/src/repo-sample.ts), per tab ─────────
const ICON = { push: ['M12 19V5M5 12l7-7 7 7', N], merge: ['M20 6 9 17l-5-5', G], deploy: ['M13 2 3 14h9l-1 8 10-12h-9l1-8', AC], issue: ['M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', AM], close: ['M20 6 9 17l-5-5', N], release: ['M12 3l8 9-8 9-8-9z', BL], review: ['M4 12c2.7-4.7 13.3-4.7 16 0-2.7 4.7-13.3 4.7-16 0z', N] };
const EV = [['push', 'meilin', 'pushed 2 commits to notif/quiet-hours', '12m'], ['deploy', 'dev-raj', 'deployed 3e9a1f2 to Staging', '26m'], ['push', 'dev-raj', 'pushed 3 commits to feature/usage-rollup', '34m'], ['issue', 'sanaok', 'opened #512 “Digest email renders twice on resend”', '1h'], ['review', 'kenji-m', 'approved #480', '2h'], ['push', 'jose-a', 'pushed 1 commit to fix/sse-auth', '2h'], ['issue', 'tom-h', 'opened #511 “wrangler dev hot-reload loops”', '3h'], ['push', 'kenji-m', 'pushed 2f19c3a to main (hotfix: clamp digest window)', '3h'], ['review', 'meilin', 'requested changes on #482', '4h'], ['push', 'sanaok', 'pushed 2 commits to chore/coverage-gate', '5h'], ['issue', 'ana-r', 'opened #510 “Triage map misses dotted handles”', '6h'], ['merge', 'priya-k', 'merged #474 “Migrate feed pagination to keyset”', '8h'], ['review', 'dev-raj', 'commented on #479', '1d'], ['push', 'ana-r', 'pushed 4 commits to design/triage-map', '1d'], ['close', 'meilin', 'closed #504 “Feed dedupe misses edits” as completed', '1d'], ['merge', 'tom-h', 'merged #473 “chore: bump wrangler 4.86”', '1d'], ['push', 'priya-k', 'pushed 1 commit to main (test: fix flaky keyset spec)', '1d'], ['deploy', 'jose-a', 'deployed b4c21de to Production', '2d'], ['release', 'meilin', 'published v0.14.2', '6d'], ['push', 'tom-h', 'pushed 1 commit to spike/edge-cache', '16d']];
const PRS = [['Batch D1 reads in usage rollup', 482, 'dev-raj', 'feature/usage-rollup', 'review', 'pass', '24m'], ['Notifications digest: quiet hours', 480, 'meilin', 'notif/quiet-hours', 'approved', 'pass', '1h'], ['fix: SSE reconnect drops auth header', 479, 'jose-a', 'fix/sse-auth', 'review', 'fail', '2h'], ['Coverage gate at 80% for worker', 477, 'sanaok', 'chore/coverage-gate', 'draft', 'run', '5h'], ['Migrate feed pagination to keyset', 474, 'priya-k', 'feat/keyset-pagination', 'merged', 'pass', '8h'], ['Triage map: fuzzy person match', 470, 'ana-r', 'design/triage-map', 'review', 'pass', '1d'], ['D1 backup cron + restore script', 468, 'kenji-m', 'ops/d1-backup', 'draft', 'pass', '2d']];
const NOTES_P = { llm_cost_cents: 'lower bound — unpriced models are not counted', flashcards_created: 'lower bound — deleted cards are not counted', errors_4xx: 'includes bot traffic and refused polls' };
const PRODUCT = [['growth', 'Growth', [['signups', 'Signups', 3, 21, 96], ['approvals', 'Approvals', 2, 18, 88], ['logins', 'Logins', 74, 182, 306]]], ['learning', 'Learning activity', [['tutor_sessions', 'Tutor sessions', 212, 1380, 5640], ['chat_messages', 'Chat messages', 1840, 12300, 49800], ['quizzes_started', 'Quizzes started', 96, 640, 2710], ['quizzes_completed', 'Quizzes completed', 71, 488, 2050], ['documents_uploaded', 'Documents uploaded', 38, 251, 1020], ['flashcards_created', 'Flashcards created', 410, 2960, 11400], ['notes_created', 'Notes created', 57, 392, 1610]]], ['community', 'Community', [['room_messages', 'Room messages', 264, 1910, 7320], ['feedback', 'Feedback', 4, 19, 73], ['issue_reports', 'Issue reports', 1, 6, 22]]], ['ai', 'AI spend', [['llm_calls', 'LLM calls', 3120, 21400, 86900], ['llm_tokens', 'LLM tokens', 4800000, 33100000, 134000000], ['llm_cost_cents', 'LLM cost', 412, 2961, 11830]]], ['reliability', 'Reliability', [['errors_5xx', '5xx errors', 3, 17, 61], ['errors_4xx', '4xx errors', 142, 980, 3870], ['quiz_generation_failed', 'Quiz generation failed', 1, 9, 31], ['quiz_context_write_failed', 'Quiz context write failed', 0, 0, 2], ['rag_retrieval_failed', 'RAG retrieval failed', 0, 0, 3], ['rag_visibility_resync_failed', 'RAG visibility resync failed', 0, 0, 0], ['rag_chunks_dropped', 'RAG runs that dropped chunks', 2, 11, 40]]]];
const TOTALS = [['users', 'Users', 1204], ['users_pending', 'Users pending', 7], ['documents', 'Documents', 8420], ['flashcards', 'Flashcards', 96300], ['notes', 'Notes', 12750], ['rooms', 'Rooms', 58]];
const compact = (n) => (n >= 999950 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n)));
const usd = (c) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const WOB = [0.6, 1.3, 1, 1.6, 0.7, 1, 1.3, 2, 1, 0.7, 1.3, 1.6, 1.3, 1];
const daily = (t) => Array.from({ length: 14 }, (_, i) => Math.round(t * (t < 20 ? WOB[i] : 0.72 + 0.02 * i + ((i * 7) % 5) * 0.015)));
const RI = { '24h': 2, '7d': 3, '30d': 4 };

export function currentTabs(o) {
  const s = SC[o.scenario](o.variant);
  const range = o.range || '7d';
  const ri = RI[range];
  const health = (s.targets || []).filter((t) => t.url && !t.unknown).map((t) => ({ env: `${t.env} · ${t.app}`, url: t.url, up: t.health !== 'down', stale: t.health === 'stale', ms: t.ms ? `${t.ms} ms` : '—', m: t.health === 'down' ? mark('down') : t.health === 'stale' ? mark('stale') : mark('live', { word: 'Up' }) }));
  const bars = [3, 5, 2, 7, 4, 6, 1, 6, 7, 5, 8, 4, 7, 5];
  const maxB = Math.max(...bars);
  const product = PRODUCT.map(([id, title, rows]) => ({ id, title, metrics: rows.map(([key, label, a, b, c]) => { const raw = [0, 0, a, b, c][ri]; return { key, label, raw, value: key === 'llm_cost_cents' ? usd(raw) : compact(raw), note: NOTES_P[key] || '', trend: sparkPoints(daily(a)) }; }) }));
  const by = Object.fromEntries(product.flatMap((g) => g.metrics.map((m) => [m.key, m])));
  const learning = by && product.find((g) => g.id === 'learning').metrics.slice().sort((x, y) => y.raw - x.raw);
  const maxL = Math.max(...learning.map((m) => m.raw));
  const rel = product.find((g) => g.id === 'reliability').metrics;
  const hot = rel.filter((m) => m.raw > 0), zeros = rel.filter((m) => m.raw === 0);
  return {
    stats: [['Open PRs', 7, 2, 'var(--fg-40)'], ['Awaiting review', 3, 1, 'var(--fg-40)'], ['Open issues', 24, -3, G], ['Open bugs', 6, 1, AM]].map(([label, value, d, tone]) => ({ label, value: String(value), delta: d > 0 ? `▲ ${d}` : `▼ ${-d}`, tone })),
    health,
    codeStats: [['Open PRs', '7', '3 awaiting review', 'var(--fg-40)'], ['Merged this week', '9', 'by 5 people', 'var(--fg-40)'], ['Commits this week', '42', '▲ 8 vs last week', 'var(--fg-40)'], ['Active branches', '14', '2 stale', AM]].map(([label, value, sub, tone]) => ({ label, value, sub, tone })),
    bars: bars.map((c, i) => ({ h: `${Math.round((c / maxB) * 100)}%`, tip: `Oct ${i + 1} — ${c}`, d: i })), barsNote: '70 commits · all branches',
    prs: PRS.map(([t, n, by, br, st, ck, at]) => ({ t, n, br, at, who: person(by), m: mark(st), ck: ck === 'pass' ? '✓' : ck === 'fail' ? '✕' : '', ckTone: ck === 'pass' ? G : ck === 'fail' ? RD : AM, touches: 'Repo-wide', shared: '' })),
    branches: [['feature/usage-rollup', '24m', 4, 0], ['notif/quiet-hours', '1h', 2, 1], ['fix/sse-auth', '2h', 1, 0], ['chore/coverage-gate', '5h', 3, 2], ['spike/edge-cache', '16d', 7, 31, true], ['design/triage-map', '21d', 2, 48, true]].map(([name, at, a, b, stale]) => ({ name, at: `${at} ago`, ab: `+${a} / −${b} vs main`, stale: !!stale, sm: mark('waiting', { word: 'Stale', tip: 'No commit in 14 days.' }) })),
    ciRate: '6.7%', ciTrend: sparkPoints([4, 9, 6, 3, 11, 8, 5]),
    ciFails: [['e2e-smoke', 'main', 'auth flow · shard 1/2', '26m'], ['test', 'fix/sse-auth', 'vitest · shard 2/4', '2h'], ['deploy-staging', 'main', 'wrangler publish', '22h']].map(([wf, br, job, at]) => ({ wf, br, job, at })),
    coverage: { value: '78.4%', pts: sparkPoints([76.1, 76.4, 76.2, 77.0, 77.4, 77.2, 77.9, 78.1, 78.0, 78.4]), delta: '+1.2', tone: G, note: 'this month · gate at 75%' },
    bundle: { value: '412 KB', pts: sparkPoints([388, 390, 395, 393, 398, 401, 406, 404, 409, 412]), delta: '+6 KB', tone: AM, note: 'this week · gzip, main bundle' },
    activity: EV.map(([k, by, text, at]) => ({ d: ICON[k][0], c: ICON[k][1], by, text, at })),
    hasProduct: o.scenario === 'A' || o.scenario === 'N',
    totals: TOTALS.map(([key, label, n]) => ({ label, value: compact(n) })),
    kpis: ['tutor_sessions', 'signups', 'llm_cost_cents', 'errors_5xx'].map((k) => ({ label: by[k].label, value: by[k].value, pts: by[k].trend, alarm: k === 'errors_5xx' && by[k].raw > 0, color: k === 'errors_5xx' && by[k].raw > 0 ? RD : 'var(--fg)', stroke: k === 'errors_5xx' && by[k].raw > 0 ? RD : AC })),
    learning: learning.map((m) => ({ label: m.label, value: m.value, w: `${Math.max(1, Math.round((m.raw / maxL) * 1000) / 10)}%` })), learningNote: by.flashcards_created.note ? `Flashcards created: ${by.flashcards_created.note}` : '',
    ai: { lead: by.llm_cost_cents.value, rest: `${by.llm_calls.value} LLM calls · ${by.llm_tokens.value} LLM tokens`, note: `LLM cost: ${by.llm_cost_cents.note}` },
    reliability: hot.map((m) => ({ label: m.label, value: m.value, bad: !/^errors_4/.test(m.key), color: /^errors_4/.test(m.key) ? 'var(--fg)' : RD, m: /^errors_4/.test(m.key) ? null : shapeOnly('failed') })), relZeros: zeros.length ? `${zeros.length} more at 0: ${zeros.map((m) => m.label).join(', ')}` : '', relNote: `4xx errors: ${NOTES_P.errors_4xx}`,
    growth: product.find((g) => g.id === 'growth').metrics.map((m) => ({ label: m.label, value: m.value })),
    community: product.find((g) => g.id === 'community').metrics.map((m) => ({ label: m.label, value: m.value })),
    sprint: { label: 'M6 — Notifications GA', due: 'Due Oct 26', pct: '62', w: '62%', counts: '21 closed · 13 open' },
    contributors: [['jose-a', 14, 3, 6], ['meilin', 11, 4, 8], ['dev-raj', 9, 2, 3], ['sanaok', 7, 1, 5], ['priya-k', 6, 2, 2], ['tom-h', 4, 1, 1], ['ana-r', 3, 0, 4], ['kenji-m', 2, 1, 0]].map(([h, p, m, r]) => ({ who: person(h), w: `${Math.round(((p + m + r) / 23) * 100)}%`, nums: `${p} · ${m} · ${r}` })),
    labels: [['enhancement', 9], ['bug', 6], ['infra', 4], ['docs', 3], ['design', 2]].map(([name, n]) => ({ name, n: String(n), w: `${Math.round((n / 9) * 100)}%`, fill: name === 'bug' ? RD : 'var(--border-strong)', color: name === 'bug' ? RD : 'var(--fg)' })),
    todos: { count: '43', delta: '−18', since: 'since Aug 1', pts: sparkPoints([61, 58, 59, 54, 50, 51, 47, 44, 45, 43]) },
  };
}

// ── the Usage tab, in today's shape (repo.ts usageTab): env columns, then Product, then Infrastructure ──
const parseN = (v) => { const m = /^([\d.]+)\s*([KM]?)/.exec(v || ''); if (!m) return null; return parseFloat(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'K' ? 1e3 : 1); };
const splitV = (v) => { const m = /^(\S+)\s+(.+)$/.exec(v || ''); return m ? [m[1], m[2]] : [v || '—', '']; };
export function usageView(o) {
  const u = buildUsage(o);
  if (u.blank) return { blank: true, text: u.text, traffic: [], infra: [] };
  const ORD = { Dev: 0, Staging: 1, Production: 2 };
  const items = u.items.slice().sort((a, b) => (ORD[a.env] ?? 3) - (ORD[b.env] ?? 3));
  const traffic = items.filter((i) => i.kind === 'traffic'), compute = items.filter((i) => i.kind === 'compute');
  const multi = new Set(traffic.map((i) => i.title)).size > 1;
  const tcols = traffic.map((i) => ({ ...i, head: multi ? `${i.title} · ${i.env}` : i.env, host: i.na ? i.sourceName : i.source || i.sourceName,
    metrics: i.metrics.map((m) => ({ ...m, absent: i.stale ? 'no recent reading' : i.nc ? 'not connected' : '' })),
    ncLine: i.nc ? `Connect ${i.sourceName} to see requests and error rate.` : '' }));
  const infra = [];
  const cf = traffic.filter((i) => i.ok && /Cloudflare/.test(i.sourceName));
  if (cf.length) infra.push({ title: `Cloudflare — ${[...new Set(cf.map((i) => i.title))].join(', ')} ${cf.some((i) => i.sourceName === 'Cloudflare Pages') ? 'Pages' : 'Workers'}`, live: true, nc: false,
    cols: cf.map((i) => { const req = parseN(i.raw.req), rate = parseFloat(i.raw.err); const errs = req && !isNaN(rate) ? compact(Math.round(req * rate / 100)) : '—';
      return { env: multi ? `${i.title} · ${i.env}` : i.env, stats: [{ fig: i.raw.req, unit: '', label: 'Workers requests', size: '21px', color: 'var(--fg)' }, { fig: errs, unit: '', label: 'Workers errors', size: '17px', color: 'var(--fg)' }], share: isNaN(rate) ? null : { w: `${Math.max(rate, 0.4)}%`, fill: i.raw.errTone === 'warn' ? AM : 'var(--fg-40)' }, staleText: '' }; }) });
  [...new Set(compute.map((i) => i.title))].forEach((app) => {
    const rows = compute.filter((i) => i.title === app); const src = rows[0].sourceName;
    const allNc = rows.every((r) => r.nc);
    infra.push({ title: `Hosting — ${app} on ${src}`, live: !allNc, nc: allNc, ncText: `No ${src} reading captured for ${app} yet. Connect ${src} in Org settings › Integrations and give each target its ${src} service, and CPU and memory show here for ${rows.map((r) => r.env).join(' and ')}.`, ncAction: `Connect ${src}`,
      cols: rows.map((r) => {
        if (r.stale) return { env: r.env, stats: [{ fig: '—', unit: '', label: 'CPU', size: '21px', color: 'var(--fg-40)' }, { fig: '—', unit: '', label: 'Memory', size: '21px', color: 'var(--fg-40)' }], share: null, staleText: `No recent reading · last ${r.raw.last}` };
        if (r.nc) return { env: r.env, stats: [{ fig: '—', unit: '', label: 'CPU', size: '21px', color: 'var(--fg-40)' }, { fig: '—', unit: '', label: 'Memory', size: '21px', color: 'var(--fg-40)' }], share: null, staleText: 'not connected' };
        const [mf, mu] = splitV(r.raw.mem);
        return { env: r.env, stats: [{ fig: r.raw.cpu, unit: r.raw.cpuOf || '', label: 'CPU', size: '21px', color: 'var(--fg)' }, { fig: mf, unit: `${mu}${r.raw.memOf ? ' ' + r.raw.memOf : ''}`, label: 'Memory', size: '21px', color: 'var(--fg)' }], share: null, staleText: '' };
      }) });
  });
  const single = tcols.length === 1;
  tcols.forEach((c) => {
    c.mcols = single ? 'repeat(auto-fit,minmax(min(220px,100%),1fr))' : 'minmax(0,1fr)';
    c.cellPad = single ? '12px 20px' : '12px 0';
    c.inMargin = single ? '-1px 0 0 -1px' : '0';
    c.cellLeft = single ? '1px solid var(--border)' : '0';
    c.wrapMx = single ? '0 -20px' : '0';
    c.metrics = c.metrics.map((m) => ({ ...m, share: null, sub: '' }));
  });
  if (single && infra.length && /^Cloudflare/.test(infra[0].title) && infra[0].cols.length === 1) {
    const col = infra.shift().cols[0];
    const c = tcols[0];
    if (c.ok) c.metrics.push({ label: 'Workers errors', value: col.stats[1].fig, color: 'var(--fg)', pts: '', stroke: '', share: col.share, sub: 'errors as a share of requests', absent: '' });
  }
  return { blank: false, traffic: tcols, infra, single };
}

// ── more for Usage: what the host and the app itself report, per range ──────────
const SCALE = { '24h': 1 / 7, '7d': 1, '30d': 30 / 7 };
const cnt = (n, r) => compact(Math.round(n * SCALE[r]));
const daySeries = (base, r, k) => { const n = r === '24h' ? 24 : r === '7d' ? 14 : 30; return sparkPoints(Array.from({ length: n }, (_, i) => base * (0.75 + 0.25 * Math.sin(i * 0.9 + k) + ((i * 7 + k * 3) % 5) * 0.04))); };
function workerExtras(o, name, env, req7, opt = {}) {
  const r = o.range || '7d';
  const ok = req7 * 0.962, c4 = req7 * 0.0355, c5 = req7 * (opt.failed ? 0.0031 : 0.0019), lim = req7 * 0.0006;
  const tot = ok + c4 + c5 + lim;
  const seg = (label, n, fill, mk) => ({ label, value: cnt(n, r), w: `${Math.max(0.6, (n / tot) * 100).toFixed(2)}%`, fill, m: mk });
  return {
    target: `${name} · ${env}`,
    outcome: [seg('Success', ok, G, shapeOnly('live')), seg('Client errors (4xx)', c4, 'var(--fg-40)', { shape: 'square', tone: 'var(--fg-40)', word: '' }), seg('Server errors (5xx)', c5, RD, shapeOnly('failed')), seg('Exceeded limits', lim, AM, shapeOnly('waiting'))],
    outcomeNote: 'Client errors include bots and refused polls; they never raise a colour.',
    perf: [{ fig: opt.cpu50 || '1.8', unit: 'ms', label: 'CPU time p50' }, { fig: opt.cpu99 || '14.2', unit: 'ms', label: 'CPU time p99' }, { fig: opt.wall50 || '38', unit: 'ms', label: 'Wall time p50' }, { fig: cnt(req7 * 0.28, r), unit: '', label: 'Subrequests' }],
    perfPts: daySeries(14, r, 2), perfNote: 'CPU time p99 per day',
  };
}
export function usageExtras(o) {
  const r = o.range || '7d';
  if (o.scenario === 'B' || (o.scenario === 'N' && o.variant === 'trov')) {
    const failed = o.variant === 'failed';
    const w = workerExtras(o, 'trov', 'Production', 335000, { failed, cpu50: '2.1', cpu99: failed ? '31.6' : '16.4', wall50: '42' });
    const tools = [['query', 4210], ['get_doc', 1930], ['get_my_work', 862], ['record_session', 312], ['append_feed', 298], ['get_repo_dashboard', 164], ['propose_doc_update', 141]];
    const maxT = tools[0][1];
    return { ...w,
      d1: { name: 'trov', stats: [{ fig: cnt(1210000, r), unit: '', label: 'Read queries' }, { fig: cnt(48300, r), unit: '', label: 'Write queries' }, { fig: cnt(36800000, r), unit: '', label: 'Rows read' }, { fig: cnt(212000, r), unit: '', label: 'Rows written' }, { fig: '0.9', unit: 'ms', label: 'Query time p50' }, { fig: '41.6', unit: 'MB', label: 'Database size' }], pts: daySeries(170, r, 5), note: 'Read queries per day · size is right now' },
      crons: [
        { expr: '*/10 * * * *', what: 'Repo capture', src: 'src/repo/cron.ts', runs: cnt(1008, r), failed: failed ? (r === '24h' ? '1' : '3') : (r === '24h' ? '0' : '2'), last: '4m ago', m: shapeOnly(failed ? 'failed' : 'live') },
        { expr: '0 13 * * *', what: 'Daily digest email', src: 'src/notifications', runs: r === '24h' ? '1' : r === '7d' ? '7' : '30', failed: '0', last: '1h ago', m: shapeOnly('live') },
        { expr: '0 13 * * MON', what: 'Weekly digest email', src: 'src/notifications', runs: r === '24h' ? '0' : r === '7d' ? '1' : '4', failed: '0', last: '2d ago', m: shapeOnly('live') },
      ],
      product: {
        source: 'from trov’s own /metrics endpoint',
        now: [['6', 'People'], ['184', 'Live docs'], ['7', 'Awaiting review'], ['3', 'In triage'], ['41', 'Open tickets']].map(([value, label]) => ({ value, label })),
        tools: tools.map(([t, n]) => ({ label: t, value: cnt(n, r), w: `${Math.round((n / maxT) * 1000) / 10}%` })),
        gate: [['Staged', 451], ['Promoted', 388], ['Rejected', 21], ['To triage', 42], ['No-op (same content)', 96]].map(([label, n]) => ({ label, value: cnt(n, r) })),
        people: [['Sessions recorded', 312], ['Agents connected', 9], ['People active', 6]].map(([label, n], i) => ({ label, value: i ? String(n) : cnt(n, r) })),
        gateNote: 'Every agent write goes through the gate; a person promotes or rejects it.',
      } };
  }
  if (o.scenario === 'A' || (o.scenario === 'N' && o.variant !== 'trov')) return { ...workerExtras(o, 'web', 'Production', 1240000), d1: null, crons: [], product: null };
  return null;
}
