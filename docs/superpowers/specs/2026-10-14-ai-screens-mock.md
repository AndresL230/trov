# Trov AI screens: mockup source

Static reference markup for four screens, from the Claude Design canvas "Trov AI screens". It is layout and wording only, not code to copy:

- **Ignore the template syntax:** `{{…}}`, `<sc-if>`, `<sc-for>` and `<x-dc>` are the canvas's own.
- **Colours are written as hex; map them to `trov.css` tokens:**
  - `#16161a` → `--fg`
  - `#4f4f58` → `--fg-70`
  - `#6e6e78` → `--fg-55`
  - `#525cc3` → `--accent`
  - `rgba(82,92,195,0.12)` → `--accent-soft`
  - `#007545` → `--green`
  - `#945800` → `--amber`
  - `#c22231` → `--red`
  - `#2467af` → `--blue`
  - `rgba(20,20,30,0.08)` → `--border`
  - `#ffffff` → `--surface`
  - `#f6f6f7` → `--bg`
  - `--p-*` for the theme lanes
- **The sidebar is omitted;** the app already has one.
- **The data is sample data.**

## My Work: Your brief

```html
<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 32px clamp(16px, 4vw, 48px) 48px; display: flex; flex-direction: column; gap: 24px; max-width: 1100px">
    <header style="display: flex; flex-direction: column; gap: 2px">
      <h1 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em">My Work</h1>
      <p style="margin: 0; color: #6e6e78">Andres Lopez in Personal Dev</p>
    </header>

    <section aria-labelledby="brief-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; box-shadow: 0 1px 2px rgba(20,20,30,0.05); padding: 20px 22px; display: flex; flex-direction: column; gap: 16px">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
        <h2 id="brief-h" style="margin: 0; font-size: 16px; font-weight: 600">Your brief</h2>
        <div style="display: flex; align-items: center; gap: 14px; color: #6e6e78; font-size: 12.5px">
          <span title="Written by Trov from your sessions, pull requests, tickets and handoffs. Not official; check the sources." style="display: inline-flex; align-items: center; gap: 6px">
            <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z" fill="#525cc3"></path></svg>
            Written by Trov, 12 min ago
          </span>
          <button type="button" style="font: inherit; color: #4f4f58; background: none; border: 1px solid rgba(20,20,30,0.15); border-radius: 6px; padding: 4px 10px; min-height: 30px; cursor: pointer">Wrong?</button>
        </div>
      </div>

      <sc-if value="{{showReady}}" hint-placeholder-val="{{ true }}">
        <div style="display: grid; grid-template-columns: 92px minmax(0, 1fr); column-gap: 18px; row-gap: 16px">
          <div style="font-family: 'Archivo Narrow', sans-serif; font-weight: 600; color: #6e6e78; font-size: 13.5px; padding-top: 1px">Now</div>
          <div style="display: flex; flex-direction: column; gap: 6px">
            <p style="margin: 0">You are partway through the hosting screens on <code style="font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; background: rgba(20,20,30,0.05); padding: 1px 5px; border-radius: 4px">feat/hosting-screens</code>. The last push failed CI on the Netlify connect test.</p>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 12.5px">
              <a href="#">feat/hosting-screens</a><span style="color: #6e6e78">·</span><a href="#">CI run 4812</a>
            </div>
          </div>

          <div style="font-family: 'Archivo Narrow', sans-serif; font-weight: 600; color: #6e6e78; font-size: 13.5px; padding-top: 1px">Recently</div>
          <div style="display: flex; flex-direction: column; gap: 6px">
            <p style="margin: 0">Shipped status marks across the app, site and digests, and release 0.30 with public docs and account deletion. Trov now connects to Claude on the web.</p>
            <div style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 12.5px">
              <a href="#">#173</a><span style="color: #6e6e78">·</span><a href="#">#172</a><span style="color: #6e6e78">·</span><a href="#">#171</a>
            </div>
          </div>

          <div style="font-family: 'Archivo Narrow', sans-serif; font-weight: 600; color: #6e6e78; font-size: 13.5px; padding-top: 1px">Next</div>
          <ol style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px">
            <li style="display: flex; gap: 12px; align-items: baseline">
              <span style="display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: #c22231; font-size: 12.5px"><span style="width: 7px; height: 7px; border-radius: 50%; background: #c22231"></span>Failing</span>
              <div style="display: flex; flex-direction: column"><a href="#" style="color: #16161a; font-weight: 500">Fix the Netlify connect test</a><span style="color: #6e6e78; font-size: 13px">It blocks the hosting PR you are working on.</span></div>
            </li>
            <li style="display: flex; gap: 12px; align-items: baseline">
              <span style="display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: #4f4f58; font-size: 12.5px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 12h12M12 6l6 6-6 6"></path></svg>Handoff</span>
              <div style="display: flex; flex-direction: column"><a href="#" style="color: #16161a; font-weight: 500">Performance plan for trov.dev</a><span style="color: #6e6e78; font-size: 13px">Left for anyone yesterday. Nothing in it is built yet.</span></div>
            </li>
            <li style="display: flex; gap: 12px; align-items: baseline">
              <span style="display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; color: #4f4f58; font-size: 12.5px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"></rect></svg>#14</span>
              <div style="display: flex; flex-direction: column"><a href="#" style="color: #16161a; font-weight: 500">Guided repository setup</a><span style="color: #6e6e78; font-size: 13px">Assigned to you. It builds on the hosting work.</span></div>
            </li>
          </ol>
        </div>
      </sc-if>

      <sc-if value="{{showEmpty}}" hint-placeholder-val="{{ false }}">
        <p style="margin: 0; color: #4f4f58">Trov writes your brief after your next push or when something is assigned to you. It reads your sessions, pull requests, tickets and handoffs.</p>
      </sc-if>

      <sc-if value="{{showCapped}}" hint-placeholder-val="{{ false }}">
        <div style="display: flex; flex-direction: column; gap: 8px">
          <p style="margin: 0; color: #4f4f58">You are partway through the hosting screens on feat/hosting-screens. The last push failed CI on the Netlify connect test.</p>
          <p style="margin: 0; font-size: 13px; color: #945800">Monthly AI allowance used; your brief resumes Nov 1. <a href="#">Upgrade to Pro</a></p>
        </div>
      </sc-if>
    </section>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px">
      <section aria-labelledby="prev-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px">
        <h2 id="prev-h" style="margin: 0; font-size: 14px; font-weight: 600">Previous activity</h2>
        <div style="display: flex; flex-direction: column; gap: 2px"><a href="#" style="color: #16161a; font-weight: 500">Replace status tags with status marks</a><span style="color: #6e6e78; font-size: 12.5px">#173 · merged yesterday</span></div>
        <div style="display: flex; flex-direction: column; gap: 2px"><a href="#" style="color: #16161a; font-weight: 500">Release 0.30: crawlable site, public docs</a><span style="color: #6e6e78; font-size: 12.5px">#172 · merged yesterday</span></div>
        <div style="display: flex; flex-direction: column; gap: 2px"><a href="#" style="color: #16161a; font-weight: 500">Connect GitHub orgs with partial access</a><span style="color: #6e6e78; font-size: 12.5px">#171 · merged 2 days ago</span></div>
      </section>
      <section aria-labelledby="todo-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px">
        <h2 id="todo-h" style="margin: 0; font-size: 14px; font-weight: 600">To-do</h2>
        <p style="margin: 0; color: #6e6e78">No open issues assigned to you.</p>
      </section>
      <section aria-labelledby="tix-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 12px">
        <h2 id="tix-h" style="margin: 0; font-size: 14px; font-weight: 600">Tickets</h2>
        <div style="display: flex; flex-direction: column; gap: 2px"><a href="#" style="color: #16161a; font-weight: 500">Guided repository setup</a><span style="color: #6e6e78; font-size: 12.5px">#14 · Submitted</span></div>
        <div style="display: flex; flex-direction: column; gap: 2px"><a href="#" style="color: #16161a; font-weight: 500">A Repo dashboard that fits the repository</a><span style="color: #6e6e78; font-size: 12.5px">#6 · Submitted</span></div>
      </section>
    </div>
  </main>
```

The mock's tweak switches between three states: ready, empty and capped. The empty and capped wording is inside the `sc-if` blocks above.

## Repo › Overview: State

```html
<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 28px clamp(16px, 4vw, 48px) 48px; display: flex; flex-direction: column; gap: 20px; max-width: 1100px">
    <header style="display: flex; flex-direction: column; gap: 14px">
      <div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px">
        <span style="color: #6e6e78">Repo</span><span style="color: #6e6e78">/</span>
        <h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em">AndresL230/trov</h1>
      </div>
      <div role="tablist" aria-label="Repo sections" style="display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid rgba(20,20,30,0.08)">
        <button type="button" role="tab" aria-selected="true" style="font: inherit; background: none; border: none; border-bottom: 2px solid #525cc3; padding: 8px 12px; font-weight: 500; color: #16161a; cursor: pointer">Overview</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">Code</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">CI</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">Usage</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">Planning</button>
      </div>
    </header>

    <section aria-labelledby="state-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; box-shadow: 0 1px 2px rgba(20,20,30,0.05); padding: 20px 22px; display: flex; flex-direction: column; gap: 18px">
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px">
        <h2 id="state-h" style="margin: 0; font-size: 13.5px; font-weight: 600; font-family: 'Archivo Narrow', sans-serif; color: #6e6e78">State</h2>
        <span title="Written by Trov from captured events, tickets and the plan. Not official; check the sources." style="display: inline-flex; align-items: center; gap: 6px; color: #6e6e78; font-size: 12.5px">
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z" fill="#525cc3"></path></svg>
          Written by Trov from 6 events, 2h ago
        </span>
      </div>

      <sc-if value="{{showReady}}" hint-placeholder-val="{{ true }}">
        <div style="display: flex; flex-direction: column; gap: 18px">
          <p style="margin: 0; font-size: 18px; font-weight: 500; line-height: 1.4; letter-spacing: -0.005em; max-width: 64ch">Release 0.30 is live; hosting screens are the open front, and main is green.</p>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 20px">
            <div style="display: flex; flex-direction: column; gap: 10px">
              <h3 style="margin: 0; font-size: 13px; font-weight: 600; color: #007545; display: flex; align-items: center; gap: 6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12l4 4 10-10"></path></svg>Shipped recently</h3>
              <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px">
                <li>Status marks replace status tags everywhere. <a href="#">#173</a></li>
                <li>Release 0.30: public docs, account deletion, compliance pass. <a href="#">#172</a></li>
                <li>Claude on the web connector; partial-access GitHub orgs. <a href="#">#171</a></li>
              </ul>
            </div>
            <div style="display: flex; flex-direction: column; gap: 10px">
              <h3 style="margin: 0; font-size: 13px; font-weight: 600; color: #2467af; display: flex; align-items: center; gap: 6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle><path d="M12 5a7 7 0 0 1 0 14z" fill="currentColor"></path></svg>In flight</h3>
              <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px">
                <li>Hosting screens for Vercel and Netlify. <a href="#">feat/hosting-screens</a></li>
                <li>Performance plan for trov.dev, waiting on an owner. <a href="#">handoff #3</a></li>
              </ul>
            </div>
            <div style="display: flex; flex-direction: column; gap: 10px">
              <h3 style="margin: 0; font-size: 13px; font-weight: 600; color: #945800; display: flex; align-items: center; gap: 6px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M12 4l9 16H3z"></path><path d="M12 10v4"></path></svg>Needs attention</h3>
              <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px">
                <li>CI failing on the hosting branch since this morning. <a href="#">run 4812</a></li>
                <li>28 open tickets, none in a sprint. <a href="#">Tickets</a></li>
              </ul>
            </div>
          </div>
        </div>
      </sc-if>

      <sc-if value="{{showEmpty}}" hint-placeholder-val="{{ false }}">
        <p style="margin: 0; color: #4f4f58">Trov writes this after your next merge: what shipped, what is in flight, and what needs attention, each linked to its source.</p>
      </sc-if>

      <sc-if value="{{showCapped}}" hint-placeholder-val="{{ false }}">
        <div style="display: flex; flex-direction: column; gap: 8px">
          <p style="margin: 0; font-size: 18px; font-weight: 500">Release 0.30 is live; hosting screens are the open front, and main is green.</p>
          <p style="margin: 0; font-size: 13px; color: #945800">Monthly AI allowance used; this state is from Oct 22 and resumes Nov 1. <a href="#">Upgrade to Pro</a></p>
        </div>
      </sc-if>

      <div style="display: flex; justify-content: flex-end">
        <button type="button" style="font: inherit; font-size: 12.5px; color: #4f4f58; background: none; border: 1px solid rgba(20,20,30,0.15); border-radius: 6px; padding: 4px 10px; min-height: 30px; cursor: pointer">Wrong?</button>
      </div>
    </section>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px">
      <section aria-labelledby="env-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px">
        <h2 id="env-h" style="margin: 0; font-size: 13.5px; font-weight: 600; font-family: 'Archivo Narrow', sans-serif; color: #6e6e78">Environments</h2>
        <div style="display: flex; justify-content: space-between; gap: 12px"><span style="font-weight: 500">production</span><span style="display: inline-flex; align-items: center; gap: 6px; color: #007545"><span style="width: 7px; height: 7px; border-radius: 50%; background: #007545"></span>Healthy</span></div>
        <span style="color: #6e6e78; font-size: 13px">main at 65b9f1f, deployed yesterday</span>
      </section>
      <section aria-labelledby="stats-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px">
        <h2 id="stats-h" style="margin: 0; font-size: 13.5px; font-weight: 600; font-family: 'Archivo Narrow', sans-serif; color: #6e6e78">This week</h2>
        <div style="display: flex; gap: 24px">
          <div style="display: flex; flex-direction: column"><span style="font-size: 22px; font-weight: 600">6</span><span style="color: #6e6e78; font-size: 12.5px">PRs merged</span></div>
          <div style="display: flex; flex-direction: column"><span style="font-size: 22px; font-weight: 600">1</span><span style="color: #6e6e78; font-size: 12.5px">CI failing</span></div>
          <div style="display: flex; flex-direction: column"><span style="font-size: 22px; font-weight: 600">28</span><span style="color: #6e6e78; font-size: 12.5px">Open tickets</span></div>
        </div>
      </section>
    </div>
  </main>
```

The mock's tweak switches between three states: ready, empty and capped. The empty and capped wording is inside the `sc-if` blocks above.

## Feed: entries written by Trov

```html
<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 28px clamp(16px, 4vw, 48px) 48px; display: flex; flex-direction: column; gap: 18px; max-width: 900px">
    <header style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px">
      <h1 style="margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -0.01em">Feed</h1>
      <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center">
        <div role="radiogroup" aria-label="Source" style="display: inline-flex; padding: 2px; background: rgba(20,20,30,0.05); border-radius: 8px">
          <button type="button" role="radio" aria-checked="true" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: #ffffff; box-shadow: 0 1px 2px rgba(20,20,30,0.08); color: #16161a; cursor: pointer">All</button>
          <button type="button" role="radio" aria-checked="false" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: none; color: #4f4f58; cursor: pointer">Agents</button>
          <button type="button" role="radio" aria-checked="false" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: none; color: #4f4f58; cursor: pointer">Trov</button>
        </div>
        <div role="radiogroup" aria-label="View" style="display: inline-flex; padding: 2px; background: rgba(20,20,30,0.05); border-radius: 8px">
          <button type="button" role="radio" aria-checked="true" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: #ffffff; box-shadow: 0 1px 2px rgba(20,20,30,0.08); color: #16161a; cursor: pointer">For reading</button>
          <button type="button" role="radio" aria-checked="false" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: none; color: #4f4f58; cursor: pointer">For agents</button>
        </div>
      </div>
    </header>

    <sc-if value="{{showNote}}" hint-placeholder-val="{{ true }}">
      <aside aria-label="New" style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; background: rgba(82,92,195,0.08); border: 1px solid rgba(82,92,195,0.22); border-radius: 10px; padding: 12px 16px">
        <p style="margin: 0; flex: 1 1 320px">Trov now writes entries from your commits, about 45 minutes after your last push. Your agents can stick to decisions and findings. <a href="#">AI settings</a></p>
        <button type="button" style="font: inherit; font-size: 13px; border: 1px solid rgba(20,20,30,0.15); background: #ffffff; border-radius: 6px; padding: 5px 12px; min-height: 32px; cursor: pointer">Got it</button>
      </aside>
    </sc-if>

    <article style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px">
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; color: #6e6e78">
        <span aria-hidden="true" style="width: 26px; height: 26px; border-radius: 7px; background: rgba(82,92,195,0.12); display: inline-flex; align-items: center; justify-content: center"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z" fill="#525cc3"></path></svg></span>
        <span style="color: #16161a; font-weight: 500">Trov</span>
        <span title="Written by Trov from 4 commits and 1 pull request by andres. Not official; check the sources.">for <a href="#">andres</a></span>
        <span>· 1h ago</span>
      </div>
      <h2 style="margin: 0; font-size: 16px; font-weight: 600">Shipped: status marks replace status tags across the app</h2>
      <p style="margin: 0; color: #4f4f58">States now read the same everywhere, with a short word and a shape you can hover for what it means, so a glance at any screen tells you where things stand.</p>
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; color: #6e6e78">
        <span>From <a href="#">#173</a>, <a href="#">65b9f1f</a>, <a href="#">a1c04e2</a> and 2 more</span>
        <button type="button" style="font: inherit; font-size: 12.5px; color: #4f4f58; background: none; border: 1px solid rgba(20,20,30,0.15); border-radius: 6px; padding: 3px 10px; min-height: 28px; cursor: pointer">Wrong?</button>
      </div>
    </article>

    <article style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px">
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; color: #6e6e78">
        <span aria-hidden="true" style="width: 26px; height: 26px; border-radius: 50%; background: #2f7d57; color: #ffffff; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600">AL</span>
        <span style="color: #16161a; font-weight: 500">andres</span>
        <span>via Claude Code · 3h ago</span>
      </div>
      <h2 style="margin: 0; font-size: 16px; font-weight: 600">Decision: hosting connections stay read-only</h2>
      <p style="margin: 0; color: #4f4f58">Trov reads deployments from Vercel and Netlify but never changes anything there, so a connected key can't break a customer's site.</p>
      <div style="font-size: 12.5px; color: #6e6e78">Cites <a href="#">feat/hosting-screens</a></div>
    </article>

    <article style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; padding: 18px 20px; display: flex; flex-direction: column; gap: 10px">
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 13px; color: #6e6e78">
        <span aria-hidden="true" style="width: 26px; height: 26px; border-radius: 7px; background: rgba(82,92,195,0.12); display: inline-flex; align-items: center; justify-content: center"><svg width="14" height="14" viewBox="0 0 24 24"><path d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z" fill="#525cc3"></path></svg></span>
        <span style="color: #16161a; font-weight: 500">Trov</span>
        <span>for <a href="#">andres</a></span>
        <span>· 5h ago</span>
      </div>
      <h2 style="margin: 0; font-size: 16px; font-weight: 600">Status: hosting screens are partway, CI is red</h2>
      <p style="margin: 0; color: #4f4f58">The Vercel and Netlify connect screens are drafted on a branch. The Netlify connect test fails, so nothing is merged yet.</p>
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; font-size: 12.5px; color: #6e6e78">
        <span>From <a href="#">feat/hosting-screens</a> and <a href="#">run 4812</a></span>
        <button type="button" style="font: inherit; font-size: 12.5px; color: #4f4f58; background: none; border: 1px solid rgba(20,20,30,0.15); border-radius: 6px; padding: 3px 10px; min-height: 28px; cursor: pointer">Wrong?</button>
      </div>
    </article>
  </main>
```

## Repo › Planning: Where the work went

```html
<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 28px clamp(16px, 4vw, 48px) 48px; display: flex; flex-direction: column; gap: 20px; max-width: 1100px">
    <header style="display: flex; flex-direction: column; gap: 14px">
      <div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px">
        <span style="color: #6e6e78">Repo</span><span style="color: #6e6e78">/</span>
        <h1 style="margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em">AndresL230/trov</h1>
      </div>
      <div role="tablist" aria-label="Repo sections" style="display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid rgba(20,20,30,0.08)">
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">Overview</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">Code</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">CI</button>
        <button type="button" role="tab" aria-selected="false" style="font: inherit; background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; color: #6e6e78; cursor: pointer">Usage</button>
        <button type="button" role="tab" aria-selected="true" style="font: inherit; background: none; border: none; border-bottom: 2px solid #525cc3; padding: 8px 12px; font-weight: 500; color: #16161a; cursor: pointer">Planning</button>
      </div>
    </header>

    <section aria-labelledby="where-h" style="background: #ffffff; border: 1px solid rgba(20,20,30,0.08); border-radius: 10px; box-shadow: 0 1px 2px rgba(20,20,30,0.05); padding: 22px; display: flex; flex-direction: column; gap: 18px">
      <div style="display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px">
        <div style="display: flex; flex-direction: column; gap: 6px; flex: 1 1 420px">
          <h2 id="where-h" style="margin: 0; font-size: 18px; font-weight: 600">Where the work went</h2>
          <p style="margin: 0; color: #4f4f58; max-width: 62ch">Since late August most of the work went to multi-org and the GitHub App. October turned to the public site, billing and polish; tickets went quiet after September.</p>
          <span style="display: inline-flex; align-items: center; gap: 6px; color: #6e6e78; font-size: 12.5px"><svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z" fill="#525cc3"></path></svg>Themes and caption written by Trov from 64 pull requests</span>
        </div>
        <div style="display: flex; gap: 8px; align-items: center">
          <div role="radiogroup" aria-label="Range" style="display: inline-flex; padding: 2px; background: rgba(20,20,30,0.05); border-radius: 8px">
            <button type="button" role="radio" aria-checked="true" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: #ffffff; box-shadow: 0 1px 2px rgba(20,20,30,0.08); cursor: pointer">8 weeks</button>
            <button type="button" role="radio" aria-checked="false" style="font: inherit; font-size: 13px; border: none; border-radius: 6px; padding: 5px 12px; min-height: 30px; background: none; color: #4f4f58; cursor: pointer">Quarter</button>
          </div>
          <button type="button" style="font: inherit; font-size: 13px; border: 1px solid rgba(20,20,30,0.15); background: #ffffff; border-radius: 6px; padding: 5px 12px; min-height: 34px; cursor: pointer">Edit themes</button>
        </div>
      </div>

      <div style="overflow-x: auto">
        <div style="min-width: 640px; display: flex; flex-direction: column; gap: 4px">
          <div style="display: grid; grid-template-columns: 190px repeat(8, minmax(0, 1fr)); gap: 6px; font-size: 12px; color: #6e6e78; padding-bottom: 4px; border-bottom: 1px solid rgba(20,20,30,0.08)">
            <span></span>
            <sc-for list="{{weeks}}" as="wk" hint-placeholder-count="8"><span style="text-align: center">{{wk}}</span></sc-for>
          </div>
          <sc-for list="{{lanes}}" as="lane" hint-placeholder-count="6">
            <button type="button" onClick="{{lane.pick}}" aria-pressed="{{lane.pressed}}" style="font: inherit; color: inherit; text-align: left; background: {{lane.rowBg}}; border: none; border-radius: 8px; padding: 6px 4px; min-height: 52px; cursor: pointer; display: grid; grid-template-columns: 190px repeat(8, minmax(0, 1fr)); gap: 6px; align-items: center; opacity: {{lane.opacity}}">
              <span style="display: flex; align-items: center; gap: 8px; padding-left: 6px; font-weight: 500; font-size: 13.5px"><span style="width: 10px; height: 10px; border-radius: 3px; background: {{lane.color}}; flex: 0 0 auto"></span>{{lane.name}}</span>
              <sc-for list="{{lane.cells}}" as="cell" hint-placeholder-count="8">
                <span style="display: flex; align-items: center; justify-content: center; height: 40px"><span style="display: block; width: 100%; height: {{cell.h}}px; border-radius: 4px; background: {{lane.color}}"></span></span>
              </sc-for>
            </button>
          </sc-for>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 8px; border-top: 1px solid rgba(20,20,30,0.08); padding-top: 16px">
        <h3 style="margin: 0; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px"><span style="width: 10px; height: 10px; border-radius: 3px; background: {{sel.color}}"></span>{{sel.name}}</h3>
        <p style="margin: 0; color: #4f4f58">{{sel.note}}</p>
        <ul style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px">
          <sc-for list="{{sel.prs}}" as="pr" hint-placeholder-count="3"><li><a href="#">{{pr}}</a></li></sc-for>
        </ul>
      </div>
      <p style="margin: 0; font-size: 12px; color: #6e6e78">Sample data shaped on Trov's own history; band height is merged work per week.</p>
    </section>
  </main>
```

The sample data and the lane interaction (one lane selected, the others faded):

```js
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":1280,"height":900}}'>
class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { picked: 'multiorg' };
  }
  renderVals() {
    const data = [
      { id: 'multiorg', name: 'Multi-org and GitHub App', color: '#3e6f8a', w: [0, 0, 0.2, 0.6, 0.9, 1, 0.7, 0.3], note: 'The move from one team to many organizations, the rename to Trov, and the GitHub App install flow.', prs: ['#171 One GitHub account, several orgs', 'Multi-org re-architecture', 'GitHub App install flow'] },
      { id: 'tickets', name: 'Tickets and sprints', color: '#2f7d57', w: [0.3, 0.8, 1, 0.7, 0.3, 0.1, 0, 0], note: 'Tickets as their own records, sprints replacing milestones, and GitHub issues mirrored in.', prs: ['Tickets and the board', 'GitHub issues mirrored as tickets'] },
      { id: 'repo', name: 'Repo dashboard', color: '#5b6b8c', w: [0.5, 0.6, 0.4, 0.6, 0.5, 0.3, 0.4, 0.2], note: 'Capture, health and metrics; hosting connections are the open thread.', prs: ['Repo dashboard capture', 'Hosting connections (in flight)'] },
      { id: 'billing', name: 'Billing and plans', color: '#966800', w: [0, 0, 0, 0, 0.2, 0.4, 0.8, 0.5], note: 'Per-seat Pro, Stripe Checkout and the embedded checkout.', prs: ['#136 Embedded checkout', 'Per-seat Pro plan'] },
      { id: 'site', name: 'Public site and docs', color: '#7a4f8f', w: [0, 0, 0, 0, 0.1, 0.3, 0.6, 1], note: 'The crawlable site, public docs, legal pages and the mobile layout.', prs: ['#172 Release 0.30: crawlable site, public docs', '#139 Mobile marketing site'] },
      { id: 'polish', name: 'UI polish', color: '#a84a68', w: [0.2, 0.1, 0.2, 0.3, 0.2, 0.2, 0.5, 0.9], note: 'Status marks, the Review page and smaller fixes across screens.', prs: ['#173 Status marks', '#138 Review page'] }
    ];
    const picked = this.state.picked;
    const lanes = data.map((d) => ({
      name: d.name,
      color: d.color,
      pressed: d.id === picked ? 'true' : 'false',
      rowBg: d.id === picked ? 'rgba(20,20,30,0.04)' : 'transparent',
      opacity: d.id === picked ? '1' : '0.55',
      cells: d.w.map((v) => ({ h: v === 0 ? 2 : Math.round(6 + v * 30) })),
      pick: () => this.setState({ picked: d.id })
    }));
    const s = data.find((d) => d.id === picked) || data[0];
    return {
      weeks: ['Aug 24', 'Aug 31', 'Sep 7', 'Sep 14', 'Sep 21', 'Sep 28', 'Oct 5', 'Oct 12'],
      lanes: lanes,
      sel: { name: s.name, color: s.color, note: s.note, prs: s.prs }
    };
  }
}
</script>
```
