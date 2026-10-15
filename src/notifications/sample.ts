// The preview fixtures (Phase E): canned digests for the admin preview (`GET …/notifications/preview?sample=<name>`)
// and the sample test send, so every shape of the shorter e-mail can be seen on localhost without a busy org or a
// model. Built with the REAL renderers' pure halves (`renderBrief`, `renderWeek`, `queueLine`) over sample content —
// the same markup a real run produces. Every one is marked as sample data in its words.
import type { RunCadence, Section } from "@shared/notifications";
import type { AiLine } from "@shared/ai";
import { renderBrief, type BriefContent } from "./renderers/my-work";
import { renderWeek } from "./renderers/week-recap";
import { appHref, queueLine } from "./assemble";

export const SAMPLE_SCENARIOS = ["daily-ai", "daily-off", "daily-empty", "weekly-ai", "weekly-off", "only-when-needed"] as const;
export type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];
export const isSampleScenario = (v: unknown): v is SampleScenario => typeof v === "string" && (SAMPLE_SCENARIOS as readonly string[]).includes(v);

/** What each fixture shows, for the preview's index. */
export const SAMPLE_LABEL: Record<SampleScenario, string> = {
  "daily-ai": "Daily, AI on: the brief's Now and Next, Also, and the queue lines",
  "daily-off": "Daily, AI off: the 3 most recent assigned tickets in plain words, and the queue lines",
  "daily-empty": "Daily with almost nothing: every empty section left out — one line",
  "weekly-ai": "Weekly, AI on: the brief, This week's cited highlights and the numbers line",
  "weekly-off": "Weekly, AI off: the assigned tickets and the numbers line",
  "only-when-needed": "\"Only when something needs me\" with nothing that does: not sent",
};

const GH = "https://github.com/AndresL230/trov";

const BRIEF_AI: BriefContent = {
  source: "brief",
  now: "You have the hosting providers pull request #171 open, and its Netlify preview test is failing. (Sample data.)",
  next: [
    { title: "Netlify test failing", href: `${GH}/actions/runs/4812`, line: "It is failing on your pull request #171, so it cannot merge." },
    { title: "Poll Vercel deploys", href: appHref("#tickets/41"), line: "Its sprint, Hosting, is due Friday." },
    { title: "Review the hosting docs page", href: appHref("#handoffs/7"), line: "Luke left it for you." },
  ],
  nextTotal: 4,
  also: [
    { title: "Repository setups", href: `${GH}/pull/172`, importance: "breaking", at: "2026-09-11T08:00:00Z" },
    { title: "Hosting deploys now poll every hour", href: appHref("#feed"), importance: "notable", at: "2026-09-11T06:00:00Z" },
  ],
};

const BRIEF_OFF: BriefContent = {
  source: "assigned",
  now: null,
  next: [
    { title: "Netlify test failing (sample)", href: appHref("#tickets/40"), line: "In progress, in the Hosting sprint" },
    { title: "Poll Vercel deploys (sample)", href: appHref("#tickets/41"), line: "Not started, in the Hosting sprint, high priority" },
    { title: "Hosting docs page (sample)", href: appHref("#tickets/42"), line: "Not started" },
  ],
  nextTotal: 3,
  also: [],
};

const HIGHLIGHTS: AiLine[] = [
  { text: "Repository setups shipped: each repository now names its environments and the branch each one deploys. (Sample data.)", cites: [{ ref: "pr:172", label: "#172", href: `${GH}/pull/172` }] },
  { text: "Netlify and Vercel joined Cloudflare as hosting providers, with deploys polled every hour.", cites: [{ ref: "pr:171", label: "#171", href: `${GH}/pull/171` }, { ref: "feed:118", label: "Hosting deploys now poll every hour", href: "#feed" }] },
  { text: "The Hosting sprint's provider connection card and deploy list are done.", cites: [{ ref: "ticket:38", label: "#38", href: "#tickets/38" }, { ref: "ticket:39", label: "#39", href: "#tickets/39" }] },
];

const REVIEW = queueLine({ label: "Review", rest: "2 waiting, 1 changes a decision", deepLink: "/#review", linkLabel: "Review" });
const REVIEW_OFF = queueLine({ label: "Review", rest: "2 waiting", deepLink: "/#review", linkLabel: "Review" });
const SPRINT = queueLine({ label: "Sprint", rest: "Hosting, due Fri, 2 of 5 done", deepLink: "/#roadmap", linkLabel: "Roadmap" });
const TICKETS = queueLine({ label: "Tickets", rest: "2 waiting for someone, 3 assigned to you", deepLink: "/#tickets", linkLabel: "Tickets" });
const NUMBERS = "12 pull requests merged, 4 tickets done, 9 entries in the Feed";

const must = (s: Section | null): Section[] => (s ? [s] : []);

/** One fixture: its cadence and sections — or `skipped`, what a run does instead of sending. */
export function sampleDigest(scenario: SampleScenario): { cadence: RunCadence; sections: Section[]; skipped?: string } {
  switch (scenario) {
    case "daily-ai": return { cadence: "daily", sections: [...must(renderBrief(BRIEF_AI)), REVIEW, TICKETS] };
    case "daily-off": return { cadence: "daily", sections: [...must(renderBrief(BRIEF_OFF)), REVIEW_OFF, TICKETS] };
    case "daily-empty": return { cadence: "daily", sections: [queueLine({ label: "Tickets", rest: "1 waiting for someone", deepLink: "/#tickets", linkLabel: "Tickets" })] };
    case "weekly-ai": return { cadence: "weekly", sections: [...must(renderBrief({ ...BRIEF_AI, also: [] })), ...must(renderWeek(HIGHLIGHTS, NUMBERS)), SPRINT] };
    case "weekly-off": return { cadence: "weekly", sections: [...must(renderBrief(BRIEF_OFF)), ...must(renderWeek([], NUMBERS)), SPRINT] };
    case "only-when-needed": return {
      cadence: "daily",
      sections: [REVIEW_OFF],
      skipped: "This person chose \"Only when something needs me\": their brief has no Next item and nothing notable or breaking touched their work, so the run marks them skipped and sends nothing (the Review line alone is not enough).",
    };
  }
}

/** The sample sections the sample test send mails (the daily, AI on). */
export function sampleSections(): Section[] {
  return sampleDigest("daily-ai").sections;
}
