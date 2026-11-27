// Path globs, path classes and pair keys.
//
// Globs support `**` and `*` only. `*` matches within one path segment, `**`
// matches across segments, and `**/` also matches zero directories, so
// `**/*.md` matches a root-level `README.md`. Every other character is literal.
// Dot files and dot directories get no special treatment.

export const PAIR_KEY_PLACEHOLDERS = Object.freeze(["owner", "repo", "low", "high"]);

const globCache = new Map();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globToRegExp(pattern) {
  let source = "";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      source += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += escapeRegExp(pattern[i]);
      i += 1;
    }
  }
  return new RegExp(`^${source}$`, "s");
}

export function matchGlob(path, pattern) {
  let regex = globCache.get(pattern);
  if (!regex) {
    regex = globToRegExp(pattern);
    globCache.set(pattern, regex);
  }
  return regex.test(path);
}

export function matchesAny(path, patterns) {
  return patterns.some((pattern) => matchGlob(path, pattern));
}

// The class of a file: the first class with a matching pattern, otherwise the
// most severe class.
export function classOf(path, config) {
  for (const cls of config.classes) {
    if (matchesAny(path, cls.patterns)) return cls.name;
  }
  return config.severity[config.severity.length - 1];
}

// The most severe of the given class names per `severity` (least to most
// severe), or `null` for an empty list.
export function mostSevere(classes, config) {
  let best = null;
  let bestRank = -1;
  for (const name of classes) {
    const rank = config.severity.indexOf(name);
    if (rank > bestRank) {
      best = name;
      bestRank = rank;
    }
  }
  return best;
}

// The pair key of two pull requests of `repo` (`owner/name`), from the
// `pairKey` template, with the lower number as `{low}`.
export function pairKey(config, repo, a, b) {
  const slash = repo.indexOf("/");
  const values = {
    owner: slash < 0 ? "" : repo.slice(0, slash),
    repo: slash < 0 ? repo : repo.slice(slash + 1),
    low: String(Math.min(a, b)),
    high: String(Math.max(a, b)),
  };
  return config.pairKey.replace(/\{([^{}]*)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? values[name] : match,
  );
}
