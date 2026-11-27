import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classOf, mostSevere } from "../lib/classify.mjs";
import { defaultConfig } from "../lib/config.mjs";
import { escapeText } from "../lib/escape.mjs";
import {
  BUDGET,
  buildResults,
  EMBED_BUDGET,
  embed,
  extract,
  findings,
  PEERBUS_LINE,
  PEERBUS_LINK,
  PEERBUS_OPTIONAL_LINE,
  RESOLVED_LINE,
  reduceComment,
  reduceResult,
  renderCheck,
  renderComment,
  renderJobSummary,
  SCHEMA,
} from "../lib/report.mjs";
import { NOT_SIMULATED, pairId } from "../lib/simulate.mjs";

const REPO = "acme/widgets";
const BASE = "b".repeat(40);
const STATE = "5".repeat(64);
const MARKER = /<!-- pr-conflict-radar:v1 [\s\S]*? -->/g;

const sha = (n) => n.toString(16).padStart(40, "0");

function config(overrides = {}) {
  return { ...defaultConfig(), ...overrides };
}

function pull(number, extra = {}) {
  return {
    number,
    baseRefName: "main",
    headRefOid: sha(number),
    author: "dev-a",
    labels: [],
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    recorded: null,
    ...extra,
  };
}

function files(...paths) {
  const cfg = defaultConfig();
  return paths.map((path) => ({ path, class: classOf(path, cfg) }));
}

// A simulation in the shape `simulate` resolves to. A pair without `files` is
// clean.
function sim({
  prs,
  order = prs.filter((pr) => pr.baseRefName === "main").map((pr) => pr.number),
  baseConflicts = [],
  pairs = [],
  breaks = [],
  notSimulated = [],
  notes = [],
  base = BASE,
  state = STATE,
}) {
  const cfg = defaultConfig();
  const pairList = pairs.map((pair) => ({
    first: pair.first,
    second: pair.second,
    clean: !pair.files,
    files: pair.files ?? [],
    class: pair.files
      ? mostSevere(
          pair.files.map((file) => file.class),
          cfg,
        )
      : null,
  }));
  const broken = new Set(breaks.map((entry) => entry.pr));
  const inBase = new Set(baseConflicts.map((entry) => entry.pr));
  return {
    base: { ref: "main", sha: base },
    state,
    order,
    pulls: Object.fromEntries(prs.map((pr) => [pr.number, pr])),
    baseConflicts,
    pairs: pairList,
    checked: pairList.map((pair) => pairId(pair.first, pair.second)),
    train: {
      merged: order.filter((n) => !broken.has(n) && !inBase.has(n)),
      breaks,
    },
    notSimulated,
    notes,
  };
}

const resultOf = (results, pr) => results.find((result) => result.pr === pr);
const stripMarker = (text) => text.replace(MARKER, "");

// The lines of every Markdown table in `text`, grouped per table.
function tables(text) {
  const groups = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("|")) {
      if (!current) {
        current = [];
        groups.push(current);
      }
      current.push(line);
    } else {
      current = null;
    }
  }
  return groups;
}

const columns = (line) => line.split("|").length - 2;

function assertTablesIntact(text) {
  const found = tables(text);
  assert.ok(found.length > 0, "a table is rendered");
  for (const table of found) {
    const width = columns(table[0]);
    for (const line of table) assert.equal(columns(line), width, line);
  }
  return found;
}

const conflictPair = (first, second, paths = ["src/cart.ts"]) => ({
  first,
  second,
  files: files(...paths),
});

describe("buildResults", () => {
  it("builds a clean result with every field of the schema", () => {
    const prs = [pull(12), pull(15, { author: "dev-b" })];
    const results = buildResults(sim({ prs, pairs: [{ first: 12, second: 15 }] }), config(), REPO);
    assert.deepEqual(
      results.map((result) => result.pr),
      [12, 15],
    );
    assert.deepEqual(results[0], {
      schema: SCHEMA,
      repo: REPO,
      base: `main@${BASE}`,
      pr: 12,
      head: sha(12),
      author: "dev-a",
      inputs: "ready;REVIEW_REQUIRED;",
      state: STATE,
      simulated: true,
      order: [12, 15],
      conflictsWithBase: false,
      conflicts: [],
      overlaps: [],
      hints: [],
      trainBreak: null,
      degraded: false,
      truncated: false,
      notes: [],
    });
  });

  it("records a code conflict on both pull requests with direction and key", () => {
    const prs = [pull(12), pull(15, { author: "dev-b", reviewDecision: "APPROVED" })];
    const results = buildResults(
      sim({ prs, order: [15, 12], pairs: [conflictPair(15, 12, ["README.md", "src/cart.ts"])] }),
      config(),
      REPO,
    );
    const expected = {
      tier: "textual",
      class: "code",
      files: [
        { path: "README.md", class: "docs" },
        { path: "src/cart.ts", class: "code" },
      ],
      mergesFirst: 15,
      rebases: 12,
      key: "conflict/widgets/12+15",
    };
    assert.deepEqual(resultOf(results, 12).conflicts, [
      { with: 15, withAuthor: "dev-b", sameAuthor: false, ...expected },
    ]);
    assert.deepEqual(resultOf(results, 15).conflicts, [
      { with: 12, withAuthor: "dev-a", sameAuthor: false, ...expected },
    ]);
    assert.equal(resultOf(results, 15).inputs, "ready;APPROVED;");
  });

  it("classes a docs-only conflict as docs and leaves it out of the findings", () => {
    const prs = [pull(12), pull(15)];
    const cfg = config();
    const results = buildResults(
      sim({ prs, pairs: [conflictPair(12, 15, ["README.md"])] }),
      cfg,
      REPO,
    );
    const result = resultOf(results, 12);
    assert.equal(result.conflicts[0].class, "docs");
    assert.deepEqual(findings(result, cfg).conflicts, []);
  });

  it("marks a base conflict and names the pull requests left unchecked", () => {
    const prs = [pull(12), pull(15), pull(18)];
    const results = buildResults(
      sim({
        prs,
        baseConflicts: [{ pr: 12, files: files("src/a.ts"), class: "code" }],
        pairs: [{ first: 15, second: 18 }],
      }),
      config(),
      REPO,
    );
    const conflicting = resultOf(results, 12);
    assert.equal(conflicting.conflictsWithBase, true);
    assert.deepEqual(conflicting.conflicts, []);
    assert.deepEqual(conflicting.notes, [
      "Not checked against the other pull requests: this pull request conflicts with the default branch.",
    ]);
    assert.equal(resultOf(results, 15).conflictsWithBase, false);
    assert.deepEqual(resultOf(results, 15).notes, [
      "Not checked against #12: it conflicts with the default branch.",
    ]);
  });

  it("records a multi-way train break", () => {
    const prs = [pull(12), pull(15), pull(18)];
    const breakEntry = {
      pr: 18,
      train: [12, 15],
      files: files("src/cart.ts"),
      class: "code",
      multiWay: true,
    };
    const results = buildResults(
      sim({
        prs,
        pairs: [
          { first: 12, second: 15 },
          { first: 12, second: 18 },
          { first: 15, second: 18 },
        ],
        breaks: [breakEntry],
      }),
      config(),
      REPO,
    );
    assert.deepEqual(resultOf(results, 18).trainBreak, {
      train: [12, 15],
      files: [{ path: "src/cart.ts", class: "code" }],
      class: "code",
      multiWay: true,
    });
    assert.equal(resultOf(results, 12).trainBreak, null);
    assert.deepEqual(resultOf(results, 18).conflicts, []);
  });

  it("records a train break explained by a pair", () => {
    const prs = [pull(12), pull(15)];
    const results = buildResults(
      sim({
        prs,
        pairs: [conflictPair(12, 15)],
        breaks: [
          { pr: 15, train: [12], files: files("src/cart.ts"), class: "code", multiWay: false },
        ],
      }),
      config(),
      REPO,
    );
    const result = resultOf(results, 15);
    assert.equal(result.trainBreak.multiWay, false);
    assert.deepEqual(result.trainBreak.train, [12]);
    assert.equal(result.conflicts[0].with, 12);
  });

  it("builds not-simulated results with the run's base, state and order", () => {
    const cfg = config({ maxPrs: 2 });
    const runNote = "Simulated the first 2 of 3 open pull requests.";
    const prs = [
      pull(12),
      pull(15),
      pull(18, { isDraft: true }),
      pull(21, { baseRefName: "release", recorded: { simulated: true } }),
    ];
    const results = buildResults(
      sim({
        prs,
        order: [12, 15],
        pairs: [{ first: 12, second: 15 }],
        notSimulated: [
          { pr: 18, reason: NOT_SIMULATED.maxPrs, note: "Not simulated: limit." },
          { pr: 21, reason: NOT_SIMULATED.otherBase, note: "Not simulated: other branch." },
        ],
        notes: [runNote],
      }),
      cfg,
      REPO,
    );
    assert.deepEqual(
      results.map((result) => result.pr),
      [12, 15, 18, 21],
    );
    assert.deepEqual(resultOf(results, 18), {
      schema: SCHEMA,
      repo: REPO,
      base: `main@${BASE}`,
      pr: 18,
      head: sha(18),
      author: "dev-a",
      inputs: "draft;REVIEW_REQUIRED;",
      state: STATE,
      simulated: false,
      order: [12, 15],
      conflictsWithBase: false,
      conflicts: [],
      overlaps: [],
      hints: [],
      trainBreak: null,
      degraded: false,
      truncated: false,
      notes: ["Not simulated: limit.", runNote],
    });
    assert.equal(resultOf(results, 21).simulated, false);
    assert.equal(resultOf(results, 21).notes[0], "Not simulated: other branch.");
    assert.deepEqual(resultOf(results, 12).notes, [
      runNote,
      "Not checked against #18: not simulated, because more than 2 open pull requests target the default branch.",
    ]);
  });

  it("gives a head without shared history a not-simulated result and names it in the others' notes", () => {
    const cfg = config();
    const note = "Not simulated: this pull request shares no history with the default branch.";
    const one = [pull(12), pull(14), pull(15)];
    const single = buildResults(
      sim({
        prs: one,
        order: [12, 15],
        pairs: [{ first: 12, second: 15 }],
        notSimulated: [{ pr: 14, reason: NOT_SIMULATED.unrelated, note }],
      }),
      cfg,
      REPO,
    );
    assert.equal(resultOf(single, 14).simulated, false);
    assert.deepEqual(resultOf(single, 14).notes, [note]);
    assert.deepEqual(resultOf(single, 12).notes, [
      "Not checked against #14: it shares no history with the default branch.",
    ]);
    const two = buildResults(
      sim({
        prs: [...one, pull(16)],
        order: [12, 15],
        pairs: [{ first: 12, second: 15 }],
        notSimulated: [
          { pr: 14, reason: NOT_SIMULATED.unrelated, note },
          { pr: 16, reason: NOT_SIMULATED.unrelated, note },
        ],
      }),
      cfg,
      REPO,
    );
    assert.deepEqual(resultOf(two, 15).notes, [
      "Not checked against #14, #16: they share no history with the default branch.",
    ]);
  });

  it("sets author, withAuthor and sameAuthor for each kind of pair", () => {
    const prs = [
      pull(12, { author: "dev-a" }),
      pull(15, { author: "dev-a" }),
      pull(18, { author: "dev-b" }),
      pull(21, { author: null }),
    ];
    const results = buildResults(
      sim({
        prs,
        pairs: [conflictPair(12, 15), conflictPair(12, 18), conflictPair(18, 21)],
      }),
      config(),
      REPO,
    );
    const twelve = resultOf(results, 12).conflicts;
    assert.deepEqual(
      twelve.map(({ with: other, withAuthor, sameAuthor }) => ({ other, withAuthor, sameAuthor })),
      [
        { other: 15, withAuthor: "dev-a", sameAuthor: true },
        { other: 18, withAuthor: "dev-b", sameAuthor: false },
      ],
    );
    const ghost = resultOf(results, 21);
    assert.equal(ghost.author, null);
    assert.deepEqual(
      ghost.conflicts.map(({ withAuthor, sameAuthor }) => ({ withAuthor, sameAuthor })),
      [{ withAuthor: "dev-b", sameAuthor: false }],
    );
    const eighteen = resultOf(results, 18).conflicts.find((c) => c.with === 21);
    assert.equal(eighteen.withAuthor, null);
    assert.equal(eighteen.sameAuthor, false);
  });

  it("does not treat two pull requests without an author login as the same author", () => {
    const prs = [pull(12, { author: null }), pull(15, { author: null })];
    const results = buildResults(sim({ prs, pairs: [conflictPair(12, 15)] }), config(), REPO);
    assert.equal(resultOf(results, 12).conflicts[0].sameAuthor, false);
  });
});

// Results for a pull request 12 by dev-a that conflicts with 15 (dev-b) and 18
// (dev-a), with 21 clean.
function mixedResults(cfg = config()) {
  const prs = [pull(12), pull(15, { author: "dev-b" }), pull(18), pull(21, { author: "dev-c" })];
  return buildResults(
    sim({
      prs,
      pairs: [
        conflictPair(12, 15, ["src/cart.ts"]),
        conflictPair(12, 18, ["src/total.ts"]),
        { first: 12, second: 21 },
        { first: 15, second: 18 },
        { first: 15, second: 21 },
        { first: 18, second: 21 },
      ],
    }),
    cfg,
    REPO,
  );
}

function withOverlap(result, overrides = {}) {
  return {
    ...result,
    overlaps: [
      {
        with: 15,
        withAuthor: "dev-b",
        sameAuthor: false,
        tier: "member",
        kind: "same-member",
        members: [{ path: "src/cart.ts", name: "computeTotal" }],
        key: "conflict/widgets/12+15",
      },
    ],
    ...overrides,
  };
}

describe("renderCheck", () => {
  it("picks the conclusion per case", () => {
    const cfg = config();
    const [twelve, , , twentyOne] = mixedResults(cfg);
    assert.equal(renderCheck(twelve, cfg).conclusion, "neutral");
    assert.equal(renderCheck(twentyOne, cfg).conclusion, "success");
    const clean = { ...twentyOne, conflicts: [] };
    assert.equal(renderCheck({ ...clean, conflictsWithBase: true }, cfg).conclusion, "neutral");
    assert.equal(renderCheck({ ...clean, simulated: false }, cfg).conclusion, "neutral");
    const trainBreak = { train: [12], files: files("a.ts"), class: "code", multiWay: true };
    assert.equal(renderCheck({ ...clean, trainBreak }, cfg).conclusion, "neutral");
    assert.equal(renderCheck(withOverlap(clean), cfg).conclusion, "neutral");
    const hints = [
      { with: 15, kind: "changed-and-used", names: [{ path: "a.ts", name: "total" }] },
    ];
    assert.equal(renderCheck({ ...clean, hints }, cfg).conclusion, "success");
  });

  it("builds the title from fixed words and counts", () => {
    const cfg = config();
    const [twelve, fifteen, , twentyOne] = mixedResults(cfg);
    const clean = twentyOne;
    const trainBreak = { train: [12], files: files("a.ts"), class: "code", multiWay: true };
    const titles = [
      renderCheck(twelve, cfg).title,
      renderCheck(fifteen, cfg).title,
      renderCheck(clean, cfg).title,
      renderCheck({ ...clean, conflictsWithBase: true }, cfg).title,
      renderCheck({ ...clean, simulated: false }, cfg).title,
      renderCheck({ ...clean, trainBreak }, cfg).title,
      renderCheck(withOverlap(clean), cfg).title,
    ];
    assert.deepEqual(titles, [
      "Conflicts with 2 pull requests",
      "Conflicts with 1 pull request",
      "No conflicts",
      "Conflicts with the base branch",
      "Not simulated",
      "Breaks the merge train",
      "Member overlap with 1 pull request",
    ]);
  });

  it("returns the configured check name", () => {
    const cfg = config({ checkName: "Merge radar" });
    assert.equal(renderCheck(mixedResults(cfg)[0], cfg).name, "Merge radar");
  });

  it("renders the Author column and other authors' rows before the own group", () => {
    const cfg = config();
    const { summary } = renderCheck(mixedResults(cfg)[0], cfg);
    const others = summary.indexOf("### Pull requests of other authors");
    const own = summary.indexOf("### Pull requests by the same author");
    assert.ok(others >= 0 && own > others, summary);
    const [otherTable, ownTable] = tables(summary);
    assert.match(otherTable[0], /\| Author \|/);
    assert.match(otherTable[2], /^\| #15 \| <code>dev-b<\/code> \|/);
    assert.equal(otherTable.length, 3);
    assert.match(ownTable[2], /^\| #18 \| <code>dev-a<\/code> \|/);
    assert.equal(ownTable.length, 3);
  });

  it("uses the different-author wording with a plain login and the pair key", () => {
    const cfg = config();
    const { summary } = renderCheck(mixedResults(cfg)[0], cfg);
    const key = escapeText("conflict/widgets/12+15");
    assert.ok(summary.includes(`- #15 by <code>dev-b</code>, pair key ${key}`), summary);
    assert.ok(!summary.includes("@dev-b"));
    assert.ok(!/@[a-z]/.test(summary));
  });

  it("uses the same-author wording: both theirs, one session, key optional", () => {
    const cfg = config();
    const { summary } = renderCheck(mixedResults(cfg)[0], cfg);
    const own = summary.slice(summary.indexOf("### Pull requests by the same author"));
    assert.match(own, /by the same author/);
    assert.match(own, /resolved in one session/);
    assert.match(own, /Pair keys, optional:/);
    assert.ok(own.includes(`- #18, pair key ${escapeText("conflict/widgets/12+18")}`));
  });

  it("keeps every key in the embedded JSON in both groups", () => {
    const cfg = config();
    const result = mixedResults(cfg)[0];
    const embedded = extract(renderCheck(result, cfg).text);
    assert.deepEqual(embedded, result);
    assert.deepEqual(
      embedded.conflicts.map((conflict) => conflict.key),
      ["conflict/widgets/12+15", "conflict/widgets/12+18"],
    );
  });

  it("uses the configured pair-key template", () => {
    const cfg = config({ pairKey: "radar/{owner}/{repo}/{low}-{high}" });
    const result = mixedResults(cfg)[0];
    assert.equal(result.conflicts[0].key, "radar/acme/widgets/12-15");
    const { summary, text } = renderCheck(result, cfg);
    assert.ok(summary.includes(escapeText("radar/acme/widgets/12-15")));
    assert.equal(extract(text).conflicts[0].key, "radar/acme/widgets/12-15");
  });

  it("writes a line for a multi-way train break naming the train and the files", () => {
    const cfg = config();
    const clean = mixedResults(cfg)[3];
    const trainBreak = {
      train: [12, 15],
      files: files("src/cart.ts"),
      class: "code",
      multiWay: true,
    };
    const { summary } = renderCheck({ ...clean, trainBreak }, cfg);
    assert.match(summary, /Merged after #12, #15 in the predicted order/);
    assert.match(summary, /multi-way conflict/);
    assert.ok(summary.includes(escapeText("src/cart.ts")));
  });

  it("writes a line for a base conflict and renders the notes", () => {
    const cfg = config();
    const prs = [pull(12), pull(15)];
    const results = buildResults(
      sim({ prs, baseConflicts: [{ pr: 12, files: files("a.ts"), class: "code" }] }),
      cfg,
      REPO,
    );
    const twelve = renderCheck(resultOf(results, 12), cfg).summary;
    assert.match(twelve, /conflicts with the default branch, so it was not checked/);
    const fifteen = renderCheck(resultOf(results, 15), cfg).summary;
    assert.match(fifteen, /\*\*Notes\*\*/);
    assert.ok(
      fifteen.includes(
        escapeText("Not checked against #12: it conflicts with the default branch."),
      ),
    );
  });

  it("renders the hints with the caveat in the text above the embedded result", () => {
    const cfg = config();
    const clean = mixedResults(cfg)[3];
    const hints = [
      { with: 15, kind: "changed-and-used", names: [{ path: "a.ts", name: "total" }] },
    ];
    const { text, summary } = renderCheck({ ...clean, hints }, cfg);
    const marker = text.indexOf("<!-- pr-conflict-radar:v1 ");
    assert.ok(text.indexOf("### Hints") < marker && text.indexOf("### Hints") >= 0);
    assert.match(text, /can be wrong/);
    assert.ok(text.includes(escapeText("total")));
    assert.ok(!summary.includes("Hints"));
  });
});

describe("renderComment", () => {
  it("renders the findings in two groups with the embedded data", () => {
    const cfg = config();
    const result = mixedResults(cfg)[0];
    const data = { ...findings(result, cfg), notified: ["conflict/widgets/12+15"] };
    const body = renderComment(data, cfg);
    assert.match(body, /conflicts with 2 other open pull requests/);
    assert.ok(body.indexOf("other authors") < body.indexOf("same author"));
    assert.deepEqual(extract(body), data);
    assertTablesIntact(stripMarker(body));
  });

  it("renders the resolved form with the notified list unchanged", () => {
    const cfg = config();
    const data = { schema: SCHEMA, repo: REPO, pr: 12, conflicts: [], notified: ["k1", "k2"] };
    const body = renderComment(data, cfg);
    assert.ok(body.startsWith(`${RESOLVED_LINE}\n\n<!-- pr-conflict-radar:v1 `));
    assert.deepEqual(extract(body), data);
  });
});

describe("renderJobSummary", () => {
  it("counts conflicting pairs between different authors and of one author", () => {
    const cfg = config();
    const summary = renderJobSummary(mixedResults(cfg), cfg, {
      writes: { checks: 4, comments: 3 },
    });
    assert.match(
      summary,
      /Conflicting pairs: 1 between different authors, 1 between pull requests of one author\./,
    );
    assert.match(summary, /Writes made: 4 check writes and 3 comment writes\./);
    assert.match(summary, /### Pair matrix/);
    assert.match(summary, /### Merge train/);
    const pairs = tables(summary)[1];
    assert.equal(pairs.length, 4);
    assertTablesIntact(summary);
  });

  it("says how many writes a dry run would make", () => {
    const cfg = config();
    const summary = renderJobSummary(mixedResults(cfg), cfg, {
      writes: { checks: 1, comments: 0 },
      dryRun: true,
    });
    assert.match(summary, /A publish would make 1 check write and 0 comment writes\./);
  });

  it("cuts a table that passes the budget and counts the rows left out", () => {
    const cfg = config({ maxPrs: 200 });
    const prs = Array.from({ length: 200 }, (_, i) => pull(i + 1));
    const results = buildResults(sim({ prs }), cfg, REPO);
    const summary = renderJobSummary(results, cfg);
    assert.ok(summary.length < BUDGET, String(summary.length));
    assert.match(summary, /\d+ more rows left out\./);
    assertTablesIntact(summary);
  });
});

describe("suggestPeerbus", () => {
  function crossAndOwn(cfg) {
    const result = mixedResults(cfg)[0];
    return withOverlap(result);
  }

  it("shows the pair key and the peerbus lines by default", () => {
    const cfg = config();
    const result = crossAndOwn(cfg);
    const { summary } = renderCheck(result, cfg);
    const comment = renderComment({ ...findings(result, cfg), notified: [] }, cfg);
    for (const text of [summary, comment]) {
      assert.match(tables(text)[0][0], /\| Pair key \|$/);
      assert.ok(text.includes(escapeText("conflict/widgets/12+15")));
      assert.ok(text.includes(PEERBUS_LINE));
      assert.ok(text.includes(`(${PEERBUS_LINK})`));
      assert.ok(text.includes(escapeText("conflict/widgets/12+18")));
      assert.ok(text.includes(PEERBUS_OPTIONAL_LINE));
    }
    const overlaps = summary.slice(summary.indexOf("### Member overlaps"));
    assert.match(tables(overlaps)[0][0], /\| Pair key \|$/);
    assert.ok(overlaps.includes(escapeText("conflict/widgets/12+15")));
    assert.ok(overlaps.includes(PEERBUS_LINE));
    const job = renderJobSummary(mixedResults(cfg), cfg);
    assert.ok(job.includes(escapeText("conflict/widgets/12+15")));
    assert.ok(job.includes(escapeText("conflict/widgets/12+18")));
  });

  for (const pairKeyTemplate of ["conflict/{repo}/{low}+{high}", "radar-{owner}-{low}-{high}"]) {
    it(`shows neither key nor peerbus when off (pairKey ${pairKeyTemplate})`, () => {
      const on = config({ pairKey: pairKeyTemplate });
      const off = config({ pairKey: pairKeyTemplate, suggestPeerbus: false });
      const result = crossAndOwn(off);
      const keys = result.conflicts.map((conflict) => conflict.key);
      const check = renderCheck(result, off);
      const data = { ...findings(result, off), notified: [...keys] };
      const comment = renderComment(data, off);
      const job = renderJobSummary([result, ...mixedResults(off).slice(1)], off);
      const visible = [check.summary, stripMarker(check.text), stripMarker(comment), job];
      for (const text of visible) {
        assert.doesNotMatch(text, /peerbus/i);
        assert.ok(!text.includes("Pair key"));
        for (const key of keys) {
          assert.ok(!text.includes(key), key);
          assert.ok(!text.includes(escapeText(key)), key);
        }
      }
      const onCheck = renderCheck(result, on);
      const onComment = renderComment(data, on);
      const pairs = [
        [tables(check.summary), tables(onCheck.summary)],
        [tables(comment), tables(onComment)],
      ];
      for (const [offTables, onTables] of pairs) {
        assert.equal(offTables.length, onTables.length);
        for (const [i, table] of offTables.entries()) {
          assert.equal(columns(table[0]), columns(onTables[i][0]) - 1);
        }
      }
      assert.deepEqual(
        extract(check.text).conflicts.map((conflict) => conflict.key),
        keys,
      );
      assert.deepEqual(extract(check.text).overlaps[0].key, result.overlaps[0].key);
      assert.deepEqual(
        extract(comment).conflicts.map((conflict) => conflict.key),
        keys,
      );
      assert.deepEqual(extract(comment).notified, keys);
    });
  }

  it("never names peerbus in the result JSON", () => {
    for (const suggestPeerbus of [true, false]) {
      const cfg = config({ suggestPeerbus });
      assert.doesNotMatch(JSON.stringify(mixedResults(cfg)), /peerbus/i);
    }
  });
});

describe("injection", () => {
  const hostile = "a|b<i>x</i>[l](https://example.com)@m `t`\nnext-->";
  const path = `src/${hostile}.ts`;
  const member = `member${hostile}`;
  const login = `dev${hostile}`;
  const label = `label${hostile}`;

  function hostileResults(cfg) {
    const prs = [pull(12, { labels: [label] }), pull(15, { author: login })];
    const conflictFiles = [{ path, class: "code", members: [member] }];
    const results = buildResults(
      sim({ prs, pairs: [{ first: 12, second: 15, files: conflictFiles }] }),
      cfg,
      REPO,
    );
    return results.map((result) =>
      result.pr === 12
        ? {
            ...result,
            overlaps: [
              {
                with: 15,
                withAuthor: login,
                sameAuthor: false,
                tier: "member",
                kind: "same-member",
                members: [{ path, name: member }],
                key: "conflict/widgets/12+15",
              },
            ],
            hints: [{ with: 15, kind: "changed-and-used", names: [{ path, name: member }] }],
          }
        : result,
    );
  }

  function assertInert(text) {
    const visible = stripMarker(text).replaceAll("<!---->", "");
    assert.ok(!visible.includes("<!--") && !visible.includes("-->"), visible);
    for (const raw of ["<i>", "</i>", "[l](", "https://example", "@m", "`t`", "a|b"]) {
      assert.ok(!visible.includes(raw), raw);
    }
    assert.ok(!visible.includes(label.slice(0, 8)));
    const markers = text.match(/<!-- pr-conflict-radar:v1 /g)?.length ?? 0;
    assert.ok(markers <= 1);
    if (markers === 1) assert.notEqual(extract(text), null);
    assertTablesIntact(stripMarker(text));
  }

  it("keeps tables and the marker intact and escapes every hostile string", () => {
    const cfg = config({ order: { labelPriority: [label] } });
    const results = hostileResults(cfg);
    const twelve = resultOf(results, 12);
    const check = renderCheck(twelve, cfg);
    assertInert(check.summary);
    assertInert(check.text);
    assert.ok(check.summary.includes(escapeText(path)));
    assert.ok(check.summary.includes(escapeText(member)));
    assert.ok(check.summary.includes(escapeText(login)));
    const embedded = extract(check.text);
    assert.equal(embedded.conflicts[0].files[0].path, path);
    assert.equal(embedded.conflicts[0].files[0].members[0], member);
    assert.equal(embedded.conflicts[0].withAuthor, login);
    assert.equal(embedded.hints[0].names[0].name, member);
    assert.equal(decodeURIComponent(embedded.inputs.split(";")[2]), label);

    const comment = renderComment({ ...findings(twelve, cfg), notified: [] }, cfg);
    assertInert(comment);
    assert.equal(extract(comment).conflicts[0].files[0].path, path);
    assert.equal(extract(comment).conflicts[0].withAuthor, login);

    const fifteen = renderCheck(resultOf(results, 15), cfg);
    assertInert(fifteen.summary);
    assert.equal(extract(fifteen.text).author, login);

    const job = renderJobSummary(results, cfg);
    const visible = job.replaceAll("<!---->", "");
    assert.ok(!visible.includes("<!--") && !visible.includes("-->"));
    assert.ok(!visible.includes("<i>") && !visible.includes("@m"));
    assertTablesIntact(job);
  });
});

describe("embed and extract", () => {
  it("round-trips a value whose strings carry the comment terminator", () => {
    const value = { schema: SCHEMA, pr: 12, note: "x --> <!-- y & z -- w" };
    const text = embed(value);
    assert.ok(text.startsWith("<!-- pr-conflict-radar:v1 "));
    assert.ok(text.endsWith(" -->"));
    const inner = text.slice("<!-- pr-conflict-radar:v1 ".length, -" -->".length);
    assert.ok(!/[<>&]|--/.test(inner), inner);
    assert.deepEqual(extract(`intro\n\n${text}`), value);
  });

  it("reads the last marker of a text", () => {
    const first = embed({ schema: SCHEMA, pr: 1 });
    const last = embed({ schema: SCHEMA, pr: 2 });
    assert.equal(extract(`${first}\n${last}`).pr, 2);
  });

  it("returns null for missing or malformed markers", () => {
    const prefix = "<!-- pr-conflict-radar:v1 ";
    for (const text of [
      undefined,
      null,
      42,
      "",
      "no marker here",
      `${prefix}{"schema":1}`,
      `${prefix}{"schema":1 -->`,
      `${prefix}[1,2] -->`,
      `${prefix}null -->`,
      `${prefix}"text" -->`,
      `${prefix}{"schema":2} -->`,
      `${prefix}{"pr":12} -->`,
      '<!-- pr-conflict-radar:v2 {"schema":1} -->',
    ]) {
      assert.equal(extract(text), null, String(text));
    }
  });
});

describe("findings", () => {
  const cfg = config();

  // 12 and 15 conflict with 12 merging first; 18 is clean.
  function results({
    base = BASE,
    state = STATE,
    order = [12, 15, 18],
    review = "REVIEW_REQUIRED",
    head15 = sha(15),
    pairs = [conflictPair(12, 15)],
  } = {}) {
    const prs = [pull(12, { reviewDecision: review }), pull(15, { headRefOid: head15 }), pull(18)];
    return buildResults(sim({ prs, order, pairs, base, state }), cfg, REPO);
  }

  const of = (list, pr = 12) => findings(resultOf(list, pr), cfg);

  it("holds only schema, repo, pr and the conflicts", () => {
    const value = of(results());
    assert.deepEqual(Object.keys(value), ["schema", "repo", "pr", "conflicts"]);
    assert.equal(value.conflicts.length, 1);
  });

  it("stays equal when only the base, a head, the state, inputs, hints or order move", () => {
    const reference = of(results());
    assert.deepEqual(of(results({ base: "c".repeat(40) })), reference);
    assert.deepEqual(of(results({ head15: "d".repeat(40) })), reference);
    assert.deepEqual(of(results({ state: "6".repeat(64) })), reference);
    assert.deepEqual(of(results({ review: "APPROVED" })), reference);
    assert.deepEqual(of(results({ order: [18, 12, 15] })), reference);
    const withHints = {
      ...resultOf(results(), 12),
      hints: [{ with: 15, kind: "changed-and-used", names: [{ path: "a.ts", name: "total" }] }],
    };
    assert.deepEqual(findings(withHints, cfg), reference);
  });

  it("differs on a changed file list, a flipped direction and a new pair", () => {
    const reference = of(results());
    assert.notDeepEqual(
      of(results({ pairs: [conflictPair(12, 15, ["src/other.ts"])] })),
      reference,
    );
    assert.notDeepEqual(
      of(results({ order: [15, 12, 18], pairs: [conflictPair(15, 12)] })),
      reference,
    );
    assert.notDeepEqual(
      of(results({ pairs: [conflictPair(12, 15), conflictPair(12, 18)] })),
      reference,
    );
  });

  it("holds only the pairs whose class is in commentClasses", () => {
    const list = results({
      pairs: [conflictPair(12, 15, ["README.md"]), conflictPair(12, 18, ["test/cart.test.ts"])],
    });
    assert.deepEqual(
      of(list).conflicts.map((conflict) => conflict.with),
      [18],
    );
    const docsToo = { ...cfg, commentClasses: ["docs", "tests", "code"] };
    assert.equal(findings(resultOf(list, 12), docsToo).conflicts.length, 2);
  });
});

describe("size budget", () => {
  const longPath = (pr, i) =>
    `${`src/${pr}/file-${String(i).padStart(2, "0")}-`.padEnd(97, "x")}.ts`;
  const others = Array.from({ length: 39 }, (_, i) => 101 + i);

  function bigResults(cfg) {
    const prs = [pull(100), ...others.map((n) => pull(n, { author: `dev-${n}` }))];
    const pairs = others.map((n) => ({
      first: 100,
      second: n,
      files: Array.from({ length: 20 }, (_, i) => longPath(n, i)).map((path) => ({
        path,
        class: "code",
      })),
    }));
    return buildResults(sim({ prs, pairs }), cfg, REPO);
  }

  it("keeps every field of a 39-way conflict under the budget and still round-trips", () => {
    const cfg = config();
    const results = bigResults(cfg);
    const result = resultOf(results, 100);
    assert.equal(longPath(101, 0).length, 100);
    assert.ok(embed(result).length > EMBED_BUDGET);
    const check = renderCheck(result, cfg);
    for (const field of [check.title, check.summary, check.text]) {
      assert.ok(field.length < BUDGET, String(field.length));
    }
    const reduced = reduceResult(result);
    assert.equal(reduced.truncated, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(extract(check.text), reduced);
    for (const conflict of reduced.conflicts) {
      assert.ok(conflict.files.length < 20);
      assert.equal(conflict.files.length + conflict.filesOmitted, 20);
    }
    assert.match(check.summary, /and \d+ more files/);
    assertTablesIntact(check.summary);

    const data = { ...findings(reduced, cfg), notified: reduced.conflicts.map((c) => c.key) };
    const comment = renderComment(data, cfg);
    assert.ok(comment.length < BUDGET, String(comment.length));
    const embedded = extract(comment);
    const { notified, ...commentFindings } = embedded;
    assert.deepEqual(commentFindings, findings(reduced, cfg));
    assert.deepEqual(notified, data.notified);

    const job = renderJobSummary(results, cfg);
    assert.ok(job.length < BUDGET, String(job.length));
  });

  it("leaves a reduced result unchanged", () => {
    const cfg = config();
    const reduced = reduceResult(resultOf(bigResults(cfg), 100));
    assert.equal(reduceResult(reduced), reduced);
    assert.deepEqual(reduceResult(structuredClone(reduced)), reduced);
    const small = mixedResults(cfg)[0];
    assert.equal(reduceResult(small), small);
  });

  it("drops old notified keys on no current row, never a current row's key", () => {
    const cfg = config();
    const reduced = reduceResult(resultOf(bigResults(cfg), 100));
    const current = reduced.conflicts.map((conflict) => conflict.key);
    const extra = Array.from({ length: 100 }, (_, i) =>
      `old/${String(i).padStart(3, "0")}/`.padEnd(200, "k"),
    );
    // The current rows' keys are the oldest entries of the list.
    const data = { ...findings(reduced, cfg), notified: [...current, ...extra] };
    assert.ok(embed(data).length > EMBED_BUDGET);
    const kept = reduceComment(data);
    assert.ok(embed(kept).length <= EMBED_BUDGET);
    for (const key of current) assert.ok(kept.notified.includes(key), key);
    const keptExtra = kept.notified.filter((key) => !current.includes(key));
    assert.ok(keptExtra.length < extra.length);
    assert.deepEqual(keptExtra, extra.slice(extra.length - keptExtra.length));
    assert.equal(kept.truncated, undefined);
    assert.deepEqual(kept.conflicts, data.conflicts);
    assert.equal(reduceComment(kept), kept);

    const body = renderComment(data, cfg);
    assert.ok(body.length < BUDGET, String(body.length));
    assert.deepEqual(extract(body), kept);
  });
});

describe("member signals in the result", () => {
  const change = (path, members, identifiers = [], side = "head") => ({
    path,
    side,
    members: members.map(([name, kind = "function", declarationTouched = false]) => ({
      name,
      kind,
      declarationTouched,
    })),
    identifiers,
  });

  // 12 and 15 both change `computeTotal`; 20 touches the declaration of
  // `formatPrice`, which 15 uses; 12 and 20 conflict textually.
  function memberCase({ name = "computeTotal", identifiers = ["formatPrice"] } = {}) {
    const prs = [pull(12), pull(15, { author: "dev-b" }), pull(20)];
    const simulation = sim({
      prs,
      pairs: [{ first: 12, second: 15 }, conflictPair(12, 20), { first: 15, second: 20 }],
    });
    const members = {
      changes: {
        12: [change("src/cart.ts", [[name]])],
        15: [change("src/cart.ts", [[name]], identifiers)],
        20: [
          change("src/cart.ts", [["render"]]),
          change("src/price.ts", [["formatPrice", "function", true]]),
        ],
      },
      notes: { 12: [], 15: ["The members of src/big.ts were not mapped."], 20: [] },
      degraded: [],
      failures: [],
    };
    return { simulation, members };
  }

  it("adds overlaps, hints, the members of conflicting files and the mapping notes", () => {
    const cfg = config();
    const { simulation, members } = memberCase();
    const results = buildResults(simulation, cfg, REPO, members);
    const overlap = (other, withAuthor) => ({
      with: other,
      withAuthor,
      sameAuthor: false,
      tier: "member",
      kind: "same-member",
      members: [{ path: "src/cart.ts", name: "computeTotal" }],
      key: "conflict/widgets/12+15",
    });
    assert.deepEqual(resultOf(results, 12).overlaps, [overlap(15, "dev-b")]);
    assert.deepEqual(resultOf(results, 15).overlaps, [overlap(12, "dev-a")]);
    assert.deepEqual(resultOf(results, 20).overlaps, []);
    const hint = (other) => ({
      with: other,
      kind: "changed-and-used",
      names: [{ path: "src/price.ts", name: "formatPrice" }],
    });
    assert.deepEqual(resultOf(results, 15).hints, [hint(20)]);
    assert.deepEqual(resultOf(results, 20).hints, [hint(15)]);
    assert.deepEqual(resultOf(results, 12).hints, []);
    assert.deepEqual(resultOf(results, 12).conflicts[0].files, [
      { path: "src/cart.ts", class: "code", members: ["computeTotal", "render"] },
    ]);
    assert.ok(resultOf(results, 15).notes.includes("The members of src/big.ts were not mapped."));
    assert.ok(results.every((result) => result.degraded === false));

    const degraded = buildResults(simulation, cfg, REPO, { ...members, degraded: [15] });
    assert.deepEqual(
      degraded.map((result) => result.degraded),
      [false, true, false],
    );
  });

  it("makes the check neutral on a same-member overlap", () => {
    const cfg = config();
    const { simulation, members } = memberCase();
    const fifteen = resultOf(buildResults(simulation, cfg, REPO, members), 15);
    const check = renderCheck(fifteen, cfg);
    assert.equal(check.conclusion, "neutral");
    assert.equal(check.title, "Member overlap with 1 pull request");
    assert.ok(check.summary.includes("### Member overlaps"));
    assert.ok(check.summary.includes(escapeText("computeTotal")));
    assert.ok(check.summary.includes(PEERBUS_LINE));
    const plain = resultOf(buildResults(simulation, cfg, REPO), 15);
    assert.equal(renderCheck(plain, cfg).conclusion, "success");
  });

  it("shows a hint in hints, the check text and the job summary and changes nothing else", () => {
    const cfg = config();
    const { simulation, members } = memberCase({ name: "other" });
    const without = memberCase({ name: "other", identifiers: [] });
    const withHint = buildResults(simulation, cfg, REPO, members);
    const noHint = buildResults(without.simulation, cfg, REPO, without.members);
    const twenty = resultOf(withHint, 20);
    const plain = resultOf(noHint, 20);
    assert.equal(twenty.hints.length, 1);
    assert.deepEqual(plain.hints, []);

    const check = renderCheck(twenty, cfg);
    const plainCheck = renderCheck(plain, cfg);
    assert.equal(check.conclusion, plainCheck.conclusion);
    assert.equal(check.title, plainCheck.title);
    assert.equal(check.summary, plainCheck.summary);
    const hints = check.text.indexOf("### Hints");
    assert.ok(hints >= 0 && hints < check.text.indexOf("<!-- pr-conflict-radar:v1 "));
    assert.match(check.text, /can be wrong/);
    assert.ok(check.text.includes(escapeText("formatPrice")));
    assert.ok(!plainCheck.text.includes("### Hints"));

    assert.deepEqual(findings(twenty, cfg), findings(plain, cfg));
    const data = (result) => ({ ...findings(result, cfg), notified: [] });
    assert.equal(renderComment(data(twenty), cfg), renderComment(data(plain), cfg));

    const job = renderJobSummary(withHint, cfg);
    const plainJob = renderJobSummary(noHint, cfg);
    const hintTables = tables(job).filter((table) => table[0].includes("Names"));
    assert.equal(hintTables.length, 1);
    // The hint of the pair is listed once, though both results carry it.
    assert.equal(hintTables[0].length, 3);
    assert.ok(job.includes(escapeText("formatPrice")));
    assert.match(job, /can be wrong/);
    assert.deepEqual(
      tables(job).filter((table) => !table[0].includes("Names")),
      tables(plainJob),
    );
  });

  it("escapes a member name that carries markup", () => {
    const cfg = config();
    const name = "total<b>x</b>|[l](https://example.com)@m `t`";
    const { simulation, members } = memberCase({ name, identifiers: ["formatPrice"] });
    const results = buildResults(simulation, cfg, REPO, members);
    for (const result of results) {
      const check = renderCheck(result, cfg);
      for (const text of [check.summary, stripMarker(check.text)]) {
        for (const raw of ["<b>", "[l](", "https://example", "@m", "`t`", "|[l]"]) {
          assert.ok(!text.includes(raw), raw);
        }
      }
      assertTablesIntact(check.summary);
    }
    const twelve = renderCheck(resultOf(results, 12), cfg);
    assert.ok(twelve.summary.includes(escapeText(name)));
    assert.equal(extract(twelve.text).overlaps[0].members[0].name, name);
    assert.ok(extract(twelve.text).conflicts[0].files[0].members.includes(name));
    const job = renderJobSummary(results, cfg);
    assert.ok(!job.includes("<b>"));
    assert.ok(job.includes(escapeText(name)));
    assertTablesIntact(job);
  });
});
