// A stateful fake of the GitHub API for tests: the GraphQL reads the client
// makes and the REST writes it sends, over pull requests, check runs and
// comments that the writes change. `fetch` is what `createGitHub` takes.

export function createFakeGitHub({
  repo = "acme/widgets",
  defaultBranch = { name: "main", oid: "0".repeat(40) },
  prs = [],
  checks = [],
  comments = [],
} = {}) {
  let lastId = 1000;
  const newId = () => {
    lastId += 1;
    return lastId;
  };
  const state = {
    defaultBranch,
    prs: prs.map((pr) => ({
      baseRefName: defaultBranch.name,
      isDraft: false,
      reviewDecision: null,
      author: "alice",
      labels: [],
      ...pr,
    })),
    // `{id, name, head, text, conclusion, own}`
    checks: checks.map((check) => ({
      id: newId(),
      text: "",
      conclusion: "neutral",
      ...check,
    })),
    // `{id, pr, body, viewerDidAuthor}`
    comments: comments.map((comment) => ({
      id: newId(),
      viewerDidAuthor: false,
      ...comment,
    })),
  };
  const calls = [];
  const writes = [];
  let failure = null;

  const respond = (status, body) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  function prNode(pr) {
    const contexts = state.checks
      .filter((check) => check.head === pr.headRefOid)
      .map((check) => ({
        __typename: "CheckRun",
        id: `CR${check.id}`,
        databaseId: check.id,
        name: check.name,
      }));
    const page = (nodes) => ({ pageInfo: { hasNextPage: false, endCursor: null }, nodes });
    return {
      number: pr.number,
      baseRefName: pr.baseRefName,
      headRefOid: pr.headRefOid,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      isCrossRepository: pr.fork === true,
      author: pr.author === null ? null : { login: pr.author },
      labels: { nodes: pr.labels.map((name) => ({ name })) },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: page(contexts) } } }] },
      comments: page(
        state.comments
          .filter((comment) => comment.pr === pr.number)
          .map(({ id, body, viewerDidAuthor }) => ({ databaseId: id, body, viewerDidAuthor })),
      ),
    };
  }

  function graphql(variables) {
    if (variables.ids) {
      return {
        data: {
          nodes: variables.ids.map((id) => {
            const check = state.checks.find((candidate) => `CR${candidate.id}` === id);
            return { id, databaseId: check.id, text: check.text };
          }),
        },
      };
    }
    return {
      data: {
        repository: {
          defaultBranchRef: {
            name: state.defaultBranch.name,
            target: { oid: state.defaultBranch.oid },
          },
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: state.prs.map(prNode),
          },
        },
      },
    };
  }

  function rest(method, path, body) {
    const checkRuns = `/repos/${repo}/check-runs`;
    const issues = `/repos/${repo}/issues`;
    if (method === "POST" && path === checkRuns) {
      const check = {
        id: newId(),
        name: body.name,
        head: body.head_sha,
        conclusion: body.conclusion,
        text: body.output.text,
        title: body.output.title,
        own: true,
      };
      state.checks.push(check);
      return { id: check.id };
    }
    const checkMatch = new RegExp(`^${checkRuns}/(\\d+)$`).exec(path);
    if (method === "PATCH" && checkMatch) {
      const check = state.checks.find((candidate) => candidate.id === Number(checkMatch[1]));
      Object.assign(check, {
        name: body.name,
        conclusion: body.conclusion,
        text: body.output.text,
        title: body.output.title,
      });
      return { id: check.id };
    }
    const created = new RegExp(`^${issues}/(\\d+)/comments$`).exec(path);
    if (method === "POST" && created) {
      const comment = {
        id: newId(),
        pr: Number(created[1]),
        body: body.body,
        viewerDidAuthor: true,
      };
      state.comments.push(comment);
      return { id: comment.id };
    }
    const existing = new RegExp(`^${issues}/comments/(\\d+)$`).exec(path);
    if (existing) {
      const index = state.comments.findIndex((comment) => comment.id === Number(existing[1]));
      if (method === "PATCH") {
        state.comments[index].body = body.body;
        return { id: state.comments[index].id };
      }
      if (method === "DELETE") {
        state.comments.splice(index, 1);
        return "";
      }
    }
    throw new Error(`fake GitHub: unexpected ${method} ${path}`);
  }

  async function fetch(url, init) {
    const path = new URL(url).pathname;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ method: init.method, path, body });
    if (failure) return failure(init.method, path);
    if (path === "/graphql") return respond(200, graphql(body.variables));
    writes.push({ method: init.method, path, body });
    const result = rest(init.method, path, body);
    return respond(200, result);
  }

  return {
    fetch,
    state,
    calls,
    writes,
    // Makes every request answer with `fn(method, path)`, a `Response`.
    failWith(fn) {
      failure = fn;
    },
  };
}
