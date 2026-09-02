# Job-board / source registries (legacy `server/utils` surface)

This directory holds job-board and source registries and the adapters that
crawl them — the compatibility-era home for source data described in
[../../../README.md](../../../README.md)'s "Where to add new code" section.
New source families that don't fit an existing bounded context still land
here; genuinely new domain logic should not.

Most files are either a flat list of `{ key, label, url }` board entries
crawled generically (see `communityJobBoardSources.ts`,
`curatedRemoteJobBoardTargets.ts`, `regionalJobBoardSources.ts`) or a
source-specific adapter with its own request/parse logic (`hhJobSource.ts`,
`linkedinSource.ts`, `jobsUaSource.ts`). `cyclicJobBoardCrawler.ts` is the
shared pagination/cursor helper the generic boards use — add new crawl
mechanics there, not per-board.

`communityJobBoardSources.ts` is the general-purpose board registry (freelance
marketplaces, remote-first boards, dev/design/writing niches, CIS/Russian-
language boards, direct-employer targets). It currently includes, among
others: Kwork, Work-zilla, Getmatch, Arbihunter, Upwork, Fiverr, Freelancer,
Toptal, Jobgether, Wantapply, Otta, PowerToFly, RemoteWoman, Dribbble, and
AI Jobs. Add a new generic board there rather than creating a new file,
unless it needs its own parser/pagination — see `extraPublicJobSources.ts`
for an example of a board with a dedicated parser living alongside the
generic ones.

Execution policy (retries, pacing, concurrency, page caps) is external to
this directory — see `cyclicJobBoardCrawler.ts` and the crawler-core README —
not something an individual source file should implement.
