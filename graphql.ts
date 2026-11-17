// GitHub GraphQL v4: the documents `gh` and `github-mcp-server` actually send.
//
// A small but real engine: it parses a document (operations, variables, fragments, aliases,
// directives), executes it against the same store REST serves, and answers introspection for the
// four types the suite describes. An unknown field is an error in `errors`, never a crash; an
// unknown repository is `data.repository = null` with no errors.

import { pullFiles, issueJson } from './rest.ts';
import { createCommit } from './worktree.ts';
import { commitChain, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- lexer

interface Token {
  readonly kind: 'name' | 'number' | 'string' | 'punct' | 'spread';
  readonly value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:!$@=|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      at += 1;
      if (source.slice(at, at + 2) === '""') {
        at += 2;
        while (at < source.length && source.slice(at, at + 3) !== '"""') {
          value += source[at];
          at += 1;
        }
        at += 3;
      } else {
        while (at < source.length && source[at] !== '"') {
          if (source[at] === '\\') {
            value += source[at + 1];
            at += 2;
            continue;
          }
          value += source[at];
          at += 1;
        }
        at += 1;
      }
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let value = '';
      while (at < source.length && /[-+0-9.eE]/.test(source[at])) {
        value += source[at];
        at += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (at < source.length && /[_0-9A-Za-z]/.test(source[at])) {
        value += source[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    at += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, ValueNode>;
  readonly selection: SelectionSet | null;
  readonly directives: Array<{ name: string; args: Record<string, ValueNode> }>;
}

export interface SelectionSet {
  readonly fields: FieldNode[];
  readonly spreads: Array<{ name: string; selection: SelectionSet | null }>;
}

export type ValueNode =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'list'; readonly values: ValueNode[] }
  | { readonly kind: 'object'; readonly fields: Record<string, ValueNode> };

interface Operation {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly selection: SelectionSet;
}

class Parser {
  private readonly tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token | undefined {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }

  private expect(value: string): void {
    const token = this.next();
    if (token === undefined || token.value !== value) throw new Error(`expected ${value}, saw ${token?.value ?? 'end of document'}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionSet> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionSet>();
    while (this.peek() !== undefined) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const kind = this.next()?.value as Operation['kind'];
        let name: string | null = null;
        const maybe = this.peek();
        if (maybe !== undefined && maybe.kind === 'name') name = this.next()?.value ?? null;
        this.skipVariableDefinitions();
        operations.push({ kind, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.next()?.value ?? '';
        this.next();
        this.next();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      operations.push({ kind: 'query', name: null, selection: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    const token = this.peek();
    if (token === undefined || token.value !== '(') return;
    let depth = 0;
    do {
      const current = this.next();
      if (current === undefined) return;
      if (current.value === '(') depth += 1;
      else if (current.value === ')') depth -= 1;
    } while (depth > 0);
  }

  private parseSelectionSet(): SelectionSet {
    this.expect('{');
    const fields: FieldNode[] = [];
    const spreads: Array<{ name: string; selection: SelectionSet | null }> = [];
    while (this.peek() !== undefined && this.peek()?.value !== '}') {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'spread') {
        this.next();
        const target = this.peek();
        if (target !== undefined && target.value === 'on') {
          this.next();
          this.next();
          spreads.push({ name: '', selection: this.parseSelectionSet() });
          continue;
        }
        spreads.push({ name: this.next()?.value ?? '', selection: null });
        continue;
      }
      fields.push(this.parseField());
    }
    this.expect('}');
    return { fields, spreads };
  }

  private parseField(): FieldNode {
    let name = this.next()?.value ?? '';
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next()?.value ?? '';
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() !== undefined && this.peek()?.value !== ')') {
        const key = this.next()?.value ?? '';
        this.expect(':');
        args[key] = this.parseValue();
      }
      this.expect(')');
    }
    const directives: Array<{ name: string; args: Record<string, ValueNode> }> = [];
    while (this.peek()?.value === '@') {
      this.next();
      const directiveName = this.next()?.value ?? '';
      const directiveArgs: Record<string, ValueNode> = {};
      if (this.peek()?.value === '(') {
        this.next();
        while (this.peek() !== undefined && this.peek()?.value !== ')') {
          const key = this.next()?.value ?? '';
          this.expect(':');
          directiveArgs[key] = this.parseValue();
        }
        this.expect(')');
      }
      directives.push({ name: directiveName, args: directiveArgs });
    }
    const selection = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selection, directives };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === undefined) throw new Error('unexpected end of document in a value');
    if (token.value === '$') return { kind: 'variable', name: this.next()?.value ?? '' };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== undefined && this.peek()?.value !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (this.peek() !== undefined && this.peek()?.value !== '}') {
        const key = this.next()?.value ?? '';
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.value === 'true' || token.value === 'false') return { kind: 'boolean', value: token.value === 'true' };
    if (token.value === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token.value };
  }
}

// ---------------------------------------------------------------- schema metadata (introspection)

const FIELD_TYPES: Record<string, Array<{ name: string; type: string; nonNull?: boolean }>> = {
  Issue: [
    { name: 'id', type: 'ID', nonNull: true },
    { name: 'number', type: 'Int', nonNull: true },
    { name: 'title', type: 'String', nonNull: true },
    { name: 'state', type: 'IssueState', nonNull: true },
    { name: 'body', type: 'String' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'author', type: 'User' },
    { name: 'labels', type: 'LabelConnection' },
    { name: 'repository', type: 'Repository' },
  ],
  PullRequest: [
    { name: 'id', type: 'ID', nonNull: true },
    { name: 'number', type: 'Int', nonNull: true },
    { name: 'title', type: 'String', nonNull: true },
    { name: 'body', type: 'String' },
    { name: 'state', type: 'PullRequestState', nonNull: true },
    { name: 'merged', type: 'Boolean', nonNull: true },
    { name: 'mergeable', type: 'MergeableState', nonNull: true },
    { name: 'headRefName', type: 'String', nonNull: true },
    { name: 'baseRefName', type: 'String', nonNull: true },
    { name: 'headRefOid', type: 'String' },
    { name: 'baseRefOid', type: 'String' },
    { name: 'files', type: 'PullRequestChangedFileConnection' },
    { name: 'createdAt', type: 'DateTime' },
    { name: 'mergeCommit', type: 'Commit' },
  ],
  Repository: [
    { name: 'id', type: 'ID', nonNull: true },
    { name: 'databaseId', type: 'Int' },
    { name: 'name', type: 'String', nonNull: true },
    { name: 'nameWithOwner', type: 'String', nonNull: true },
    { name: 'owner', type: 'RepositoryOwner', nonNull: true },
    { name: 'defaultBranchRef', type: 'Ref' },
    { name: 'viewerPermission', type: 'RepositoryPermission' },
    { name: 'hasIssuesEnabled', type: 'Boolean', nonNull: true },
    { name: 'description', type: 'String' },
    { name: 'isPrivate', type: 'Boolean', nonNull: true },
    { name: 'issue', type: 'Issue' },
    { name: 'issues', type: 'IssueConnection', nonNull: true },
    { name: 'pullRequest', type: 'PullRequest' },
    { name: 'pullRequests', type: 'PullRequestConnection', nonNull: true },
  ],
  User: [
    { name: 'id', type: 'ID', nonNull: true },
    { name: 'login', type: 'String', nonNull: true },
    { name: 'name', type: 'String' },
  ],
  Ref: [
    { name: 'name', type: 'String', nonNull: true },
    { name: 'target', type: 'GitObject' },
  ],
  Commit: [
    { name: 'oid', type: 'GitObjectID', nonNull: true },
    { name: 'message', type: 'String' },
  ],
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeRef(type: string, nonNull: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = ENUMS[type] !== undefined
    ? { kind: 'ENUM', name: type, ofType: null }
    : type === 'String' || type === 'Int' || type === 'Boolean' || type === 'ID' || type === 'DateTime' || type === 'GitObjectID'
      ? { kind: 'SCALAR', name: type, ofType: null }
      : { kind: 'OBJECT', name: type, ofType: null };
  return nonNull ? { kind: 'NON_NULL', name: null, ofType: base } : base;
}

function introspectType(name: string): Record<string, unknown> | null {
  if (ENUMS[name] !== undefined) {
    return {
      kind: 'ENUM',
      name,
      description: `${name} enum`,
      fields: null,
      enumValues: ENUMS[name].map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })),
      inputFields: null,
      interfaces: [],
    };
  }
  const fields = FIELD_TYPES[name];
  if (fields === undefined) return null;
  return {
    kind: 'OBJECT',
    name,
    description: `${name} type`,
    fields: fields.map((field) => ({
      name: field.name,
      description: `${field.name} of ${name}`,
      args: [],
      type: typeRef(field.type, field.nonNull === true),
      isDeprecated: false,
      deprecationReason: null,
    })),
    enumValues: null,
    inputFields: null,
    interfaces: [],
  };
}

// ---------------------------------------------------------------- execution

type Bag = Record<string, unknown>;

function encodeId(kind: string, value: number | string): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64').replace(/=+$/, '');
}

function decodeId(raw: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const index = text.indexOf(':');
    if (index < 0) return null;
    return { kind: text.slice(0, index), value: text.slice(index + 1) };
  } catch {
    return null;
  }
}

function resolveValue(node: ValueNode, variables: Bag): unknown {
  switch (node.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return node.value;
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Bag = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
    default:
      return null;
  }
}

function shouldInclude(field: FieldNode, variables: Bag): boolean {
  for (const directive of field.directives) {
    const condition = directive.args.if === undefined ? null : resolveValue(directive.args.if, variables);
    if (directive.name === 'skip' && condition === true) return false;
    if (directive.name === 'include' && condition !== true) return false;
  }
  return true;
}

interface Context {
  readonly store: Store;
  readonly variables: Bag;
  readonly fragments: Map<string, SelectionSet>;
  readonly errors: Array<Record<string, unknown>>;
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function ownerLogin(store: Store, repo: Repo): string {
  return repo.ownerLogin ?? store.login();
}

interface Connection {
  readonly __nodes: unknown[];
  readonly __total: number;
  readonly __hasNext: boolean;
  readonly __endCursor: string | null;
}

/** A connection honouring `first` and the `after` cursor this server itself handed out. */
function connection(items: readonly unknown[], args: Bag, wrap: (item: unknown) => unknown): Connection {
  const afterRaw = typeof args.after === 'string' ? args.after : null;
  const after = afterRaw !== null && afterRaw.startsWith('cursor:') ? Math.max(0, parseInt(afterRaw.slice(7), 10) || 0) : 0;
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const page = items.slice(after, after + first);
  const end = after + page.length;
  return {
    __nodes: page.map(wrap),
    __total: items.length,
    __hasNext: end < items.length,
    __endCursor: `cursor:${end}`,
  };
}

/** Field resolution for one object. Unknown fields push an error and yield undefined. */
function resolveField(ctx: Context, typeName: string, value: Bag, field: FieldNode): unknown {
  const args: Bag = {};
  for (const [key, node] of Object.entries(field.args)) args[key] = resolveValue(node, ctx.variables);
  const repo = value.__repo as Repo | undefined;
  const store = ctx.store;

  if (field.name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (field.name === 'repository' || field.name === 'repositoryById') {
        if (field.name === 'repositoryById') {
          const decoded = typeof args.repositoryId === 'string' ? decodeId(args.repositoryId) : null;
          if (decoded === null) return null;
          for (const candidate of store.repos.values()) if (String(candidate.id) === decoded.value) return { __repo: candidate };
          return null;
        }
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const name = typeof args.name === 'string' ? args.name : '';
        const found = store.find(owner, name);
        return found === null ? null : { __repo: found };
      }
      if (field.name === 'viewer') return { login: store.login(), id: encodeId('user', 1000) };
      if (field.name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeId(args.id) : null;
        if (decoded === null) return null;
        for (const candidate of store.repos.values()) if (String(candidate.id) === decoded.value) return { __repo: candidate };
        return null;
      }
      break;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Bag;
      const repoOf = (raw: unknown): Repo | null => {
        const decoded = typeof raw === 'string' ? decodeId(raw) : null;
        if (decoded === null) return null;
        for (const candidate of store.repos.values()) if (String(candidate.id) === decoded.value) return candidate;
        return null;
      };
      if (field.name === 'createIssue') {
        const target = repoOf(input.repositoryId);
        if (target === null) {
          ctx.errors.push({ message: 'createIssue: repository not found', path: ['createIssue'] });
          return null;
        }
        const issue = store.newIssue(
          target,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          Array.isArray(input.labelIds) ? [] : [],
        );
        return { issue: { __issue: issue, __repo: target } };
      }
      if (field.name === 'closeIssue') {
        const decoded = typeof input.issueId === 'string' ? decodeId(input.issueId) : null;
        if (decoded === null) {
          ctx.errors.push({ message: 'closeIssue: issueId is not a valid id', path: ['closeIssue'] });
          return null;
        }
        for (const candidate of store.repos.values()) {
          for (const issue of candidate.issues.values()) {
            if (String(issue.id) !== decoded.value) continue;
            issue.state = 'closed';
            issue.closedAt = store.now();
            issue.updatedAt = store.now();
            return { issue: { __issue: issue, __repo: candidate } };
          }
        }
        ctx.errors.push({ message: 'closeIssue: issue not found', path: ['closeIssue'] });
        return null;
      }
      if (field.name === 'addComment') {
        const decoded = typeof input.subjectId === 'string' ? decodeId(input.subjectId) : null;
        if (decoded === null) {
          ctx.errors.push({ message: 'addComment: subjectId is not a valid id', path: ['addComment'] });
          return null;
        }
        for (const candidate of store.repos.values()) {
          for (const issue of candidate.issues.values()) {
            if (String(issue.id) !== decoded.value) continue;
            const comment = store.newComment(candidate, issue.number, typeof input.body === 'string' ? input.body : '');
            return { commentEdge: { node: { id: encodeId('comment', comment.id), body: comment.body } } };
          }
        }
        ctx.errors.push({ message: 'addComment: subject not found', path: ['addComment'] });
        return null;
      }
      if (field.name === 'createPullRequest') {
        const target = repoOf(input.repositoryId);
        if (target === null) {
          ctx.errors.push({ message: 'createPullRequest: repository not found', path: ['createPullRequest'] });
          return null;
        }
        const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
        const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : target.defaultBranch;
        const headSha = target.refs.get(`refs/heads/${headRef}`);
        const baseSha = target.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: `createPullRequest: no commits between ${baseRef} and ${headRef}`, path: ['createPullRequest'] });
          return null;
        }
        const pull = store.newPull(target, {
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          headRef,
          headSha,
          baseRef,
          baseSha,
        });
        return { pullRequest: { __pull: pull, __repo: target } };
      }
      if (field.name === 'mergePullRequest') {
        const decoded = typeof input.pullRequestId === 'string' ? decodeId(input.pullRequestId) : null;
        if (decoded === null) {
          ctx.errors.push({ message: 'mergePullRequest: pullRequestId is not a valid id', path: ['mergePullRequest'] });
          return null;
        }
        for (const candidate of store.repos.values()) {
          for (const pull of candidate.pulls.values()) {
            if (String(pull.id) !== decoded.value) continue;
            const baseRef = `refs/heads/${pull.baseRef}`;
            const currentBase = candidate.refs.get(baseRef);
            const headTip = candidate.refs.get(`refs/heads/${pull.headRef}`);
            if (pull.state !== 'open' || currentBase === undefined || currentBase !== pull.baseSha || headTip === undefined) {
              ctx.errors.push({ message: 'mergePullRequest: pull request is not mergeable', path: ['mergePullRequest'] });
              return null;
            }
            const headObject = candidate.objects.get(headTip);
            const tree = headObject === undefined || headObject.type !== 'commit'
              ? null
              : headObject.data.toString('utf8').split('\n')[0].slice(5).trim();
            if (tree === null) {
              ctx.errors.push({ message: 'mergePullRequest: head is not a commit', path: ['mergePullRequest'] });
              return null;
            }
            const commit = createCommit(candidate, { tree, parents: [currentBase], message: `${pull.title} (#${pull.number})` });
            candidate.refs.set(baseRef, commit);
            pull.state = 'closed';
            pull.merged = true;
            pull.mergedAt = store.now();
            pull.mergeCommitSha = commit;
            pull.closedAt = pull.mergedAt;
            return { pullRequest: { __pull: pull, __repo: candidate } };
          }
        }
        ctx.errors.push({ message: 'mergePullRequest: pull request not found', path: ['mergePullRequest'] });
        return null;
      }
      break;
    }
    case 'Repository': {
      if (repo === undefined) return null;
      const owner = ownerLogin(store, repo);
      switch (field.name) {
        case 'id': return encodeId('repo', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${owner}/${repo.name}`;
        case 'owner': return { login: owner, id: encodeId('user', 1000) };
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'hasIssuesEnabled': return true;
        case 'viewerPermission': return 'ADMIN';
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { name: repo.defaultBranch, __oid: tip, __repo: repo };
        }
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : NaN;
          const issue = repo.issues.get(number);
          return issue === undefined ? null : { __issue: issue, __repo: repo };
        }
        case 'issues': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : [];
          let items = [...repo.issues.values()];
          if (states.length > 0) items = items.filter((issue) => states.includes(issueState(issue)));
          const orderBy = (args.orderBy ?? null) as Bag | null;
          const fieldName = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
          const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'DESC';
          const key = (issue: Issue): number => (fieldName === 'UPDATED_AT' ? issue.updatedAt : issue.createdAt);
          items.sort((a, b) => {
            const delta = key(a) - key(b);
            if (delta !== 0) return direction === 'ASC' ? delta : -delta;
            // A tie is broken by number DESC, as the rules state.
            return b.number - a.number;
          });
          return connection(items, args, (item) => ({ __issue: item as Issue, __repo: repo }));
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : NaN;
          const pull = repo.pulls.get(number);
          return pull === undefined ? null : { __pull: pull, __repo: repo };
        }
        case 'pullRequests': {
          const states = Array.isArray(args.states) ? (args.states as string[]) : [];
          let items = [...repo.pulls.values()];
          if (states.length > 0) items = items.filter((pull) => states.includes(pullState(pull)));
          items.sort((a, b) => b.number - a.number);
          return connection(items, args, (item) => ({ __pull: item as Pull, __repo: repo }));
        }
        default:
          break;
      }
      break;
    }
    case 'Issue': {
      const issue = value.__issue as Issue;
      const parentRepo = value.__repo as Repo;
      switch (field.name) {
        case 'id': return encodeId('issue', issue.id);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issueState(issue);
        case 'createdAt': return store.iso(issue.createdAt);
        case 'author': return { login: ownerLogin(store, parentRepo), id: encodeId('user', 1000) };
        case 'repository': return { __repo: parentRepo };
        case 'labels': return { __nodes: issue.labels.map((name) => ({ name })), __total: issue.labels.length };
        default:
          break;
      }
      break;
    }
    case 'PullRequest': {
      const pull = value.__pull as Pull;
      const parentRepo = value.__repo as Repo;
      switch (field.name) {
        case 'id': return encodeId('pull', pull.id);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': {
          const currentBase = parentRepo.refs.get(`refs/heads/${pull.baseRef}`);
          return pull.state === 'open' && currentBase === pull.baseSha ? 'MERGEABLE' : pull.merged ? 'UNKNOWN' : 'CONFLICTING';
        }
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRefOid': return pull.headSha;
        case 'baseRefOid': return pull.baseSha;
        case 'createdAt': return store.iso(pull.createdAt);
        case 'files': {
          const files = pullFiles(parentRepo, pull);
          // GraphQL names the field `path`; the REST view of the same change calls it `filename`.
          return connection(files, args, (item) => {
            const file = item as { filename: string; additions: number; deletions: number; changes: number };
            return { path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes };
          });
        }
        case 'mergeCommit': return pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha, __repo: parentRepo };
        default:
          break;
      }
      break;
    }
    case 'User': {
      if (field.name === 'login') return value.login;
      if (field.name === 'id') return value.id ?? encodeId('user', 1000);
      if (field.name === 'name') return value.login;
      break;
    }
    case 'Ref': {
      if (field.name === 'name') return value.name;
      if (field.name === 'target') {
        const oid = value.__oid as string | undefined;
        if (oid === undefined) return null;
        const parentRepo = value.__repo as Repo | undefined;
        const object = parentRepo?.objects.get(oid);
        const message = object === undefined || object.type !== 'commit' ? '' : object.data.toString('utf8').split('\n\n').slice(1).join('\n\n');
        return { oid, message, __repo: parentRepo };
      }
      break;
    }
    case 'Commit': {
      if (field.name === 'oid') return value.oid;
      if (field.name === 'message') return value.message;
      break;
    }
    case 'Connection':
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection': {
      if (field.name === 'totalCount') return value.__total ?? 0;
      if (field.name === 'nodes') return value.__nodes ?? [];
      if (field.name === 'edges') {
        const nodes = (value.__nodes ?? []) as unknown[];
        return nodes.map((node, index) => ({ cursor: `cursor:${index}`, node }));
      }
      if (field.name === 'pageInfo') {
        return {
          hasNextPage: value.__hasNext === true,
          hasPreviousPage: false,
          endCursor: value.__endCursor ?? null,
          startCursor: null,
        };
      }
      break;
    }
    default:
      break;
  }

  // A node object the selection walks into without a dedicated type name.
  const key = field.name;
  if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, locations: [], path: [field.name] });
  return undefined;
}

function typeNameOf(value: unknown): string {
  if (value === null || typeof value !== 'object') return 'Scalar';
  const bag = value as Bag;
  // Order matters: a Ref and a Commit both carry __repo, and an Issue carries it too, so the most
  // specific marker wins.
  if (bag.__issue !== undefined) return 'Issue';
  if (bag.__pull !== undefined) return 'PullRequest';
  if (bag.__nodes !== undefined) return 'Connection';
  if (bag.__oid !== undefined) return 'Ref';
  if (bag.oid !== undefined) return 'Commit';
  if (bag.__repo !== undefined) return 'Repository';
  if (bag.login !== undefined) return 'User';
  return 'Object';
}

function complete(ctx: Context, selection: SelectionSet | null, value: unknown, typeName: string): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => complete(ctx, selection, item, typeNameOf(item)));
  if (selection === null) return value;
  if (typeof value !== 'object') return value;
  const bag = value as Bag;
  const effectiveType = typeName === 'Connection' ? typeNameOf(value) : typeName;
  const out: Bag = {};
  const fields = [...selection.fields];
  for (const spread of selection.spreads) {
    if (spread.selection !== null) fields.push(...spread.selection.fields);
    else {
      const fragment = ctx.fragments.get(spread.name);
      if (fragment !== undefined) fields.push(...fragment.fields);
    }
  }
  for (const field of fields) {
    if (!shouldInclude(field, ctx.variables)) continue;
    const key = field.alias ?? field.name;
    const raw = resolveField(ctx, effectiveType, bag, field);
    if (raw === undefined) continue;
    out[key] = complete(ctx, field.selection, raw, typeNameOf(raw));
  }
  return out;
}

export interface GraphQLReply {
  readonly status: number;
  readonly body: unknown;
}

function executeOne(store: Store, body: Bag): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Bag;
  const errors: Array<Record<string, unknown>> = [];
  if (query.trim() === '') return { errors: [{ message: 'No query string was present' }] };
  let parsed: { operations: Operation[]; fragments: Map<string, SelectionSet> };
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    operationName === null
      ? parsed.operations[0]
      : parsed.operations.find((candidate) => candidate.name === operationName) ?? parsed.operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };

  const ctx: Context = { store, variables, fragments: parsed.fragments, errors };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: Bag = {};

  // Introspection is answered directly, because the suite asks for named types only.
  const data: Bag = {};
  const fields = operation.selection.fields;
  for (const field of fields) {
    if (!shouldInclude(field, variables)) continue;
    const key = field.alias ?? field.name;
    if (field.name === '__type') {
      const name = field.args.name === undefined ? '' : String(resolveValue(field.args.name, variables));
      const meta = introspectType(name);
      data[key] = meta === null ? null : complete(ctx, field.selection, meta as unknown as Bag, '__Type');
      continue;
    }
    if (field.name === '__schema') {
      data[key] = complete(
        ctx,
        field.selection,
        { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: Object.keys(FIELD_TYPES).map((type) => introspectType(type)) },
        '__Schema',
      );
      continue;
    }
    if (field.name === '__typename') {
      data[key] = rootType;
      continue;
    }
    const raw = resolveField(ctx, rootType, root, field);
    if (raw === undefined) continue;
    data[key] = complete(ctx, field.selection, raw, typeNameOf(raw));
  }

  const result: Bag = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphQL(store: Store, bodyText: string): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((item) => executeOne(store, (typeof item === 'object' && item !== null ? item : {}) as Bag));
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { message: 'Problems parsing JSON' } };
  }
  return { status: 200, body: executeOne(store, parsed as Bag) };
}

export { issueJson, commitChain };
