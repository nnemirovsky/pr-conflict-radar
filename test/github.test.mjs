import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../lib/config.mjs";
import { createGitHub, GitHubError } from "../lib/github.mjs";
import { embed } from "../lib/report.mjs";

const REPO = "acme/widgets";
const TOKEN = "ghs_secretTOKENvalue123";
const sha = (n) => n.toString(16).padStart(40, "0");
const config = defaultConfig();

function result(pr, repo = REPO) {
  return { schema: 1, repo, pr, head: sha(pr), conflicts: [] };
}

const checkText = (pr, repo) => `details\n${embed(result(pr, repo))}`;

// Builds a fake GitHub: GraphQL over `prs` (with its own page size for pull
// requests; contexts and comments page at 100, as the real API does) and a
// REST recorder. `rest(method, path, body)` may return a `{status, body,
// headers}` to override the default 200.
function fakeGitHub({ prs, defaultBranch = { name: "main", oid: sha(999) }, rest, prPage = 50 }) {
  const calls = [];
  const texts = new Map();
  for (const pr of prs) for (const check of pr.checks ?? []) texts.set(check.id, check.text ?? "");

  const respond = (status, body, headers = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

  function page(list, size, after) {
    const start = after ? Number(after) : 0;
    const nodes = list.slice(start, start + size);
    const next = start + size;
    return { pageInfo: { hasNextPage: next < list.length, endCursor: String(next) }, nodes };
  }

  const rollup = (pr, after) => ({
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: page(
                (pr.contexts ?? []).map((c) => ({ __typename: "CheckRun", ...c })),
                100,
                after,
              ),
            },
          },
        },
      ],
    },
  });

  function graphql(query, v) {
    if (v.ids) {
      return {
        data: {
          nodes: v.ids.map((id) => ({ id, databaseId: Number(id.slice(2)), text: texts.get(id) })),
        },
      };
    }
    if (v.number !== undefined) {
      const pr = prs.find((p) => p.number === v.number);
      if (query.includes("commits(last")) {
        return { data: { repository: { pullRequest: rollup(pr, v.contextsAfter) } } };
      }
      return {
        data: {
          repository: { pullRequest: { comments: page(pr.comments ?? [], 100, v.commentsAfter) } },
        },
      };
    }
    const listed = page(prs, prPage, v.after);
    return {
      data: {
        repository: {
          defaultBranchRef: { name: defaultBranch.name, target: { oid: defaultBranch.oid } },
          pullRequests: {
            pageInfo: listed.pageInfo,
            nodes: listed.nodes.map((pr) => ({
              number: pr.number,
              baseRefName: pr.baseRefName ?? defaultBranch.name,
              headRefOid: pr.headRefOid ?? sha(pr.number),
              isDraft: pr.isDraft ?? false,
              reviewDecision: pr.reviewDecision ?? null,
              isCrossRepository: pr.fork ?? false,
              author: pr.author === undefined ? { login: "alice" } : pr.author,
              labels: { nodes: (pr.labels ?? []).map((name) => ({ name })) },
              ...rollup(pr, null),
              comments: page(pr.comments ?? [], 100, null),
            })),
          },
        },
      },
    };
  }

  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, path, body, headers: init.headers });
    if (path === "/graphql") {
      const override = rest?.("POST", path, body);
      if (override) return respond(override.status, override.body, override.headers);
      return respond(200, graphql(body.query, body.variables));
    }
    const override = rest?.(init.method, path, body);
    if (override) return respond(override.status, override.body, override.headers);
    return respond(200, init.method === "DELETE" ? "" : { id: 4242 });
  };
  return { fetch, calls };
}

function client(fake, extra = {}) {
  return createGitHub({
    token: TOKEN,
    repo: REPO,
    fetch: fake.fetch,
    sleep: async () => {},
    ...extra,
  });
}

const own = (id, body = embed(result(12))) => ({ databaseId: id, body, viewerDidAuthor: true });

describe("readState", () => {
  it("returns the default branch, which need not be main, and the pull requests", async () => {
    const fake = fakeGitHub({
      defaultBranch: { name: "trunk", oid: sha(7) },
      prs: [
        { number: 15, labels: ["urgent"], isDraft: true, reviewDecision: "APPROVED", author: null },
        { number: 12, baseRefName: "release", fork: true },
      ],
    });
    const state = await client(fake).readState(config);
    assert.deepEqual(state.base, { ref: "trunk", sha: sha(7) });
    assert.deepEqual(
      state.pulls.map((p) => p.number),
      [12, 15],
    );
    const [twelve, fifteen] = state.pulls;
    assert.equal(twelve.baseRefName, "release");
    assert.equal(twelve.fork, true);
    assert.equal(twelve.author, "alice");
    assert.equal(fifteen.author, null);
    assert.equal(fifteen.isDraft, true);
    assert.equal(fifteen.reviewDecision, "APPROVED");
    assert.deepEqual(fifteen.labels, ["urgent"]);
    assert.equal(fifteen.headRefOid, sha(15));
    assert.equal(fifteen.fork, false);
    assert.equal(fifteen.recorded, null);
    assert.equal(fifteen.checkRunId, null);
    assert.deepEqual(fifteen.comments, []);
  });

  it("follows the pull request pages", async () => {
    const fake = fakeGitHub({
      prPage: 2,
      prs: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }, { number: 5 }],
    });
    const state = await client(fake).readState(config);
    assert.deepEqual(
      state.pulls.map((p) => p.number),
      [1, 2, 3, 4, 5],
    );
    assert.equal(
      fake.calls.filter((c) => c.path === "/graphql" && !c.body.variables.ids).length,
      3,
    );
  });

  it("finds the radar's check, and none when it is absent", async () => {
    const fake = fakeGitHub({
      prs: [
        {
          number: 12,
          contexts: [
            { id: "CR100", databaseId: 100, name: "PR conflict radar" },
            { id: "CR101", databaseId: 101, name: "other check" },
          ],
          checks: [{ id: "CR100", text: checkText(12) }],
        },
        { number: 15, contexts: [{ id: "CR200", databaseId: 200, name: "other check" }] },
      ],
    });
    const state = await client(fake).readState(config);
    assert.equal(state.pulls[0].checkRunId, 100);
    assert.equal(state.pulls[0].recorded.pr, 12);
    assert.equal(state.pulls[1].recorded, null);
    assert.equal(state.pulls[1].checkRunId, null);
  });

  it("uses the configured check name", async () => {
    const fake = fakeGitHub({
      prs: [
        {
          number: 12,
          contexts: [{ id: "CR100", databaseId: 100, name: "custom radar" }],
          checks: [{ id: "CR100", text: checkText(12) }],
        },
      ],
    });
    const state = await client(fake).readState({ ...config, checkName: "custom radar" });
    assert.equal(state.pulls[0].checkRunId, 100);
  });

  it("finds the radar's check on the second page of a rollup with more than 100 contexts", async () => {
    const contexts = Array.from({ length: 130 }, (_, i) => ({
      id: `CR${i + 1}`,
      databaseId: i + 1,
      name: i === 119 ? "PR conflict radar" : `job ${i}`,
    }));
    const fake = fakeGitHub({
      prs: [{ number: 12, contexts, checks: [{ id: "CR120", text: checkText(12) }] }],
    });
    const state = await client(fake).readState(config);
    assert.equal(state.pulls[0].checkRunId, 120);
    assert.equal(state.pulls[0].recorded.pr, 12);
  });

  it("returns the radar's own comments and continues the list past 100", async () => {
    const comments = Array.from({ length: 130 }, (_, i) => ({
      databaseId: i + 1,
      body: `comment ${i}`,
      viewerDidAuthor: true,
    }));
    comments[5] = own(6);
    comments[120] = own(121);
    const fake = fakeGitHub({ prs: [{ number: 12, comments }] });
    const state = await client(fake).readState(config);
    assert.deepEqual(
      state.pulls[0].comments.map((c) => c.id),
      [6, 121],
    );
    assert.match(state.pulls[0].comments[0].body, /pr-conflict-radar:v1/);
  });

  it("asks for no check text in the state query and fetches it by id in a second one", async () => {
    const fake = fakeGitHub({
      prs: [
        {
          number: 12,
          contexts: [
            { id: "CR100", databaseId: 100, name: "PR conflict radar" },
            { id: "CR101", databaseId: 101, name: "other check" },
          ],
          checks: [
            { id: "CR100", text: checkText(12) },
            { id: "CR101", text: "output of another check" },
          ],
        },
      ],
    });
    await client(fake).readState(config);
    const queries = fake.calls.filter((c) => c.path === "/graphql");
    const first = queries[0].body.query;
    assert.doesNotMatch(first, /\btext\b/);
    assert.doesNotMatch(first, /\btitle\b/);
    assert.doesNotMatch(first, /\bbranch|headRefName\b/);
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1].body.variables.ids, ["CR100"]);
  });

  it("asks for the fields the radar reads and no title", async () => {
    const fake = fakeGitHub({ prs: [] });
    await client(fake).readState(config);
    const { query } = fake.calls[0].body;
    for (const field of ["viewerDidAuthor", "statusCheckRollup", "reviewDecision", "isDraft"]) {
      assert.match(query, new RegExp(field));
    }
  });
});

describe("the radar's own comment", () => {
  it("is not returned when the marker comes from another author", async () => {
    const fake = fakeGitHub({
      prs: [
        {
          number: 12,
          comments: [
            { databaseId: 1, body: embed(result(12)), viewerDidAuthor: false },
            { databaseId: 2, body: "no marker here", viewerDidAuthor: true },
            own(3),
          ],
        },
      ],
    });
    const state = await client(fake).readState(config);
    assert.deepEqual(
      state.pulls[0].comments.map((c) => c.id),
      [3],
    );
  });

  it("keeps an own comment whose marker is malformed, so the probe can judge it", async () => {
    const fake = fakeGitHub({
      prs: [{ number: 12, comments: [own(1, "<!-- pr-conflict-radar:v1 {not json -->")] }],
    });
    const state = await client(fake).readState(config);
    assert.equal(state.pulls[0].comments.length, 1);
  });
});

describe("the radar's own check", () => {
  const radar = (id, text) => ({
    check: { id: `CR${id}`, databaseId: id, name: "PR conflict radar" },
    text,
  });

  async function recordedFor(texts) {
    const entries = texts.map(([id, text]) => radar(id, text));
    const fake = fakeGitHub({
      prs: [
        {
          number: 12,
          contexts: entries.map((e) => e.check),
          checks: entries.map((e) => ({ id: e.check.id, text: e.text })),
        },
      ],
    });
    return (await client(fake).readState(config)).pulls[0];
  }

  it("is not a check with the name and no embedded result", async () => {
    const pull = await recordedFor([[100, "a workflow job that shares the name"]]);
    assert.equal(pull.recorded, null);
    assert.equal(pull.checkRunId, null);
  });

  it("is not a check whose result names another pull request or repository", async () => {
    const pull = await recordedFor([
      [100, checkText(15)],
      [101, checkText(12, "acme/other")],
    ]);
    assert.equal(pull.recorded, null);
  });

  it("is not a check whose marker is malformed or of an unknown schema", async () => {
    const pull = await recordedFor([
      [100, "<!-- pr-conflict-radar:v1 {nope -->"],
      [101, embed({ ...result(12), schema: 2 })],
    ]);
    assert.equal(pull.recorded, null);
  });

  it("is the newer of two that qualify", async () => {
    const older = { ...result(12), notes: ["older"] };
    const newer = { ...result(12), notes: ["newer"] };
    const pull = await recordedFor([
      [200, embed(newer)],
      [100, embed(older)],
    ]);
    assert.equal(pull.checkRunId, 200);
    assert.deepEqual(pull.recorded.notes, ["newer"]);
  });

  it("skips a newer check that does not qualify", async () => {
    const pull = await recordedFor([
      [100, checkText(12)],
      [200, "no result"],
    ]);
    assert.equal(pull.checkRunId, 100);
  });
});

describe("the REST writes", () => {
  const check = {
    name: "PR conflict radar",
    conclusion: "neutral",
    title: "Conflicts with 1 pull request",
    summary: "summary",
    text: "text",
  };

  it("creates and updates a check run with the output title", async () => {
    const fake = fakeGitHub({ prs: [] });
    const api = client(fake);
    assert.deepEqual(await api.createCheckRun(sha(12), check), { id: 4242 });
    await api.updateCheckRun(77, check);
    const [create, update] = fake.calls;
    assert.equal(create.method, "POST");
    assert.equal(create.path, "/repos/acme/widgets/check-runs");
    assert.deepEqual(create.body, {
      name: "PR conflict radar",
      head_sha: sha(12),
      status: "completed",
      conclusion: "neutral",
      output: { title: "Conflicts with 1 pull request", summary: "summary", text: "text" },
    });
    assert.equal(update.method, "PATCH");
    assert.equal(update.path, "/repos/acme/widgets/check-runs/77");
    assert.equal(update.body.output.title, "Conflicts with 1 pull request");
    assert.equal(update.body.conclusion, "neutral");
  });

  it("creates, updates and deletes a comment in the configured repository only", async () => {
    const fake = fakeGitHub({ prs: [] });
    const api = client(fake);
    assert.deepEqual(await api.createComment(15, "body"), { id: 4242 });
    await api.updateComment(9, "new body");
    await api.deleteComment(9);
    assert.deepEqual(
      fake.calls.map((c) => [c.method, c.path, c.body]),
      [
        ["POST", "/repos/acme/widgets/issues/15/comments", { body: "body" }],
        ["PATCH", "/repos/acme/widgets/issues/comments/9", { body: "new body" }],
        ["DELETE", "/repos/acme/widgets/issues/comments/9", undefined],
      ],
    );
  });

  it("sends the token only in the Authorization header", async () => {
    const fake = fakeGitHub({ prs: [] });
    await client(fake).createComment(15, "body");
    const [call] = fake.calls;
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.doesNotMatch(JSON.stringify(call.body), new RegExp(TOKEN));
    assert.doesNotMatch(call.path, new RegExp(TOKEN));
  });

  it("rejects an invalid repository and a missing token", () => {
    assert.throws(() => createGitHub({ token: TOKEN, repo: "acme", fetch: () => {} }), TypeError);
    assert.throws(() => createGitHub({ token: "", repo: REPO, fetch: () => {} }), TypeError);
  });
});

describe("errors", () => {
  it("surfaces a REST status, the endpoint and the body", async () => {
    const fake = fakeGitHub({
      prs: [],
      rest: () => ({ status: 422, body: '{"message":"Validation Failed"}' }),
    });
    await assert.rejects(client(fake).createComment(15, "x"), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 422);
      assert.equal(error.endpoint, "POST /repos/acme/widgets/issues/15/comments");
      assert.match(error.body, /Validation Failed/);
      assert.match(error.message, /422/);
      assert.match(error.message, /issues\/15\/comments/);
      assert.match(error.message, /Validation Failed/);
      return true;
    });
  });

  it("surfaces GraphQL errors that arrive with HTTP 200", async () => {
    const fake = fakeGitHub({
      prs: [],
      rest: (_method, path) =>
        path === "/graphql"
          ? { status: 200, body: { errors: [{ message: "Resource not accessible" }] } }
          : undefined,
    });
    await assert.rejects(client(fake).readState(config), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 200);
      assert.equal(error.endpoint, "POST /graphql");
      assert.match(error.message, /Resource not accessible/);
      return true;
    });
  });

  it("never puts the token in an error message", async () => {
    const fake = fakeGitHub({
      prs: [],
      rest: () => ({ status: 401, body: `{"message":"Bad credentials for ${TOKEN}"}` }),
    });
    await assert.rejects(client(fake).deleteComment(1), (error) => {
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.doesNotMatch(error.body, new RegExp(TOKEN));
      assert.match(error.message, /Bad credentials/);
      return true;
    });
  });

  it("logs a body carrying a workflow command without a # and on one line", async () => {
    const fake = fakeGitHub({
      prs: [],
      rest: () => ({ status: 400, body: "##[error]injected\n::error::more" }),
    });
    await assert.rejects(client(fake).deleteComment(1), (error) => {
      assert.doesNotMatch(error.message, /#/);
      assert.doesNotMatch(error.message, /\n/);
      assert.match(error.message, /\\u0023\\u005berror|\\u0023\[error\]/);
      return true;
    });
  });

  it("cuts a long body", async () => {
    const fake = fakeGitHub({ prs: [], rest: () => ({ status: 400, body: "x".repeat(50000) }) });
    await assert.rejects(client(fake).deleteComment(1), (error) => {
      assert.ok(error.message.length < 3000);
      return true;
    });
  });

  it("retries once on a 5xx and succeeds", async () => {
    let attempts = 0;
    const waits = [];
    const fake = fakeGitHub({
      prs: [],
      rest: () => (++attempts === 1 ? { status: 502, body: "bad gateway" } : undefined),
    });
    await client(fake, { sleep: async (ms) => waits.push(ms) }).updateComment(1, "x");
    assert.equal(attempts, 2);
    assert.equal(waits.length, 1);
  });

  it("retries only once on a persistent 5xx", async () => {
    const fake = fakeGitHub({ prs: [], rest: () => ({ status: 503, body: "down" }) });
    await assert.rejects(client(fake).updateComment(1, "x"), (error) => error.status === 503);
    assert.equal(fake.calls.length, 2);
  });

  it("retries once on a secondary rate limit, waiting for retry-after", async () => {
    let attempts = 0;
    const waits = [];
    const fake = fakeGitHub({
      prs: [],
      rest: () =>
        ++attempts === 1
          ? {
              status: 403,
              body: '{"message":"You have exceeded a secondary rate limit."}',
              headers: { "retry-after": "7" },
            }
          : undefined,
    });
    await client(fake, { sleep: async (ms) => waits.push(ms) }).createComment(1, "x");
    assert.equal(attempts, 2);
    assert.deepEqual(waits, [7000]);
  });

  it("does not retry a plain 403 or a 4xx", async () => {
    const fake = fakeGitHub({
      prs: [],
      rest: () => ({ status: 403, body: '{"message":"Resource not accessible by integration"}' }),
    });
    await assert.rejects(client(fake).createComment(1, "x"), (error) => error.status === 403);
    assert.equal(fake.calls.length, 1);
  });
});
