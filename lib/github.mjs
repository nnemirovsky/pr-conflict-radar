// The GitHub client: one paginated GraphQL read of the repository's state and
// the REST writes the publisher makes, all against one repository.
//
// The client takes an injected `fetch`, so tests run it against a fake. The
// token goes only into the `Authorization` header; it is never part of an
// error message. Everything an error carries (status, endpoint, response body)
// passes through the log serializer, so it is one line without `#`.

import { logLine } from "./escape.mjs";
import { extract, MARKER_PREFIX } from "./report.mjs";

export const DEFAULT_API_URL = "https://api.github.com";

const PAGE = 100;
const PR_PAGE = 50;
const TEXT_BATCH = 20;
const BODY_LIMIT = 2000;
const MAX_WAIT_MS = 60000;

// A failed API request. `status` is the HTTP status (200 for a GraphQL `errors`
// payload), `endpoint` names the method and path and `body` is the response
// body, cut to a bounded length.
export class GitHubError extends Error {
  constructor(message, { status, endpoint, body }) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

const CONTEXTS = `contexts(first: ${PAGE}, after: $contextsAfter) {
  pageInfo { hasNextPage endCursor }
  nodes { __typename ... on CheckRun { id databaseId name } }
}`;

const COMMENTS = `comments(first: ${PAGE}, after: $commentsAfter) {
  pageInfo { hasNextPage endCursor }
  nodes { databaseId body viewerDidAuthor }
}`;

const STATE_QUERY = `query($owner: String!, $name: String!, $after: String, $contextsAfter: String, $commentsAfter: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name target { oid } }
    pullRequests(states: OPEN, first: ${PR_PAGE}, after: $after, orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        baseRefName
        headRefOid
        isDraft
        reviewDecision
        isCrossRepository
        author { login }
        labels(first: ${PAGE}) { nodes { name } }
        commits(last: 1) { nodes { commit { statusCheckRollup { ${CONTEXTS} } } } }
        ${COMMENTS}
      }
    }
  }
}`;

const CONTEXTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $contextsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { statusCheckRollup { ${CONTEXTS} } } } }
    }
  }
}`;

const COMMENTS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $commentsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${COMMENTS} }
  }
}`;

const TEXT_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on CheckRun { id databaseId text } }
}`;

// The check runs of a rollup page that carry `checkName`, as `{id, databaseId}`.
function namedChecks(contexts, checkName) {
  return (contexts?.nodes ?? [])
    .filter((node) => node?.__typename === "CheckRun" && node.name === checkName)
    .map((node) => ({ id: node.id, databaseId: node.databaseId }));
}

function rollupOf(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts ?? null;
}

// Whether a comment is the radar's own: it carries the marker and the token's
// identity wrote it. A comment with the marker from anyone else is ignored.
function isOwnComment(comment) {
  return (
    comment?.viewerDidAuthor === true &&
    typeof comment.body === "string" &&
    comment.body.includes(MARKER_PREFIX)
  );
}

const ownComments = (nodes) =>
  (nodes ?? []).filter(isOwnComment).map(({ databaseId, body }) => ({ id: databaseId, body }));

// Creates a client for `repo` (`owner/name`). Options: `token`, `fetch`,
// `apiUrl` (default `https://api.github.com`) and `sleep(ms)` for the retry
// wait.
export function createGitHub({
  token,
  repo,
  fetch = globalThis.fetch,
  apiUrl = DEFAULT_API_URL,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo ?? "");
  if (!match) throw new TypeError("repo must be owner/name");
  if (typeof token !== "string" || token === "") throw new TypeError("a token is required");
  const [, owner, name] = match;
  const base = apiUrl.replace(/\/+$/, "");

  const scrub = (text) => (token ? text.split(token).join("***") : text);

  function failure(prefix, { status, endpoint, body }) {
    const cut = body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}...` : body;
    const detail = scrub(logLine({ status, endpoint, body: scrub(cut) }));
    return new GitHubError(`${prefix} ${detail}`, { status, endpoint, body: scrub(cut) });
  }

  // A secondary rate limit is a 403 or 429 that says so or asks to wait.
  function rateLimited(res, text) {
    if (res.status !== 403 && res.status !== 429) return false;
    return /secondary rate limit/i.test(text) || res.headers?.get?.("retry-after") != null;
  }

  function waitMs(res) {
    const seconds = Number(res.headers?.get?.("retry-after"));
    const ms = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000;
    return Math.min(ms, MAX_WAIT_MS);
  }

  // One request, retried once on a 5xx and on a secondary rate limit. Returns
  // the response text and status of a successful one.
  async function send(method, path, body) {
    const endpoint = `${method} ${path}`;
    const init = {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "pr-conflict-radar",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, init);
      const text = await res.text();
      if (res.ok) return { status: res.status, text };
      if (attempt === 0 && (res.status >= 500 || rateLimited(res, text))) {
        await sleep(res.status >= 500 ? 1000 : waitMs(res));
        continue;
      }
      throw failure("GitHub API request failed:", { status: res.status, endpoint, body: text });
    }
  }

  async function graphql(query, variables) {
    const endpoint = "POST /graphql";
    const { status, text } = await send("POST", "/graphql", { query, variables });
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw failure("GitHub GraphQL response is not JSON:", { status, endpoint, body: text });
    }
    if (payload === null || typeof payload !== "object") {
      throw failure("GitHub GraphQL response is not an object:", { status, endpoint, body: text });
    }
    if (payload.errors) {
      throw failure("GitHub GraphQL request failed:", {
        status,
        endpoint,
        body: JSON.stringify(payload.errors),
      });
    }
    return payload.data;
  }

  // The rest of a rollup past its first 100 contexts.
  async function continueContexts(number, after, checkName) {
    const found = [];
    for (let cursor = after; cursor; ) {
      const data = await graphql(CONTEXTS_QUERY, {
        owner,
        name,
        number,
        contextsAfter: cursor,
      });
      const contexts = rollupOf(data.repository.pullRequest);
      found.push(...namedChecks(contexts, checkName));
      cursor = contexts?.pageInfo?.hasNextPage ? contexts.pageInfo.endCursor : null;
    }
    return found;
  }

  // The rest of a comment list past its first 100 comments.
  async function continueComments(number, after) {
    const found = [];
    for (let cursor = after; cursor; ) {
      const data = await graphql(COMMENTS_QUERY, { owner, name, number, commentsAfter: cursor });
      const comments = data.repository.pullRequest.comments;
      found.push(...ownComments(comments.nodes));
      cursor = comments.pageInfo?.hasNextPage ? comments.pageInfo.endCursor : null;
    }
    return found;
  }

  // The `text` of the check runs `checks` (`{id, databaseId}`), by id, in
  // batches. Returns a map from `databaseId` to text.
  async function fetchTexts(checks) {
    const texts = new Map();
    for (let i = 0; i < checks.length; i += TEXT_BATCH) {
      const data = await graphql(TEXT_QUERY, {
        ids: checks.slice(i, i + TEXT_BATCH).map((check) => check.id),
      });
      for (const node of data.nodes ?? []) {
        if (node?.databaseId != null) texts.set(node.databaseId, node.text ?? "");
      }
    }
    return texts;
  }

  // The radar's own check among `checks`: the newest one whose `text` carries a
  // readable result of this repository and `number`. Returns `{id, result}` or
  // `null`.
  function ownCheck(checks, texts, number) {
    let best = null;
    for (const check of checks) {
      const result = extract(texts.get(check.databaseId));
      if (result === null || result.repo !== repo || result.pr !== number) continue;
      if (best === null || check.databaseId > best.id) best = { id: check.databaseId, result };
    }
    return best;
  }

  // Reads the repository's state with one paginated query and a second one for
  // the text of the check runs named `config.checkName`. Returns
  // `{base: {ref, sha}, pulls}` where `ref` is the default branch's name and
  // each pull request is `{number, baseRefName, headRefOid, author, labels,
  // isDraft, reviewDecision, fork, recorded, checkRunId, comments}`: `author`
  // a login or `null`, `fork` whether the head lives in another repository,
  // `recorded` the result the radar's own check on the head embeds (or `null`)
  // with that check's id in `checkRunId`, and `comments` the radar's own marker
  // comments in creation order.
  async function readState(config) {
    const checkName = config.checkName;
    let defaultBranch = null;
    const raw = [];
    for (let after = null; ; ) {
      const data = await graphql(STATE_QUERY, {
        owner,
        name,
        after,
        contextsAfter: null,
        commentsAfter: null,
      });
      const repository = data.repository;
      if (!repository.defaultBranchRef) throw new Error("the repository has no default branch");
      defaultBranch = {
        ref: repository.defaultBranchRef.name,
        sha: repository.defaultBranchRef.target.oid,
      };
      raw.push(...repository.pullRequests.nodes);
      const page = repository.pullRequests.pageInfo;
      if (!page.hasNextPage) break;
      after = page.endCursor;
    }

    const pulls = [];
    const checks = new Map();
    for (const node of raw) {
      const contexts = rollupOf(node);
      const named = namedChecks(contexts, checkName);
      if (contexts?.pageInfo?.hasNextPage) {
        named.push(
          ...(await continueContexts(node.number, contexts.pageInfo.endCursor, checkName)),
        );
      }
      const comments = ownComments(node.comments?.nodes);
      if (node.comments?.pageInfo?.hasNextPage) {
        comments.push(...(await continueComments(node.number, node.comments.pageInfo.endCursor)));
      }
      checks.set(node.number, named);
      pulls.push({
        number: node.number,
        baseRefName: node.baseRefName,
        headRefOid: node.headRefOid,
        author: node.author?.login ?? null,
        labels: (node.labels?.nodes ?? []).map((label) => label.name),
        isDraft: node.isDraft,
        reviewDecision: node.reviewDecision ?? null,
        fork: node.isCrossRepository === true,
        recorded: null,
        checkRunId: null,
        comments,
      });
    }

    const texts = await fetchTexts([...checks.values()].flat());
    for (const pull of pulls) {
      const own = ownCheck(checks.get(pull.number), texts, pull.number);
      if (own) {
        pull.recorded = own.result;
        pull.checkRunId = own.id;
      }
    }
    pulls.sort((a, b) => a.number - b.number);
    return { base: defaultBranch, pulls };
  }

  const output = (check) => ({ title: check.title, summary: check.summary, text: check.text });

  // The REST writes. `check` is what `renderCheck` returns.
  async function write(method, path, body) {
    const { text } = await send(method, path, body);
    return text === "" ? null : JSON.parse(text);
  }

  return {
    readState,
    async createCheckRun(headSha, check) {
      const created = await write("POST", `/repos/${repo}/check-runs`, {
        name: check.name,
        head_sha: headSha,
        status: "completed",
        conclusion: check.conclusion,
        output: output(check),
      });
      return { id: created.id };
    },
    async updateCheckRun(id, check) {
      await write("PATCH", `/repos/${repo}/check-runs/${id}`, {
        name: check.name,
        status: "completed",
        conclusion: check.conclusion,
        output: output(check),
      });
    },
    async createComment(number, body) {
      const created = await write("POST", `/repos/${repo}/issues/${number}/comments`, { body });
      return { id: created.id };
    },
    async updateComment(id, body) {
      await write("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
    },
    async deleteComment(id) {
      await write("DELETE", `/repos/${repo}/issues/comments/${id}`);
    },
  };
}
