import { LINEAR_PROJECT_ID } from "../shared/domain.mjs";
import { ApiError } from "./database.mjs";

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const SYNC_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LINEAR_IMAGE_BODY_LIMIT = 25 * 1024 * 1024;
const LINEAR_IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const METADATA_QUERY = `
  query TaskboardLinearMetadata {
    organization { id name }
    viewer { id name email avatarUrl }
    teams(first: 250) { nodes { id key name } }
    projects(first: 250) { nodes { id name } }
    workflowStates(first: 250) { nodes { id name type team { id } } }
    issueLabels(first: 250) { nodes { id name team { id } } }
  }
`;

const TEAM_MEMBERS_QUERY = `
  query TaskboardLinearTeamMembers($id: String!) {
    team(id: $id) {
      members(first: 250) { nodes { id name email avatarUrl } }
    }
  }
`;

const ISSUES_QUERY = `
  query TaskboardAssignedIssues($after: String, $filter: IssueFilter) {
    viewer {
      assignedIssues(first: 100, after: $after, orderBy: updatedAt, filter: $filter) {
        nodes {
          id identifier title description priority estimate dueDate url createdAt updatedAt
          state { id name type }
          team { id key name }
          project { id name }
          parent {
            id identifier title url priority
            state { id name type }
            assignee { id name email avatarUrl }
          }
          labels(first: 100) { nodes { id name } }
          assignee { id name email avatarUrl }
          creator { id name email avatarUrl }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const ISSUE_DETAIL_QUERY = `
  query TaskboardLinearIssueDetail($id: String!) {
    issue(id: $id) {
      id identifier title description priority estimate dueDate url createdAt updatedAt
      state { id name type }
      team { id key name }
      project { id name }
      parent {
        id identifier title url priority
        state { id name type }
        assignee { id name email avatarUrl }
      }
      children(first: 100) {
        nodes {
          id identifier title url priority
          state { id name type }
          assignee { id name email avatarUrl }
        }
      }
      labels(first: 100) { nodes { id name } }
      assignee { id name email avatarUrl }
      creator { id name email avatarUrl }
    }
  }
`;

const ISSUE_COMMENTS_QUERY = `
  query TaskboardLinearIssueComments($id: String!) {
    issue(id: $id) {
      id
      comments(first: 250) {
        nodes {
          id body createdAt updatedAt
          user { id name email avatarUrl }
        }
      }
    }
  }
`;

const UPDATE_ISSUE_MUTATION = `
  mutation TaskboardUpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id updatedAt } }
  }
`;

const CREATE_ISSUE_MUTATION = `
  mutation TaskboardCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id identifier title description priority estimate dueDate url createdAt updatedAt
        state { id name type }
        team { id key name }
        project { id name }
        labels(first: 100) { nodes { id name } }
        assignee { id name email avatarUrl }
        creator { id name email avatarUrl }
      }
    }
  }
`;

const CREATE_COMMENT_MUTATION = `
  mutation TaskboardCreateLinearComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id body createdAt updatedAt
        user { id name email avatarUrl }
      }
    }
  }
`;

function includesAny(value, terms) {
  const normalized = String(value ?? "").toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function limitedString(value, fallback, maxLength) {
  const result = String(value ?? fallback).trim();
  return (result || fallback).slice(0, maxLength);
}

export function taskStatusFromLinear(state) {
  const name = state?.name ?? "";
  if (state?.type === "canceled") return "canceled";
  if (state?.type === "completed") return "done";
  if (state?.type === "backlog") return "backlog";
  if (state?.type === "unstarted") return "todo";
  if (includesAny(name, ["verify", "test", "qa", "验收", "测试"])) return "in_test";
  if (includesAny(name, ["review", "评审"])) {
    return "in_review";
  }
  if (includesAny(name, ["block", "hold", "阻塞", "挂起"])) return "blocked";
  return "in_progress";
}

export function taskPriorityFromLinear(priority) {
  if (priority === 1) return "urgent";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  if (priority === 4) return "low";
  return "none";
}

function linearPriorityFromTask(priority) {
  return { none: 0, urgent: 1, high: 2, medium: 3, low: 4 }[priority];
}

function actorFromLinear(user, fallback) {
  const id = limitedString(user?.id ?? user?.email, fallback, 240);
  return {
    type: "user",
    id: `linear:${id}`,
    name: limitedString(user?.name ?? user?.email, fallback, 120),
    avatarUrl: typeof user?.avatarUrl === "string" ? user.avatarUrl : null,
  };
}

function normalizeIssue(issue, config, index = 0) {
  const externalId = String(issue.id);
  const externalKey = limitedString(issue.identifier, "LINEAR", 128);
  const internalId = `LINEAR:${config.organizationId.toUpperCase()}:${externalId}`;
  const assignee = actorFromLinear(issue.assignee, config.displayName);
  const creator = actorFromLinear(issue.creator, config.displayName);
  const parent = issue.parent?.id
    ? {
        id: `LINEAR:${config.organizationId.toUpperCase()}:${issue.parent.id}`,
        identifier: `LINEAR:${config.organizationId.toUpperCase()}:${issue.parent.id}`,
        externalKey: limitedString(issue.parent.identifier, "LINEAR", 128),
        projectId: LINEAR_PROJECT_ID,
        title: limitedString(issue.parent.title, issue.parent.identifier, 240),
        status: taskStatusFromLinear(issue.parent.state),
        priority: taskPriorityFromLinear(issue.parent.priority),
        assignee: actorFromLinear(issue.parent.assignee, "Linear user"),
        archivedAt: null,
        externalUrl: typeof issue.parent.url === "string" ? issue.parent.url : null,
        externalOnly: true,
      }
    : null;
  const labels = Array.isArray(issue?.labels?.nodes)
    ? [...new Set(issue.labels.nodes.flatMap((label) => {
      if (typeof label?.name !== "string") return [];
      const normalized = label.name.trim().slice(0, 64);
      return normalized ? [normalized] : [];
    }))].slice(0, 20)
    : [];
  return {
    id: internalId,
    identifier: internalId,
    title: limitedString(issue.title, externalKey, 240),
    description: typeof issue.description === "string" ? issue.description.slice(0, 100_000) : "",
    status: taskStatusFromLinear(issue.state),
    priority: taskPriorityFromLinear(issue.priority),
    estimate: typeof issue.estimate === "number" && Number.isFinite(issue.estimate)
      ? issue.estimate
      : null,
    labels,
    sortOrder: (index + 1) * 1024,
    creator,
    assignee,
    dueDate: typeof issue.dueDate === "string" ? issue.dueDate : null,
    externalOrigin: config.organizationId,
    externalId,
    externalKey,
    externalUrl: typeof issue.url === "string" ? issue.url : null,
    parent,
    createdAt: typeof issue.createdAt === "string" ? issue.createdAt : new Date().toISOString(),
    updatedAt: typeof issue.updatedAt === "string" ? issue.updatedAt : new Date().toISOString(),
  };
}

function externalRelationSummary(issue, config) {
  return {
    id: `LINEAR:${config.organizationId.toUpperCase()}:${issue.id}`,
    identifier: `LINEAR:${config.organizationId.toUpperCase()}:${issue.id}`,
    externalKey: limitedString(issue.identifier, "LINEAR", 128),
    projectId: LINEAR_PROJECT_ID,
    title: limitedString(issue.title, issue.identifier, 240),
    status: taskStatusFromLinear(issue.state),
    priority: taskPriorityFromLinear(issue.priority),
    assignee: actorFromLinear(issue.assignee, "Linear user"),
    archivedAt: null,
    externalUrl: typeof issue.url === "string" ? issue.url : null,
    externalOnly: true,
  };
}

function relationSummaryFromTask(task) {
  return {
    id: task.id,
    identifier: task.identifier,
    externalKey: task.externalKey ?? null,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    assignee: task.assignee,
    archivedAt: task.archivedAt,
    externalUrl: task.externalUrl,
  };
}

function normalizeIssueDetail(issue, config) {
  const normalized = normalizeIssue(issue, config);
  const children = Array.isArray(issue?.children?.nodes) ? issue.children.nodes : [];
  return {
    ...normalized,
    projectId: LINEAR_PROJECT_ID,
    threadId: null,
    threadBinding: null,
    legacyLocalThreadId: null,
    conversationRefs: [],
    participants: [],
    previewImage: null,
    activityKey: `linear:${normalized.externalId}:${normalized.updatedAt}`,
    activityUpdatedAt: normalized.updatedAt,
    creatorType: normalized.creator.type,
    creatorId: normalized.creator.id,
    creatorName: normalized.creator.name,
    creatorAvatarUrl: normalized.creator.avatarUrl,
    workflowId: null,
    developmentContext: null,
    startDate: null,
    recurrence: null,
    source: "linear",
    archivedAt: null,
    readOnly: false,
    externalOnly: true,
    relations: {
      parent: normalized.parent,
      subIssues: children.map((child) => externalRelationSummary(child, config)),
      blockedBy: [],
      blocks: [],
      related: [],
    },
    version: 1,
  };
}

function safeConfig(config, lastSyncedAt = null, members = []) {
  return config
    ? {
      configured: true,
      displayName: config.displayName,
      organizationName: config.organizationName,
      teams: config.teams,
      projects: config.projects,
      members,
      projectId: LINEAR_PROJECT_ID,
      lastSyncedAt,
    }
    : {
      configured: false,
      displayName: null,
      organizationName: null,
      teams: [],
      projects: [],
      members: [],
      projectId: LINEAR_PROJECT_ID,
      lastSyncedAt: null,
    };
}

function resolveFilterIds(filters, candidates, fields, label) {
  return filters.map((filter) => {
    const normalized = filter.toLowerCase();
    const match = candidates.find((candidate) => fields.some((field) => (
      String(candidate?.[field] ?? "").toLowerCase() === normalized
    )));
    if (!match) {
      throw new ApiError(400, `LINEAR_${label.toUpperCase()}_NOT_FOUND`, `Linear 中找不到${label}“${filter}”`);
    }
    return match.id;
  });
}

export function createLinearIntegration({ configStore, database, fetch: fetchImplementation = globalThis.fetch }) {
  let lastSyncedAt = null;
  let pendingSync = null;
  let workflowStates = [];
  let labelCatalog = [];
  let memberCatalog = [];
  const issueTeams = new Map();

  async function request(config, query, variables = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(LINEAR_GRAPHQL_URL, {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          authorization: config.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "LINEAR_TIMEOUT" : "LINEAR_UNAVAILABLE",
        timedOut ? "连接 Linear 超时" : "无法连接 Linear，请检查网络连接",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(401, "LINEAR_AUTH_FAILED", "Linear API Key 无效或缺少访问权限");
    }
    if (!response.ok) {
      throw new ApiError(
        response.status >= 500 ? 502 : 409,
        "LINEAR_REQUEST_FAILED",
        `Linear 请求失败（HTTP ${response.status}）`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(502, "INVALID_LINEAR_RESPONSE", "Linear 返回了无效的 JSON 数据");
    }
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      const message = limitedString(payload.errors[0]?.message, "Linear GraphQL 请求失败", 500);
      throw new ApiError(409, "LINEAR_GRAPHQL_ERROR", message);
    }
    return payload?.data;
  }

  async function fetchImage(config, value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new ApiError(400, "INVALID_LINEAR_IMAGE_URL", "Linear 图片地址无效");
    }
    const organizationPath = url.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    if (
      url.protocol !== "https:"
      || url.hostname !== "uploads.linear.app"
      || url.port !== ""
      || url.username !== ""
      || url.password !== ""
      || organizationPath !== config.organizationId.toLowerCase()
    ) {
      throw new ApiError(400, "INVALID_LINEAR_IMAGE_URL", "仅支持当前 Linear 工作区的图片地址");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let response;
    try {
      response = await fetchImplementation(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif",
          authorization: config.apiKey,
        },
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      throw new ApiError(
        502,
        timedOut ? "LINEAR_IMAGE_TIMEOUT" : "LINEAR_IMAGE_UNAVAILABLE",
        timedOut ? "加载 Linear 图片超时" : "无法加载 Linear 图片",
      );
    } finally {
      clearTimeout(timeout);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(401, "LINEAR_AUTH_FAILED", "Linear API Key 无效或缺少图片访问权限");
    }
    if (!response.ok) {
      throw new ApiError(
        response.status === 404 ? 404 : 502,
        response.status === 404 ? "LINEAR_IMAGE_NOT_FOUND" : "LINEAR_IMAGE_REQUEST_FAILED",
        response.status === 404 ? "Linear 图片不存在" : `Linear 图片请求失败（HTTP ${response.status}）`,
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !LINEAR_IMAGE_CONTENT_TYPES.has(contentType)) {
      throw new ApiError(502, "INVALID_LINEAR_IMAGE", "Linear 返回了不支持的图片格式");
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > LINEAR_IMAGE_BODY_LIMIT) {
      throw new ApiError(413, "LINEAR_IMAGE_TOO_LARGE", "Linear 图片不能超过 25 MB");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > LINEAR_IMAGE_BODY_LIMIT) {
      throw new ApiError(413, "LINEAR_IMAGE_TOO_LARGE", "Linear 图片不能超过 25 MB");
    }
    return { body, contentType };
  }

  async function fetchMetadata(config) {
    const data = await request(config, METADATA_QUERY);
    if (!data?.organization?.id || !data?.viewer?.id) {
      throw new ApiError(502, "INVALID_LINEAR_RESPONSE", "Linear 未返回工作区或当前用户身份");
    }
    workflowStates = Array.isArray(data?.workflowStates?.nodes) ? data.workflowStates.nodes : [];
    labelCatalog = Array.isArray(data?.issueLabels?.nodes) ? data.issueLabels.nodes : [];
    const teams = Array.isArray(data?.teams?.nodes) ? data.teams.nodes : [];
    const teamIds = resolveFilterIds(config.teams, teams, ["id", "key", "name"], "Team");
    const memberResults = await Promise.all(teamIds.map((id) => request(config, TEAM_MEMBERS_QUERY, { id })));
    memberCatalog = memberResults
      .flatMap((result) => Array.isArray(result?.team?.members?.nodes) ? result.team.members.nodes : [])
      .filter((member, index, members) => (
        member?.id && members.findIndex((candidate) => candidate?.id === member.id) === index
      ));
    return {
      organization: data.organization,
      viewer: data.viewer,
      teams,
      projects: Array.isArray(data?.projects?.nodes) ? data.projects.nodes : [],
    };
  }

  async function fetchAssignedIssues(config, metadata, updatedSince = null) {
    const teamIds = resolveFilterIds(config.teams, metadata.teams, ["id", "key", "name"], "Team");
    const projectIds = resolveFilterIds(config.projects, metadata.projects, ["id", "name"], "Project");
    const relationFilters = {
      ...(teamIds.length > 0 ? { team: { id: { in: teamIds } } } : {}),
      ...(projectIds.length > 0 ? { project: { id: { in: projectIds } } } : {}),
      ...(updatedSince ? { updatedAt: { gte: updatedSince } } : {}),
    };
    const filter = Object.keys(relationFilters).length > 0 ? relationFilters : null;
    const issues = [];
    let after = null;
    while (true) {
      const data = await request(config, ISSUES_QUERY, { after, filter });
      const connection = data?.viewer?.assignedIssues;
      const pageIssues = Array.isArray(connection?.nodes) ? connection.nodes : [];
      issues.push(...pageIssues);
      const pageInfo = connection?.pageInfo;
      if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
      after = pageInfo.endCursor;
    }
    issueTeams.clear();
    for (const issue of issues) {
      if (issue?.identifier && issue?.team?.id) issueTeams.set(issue.identifier, issue.team.id);
    }
    return issues;
  }

  async function validateConnection(candidate) {
    const metadata = await fetchMetadata(candidate);
    const config = {
      ...candidate,
      organizationId: String(metadata.organization.id),
      organizationName: limitedString(metadata.organization.name, "Linear", 254),
      displayName: limitedString(metadata.viewer.name ?? metadata.viewer.email, "Linear user", 254),
    };
    const issues = await fetchAssignedIssues(config, metadata);
    return { config, issues };
  }

  async function syncWithConfig(config, { full = false } = {}) {
    const syncStartedAt = new Date().toISOString();
    const metadata = await fetchMetadata(config);
    if (String(metadata.organization.id) !== config.organizationId) {
      throw new ApiError(409, "LINEAR_ORIGIN_MISMATCH", "当前 API Key 属于另一个 Linear 工作区，请重新连接");
    }
    const issues = await fetchAssignedIssues(config, metadata, full ? null : lastSyncedAt);
    database.syncLinearTasks(
      issues.map((issue, index) => normalizeIssue(issue, config, index)),
      {
        archiveMissing: false,
        projectName: `Linear · ${config.organizationName}`,
        projectLabels: labelCatalog.map((label) => label.name),
      },
    );
    lastSyncedAt = syncStartedAt;
    return safeConfig(config, lastSyncedAt, memberCatalog.map((member) => actorFromLinear(member, "Linear user")));
  }

  async function sync({ force = false } = {}) {
    const config = await configStore.read();
    if (!config) return safeConfig(null);
    if (!force && lastSyncedAt && Date.now() - new Date(lastSyncedAt).getTime() < SYNC_INTERVAL_MS) {
      return safeConfig(config, lastSyncedAt, memberCatalog.map((member) => actorFromLinear(member, "Linear user")));
    }
    if (pendingSync) return pendingSync;
    pendingSync = syncWithConfig(config, { full: force }).finally(() => {
      pendingSync = null;
    });
    return pendingSync;
  }

  async function taskTeamId(config, task) {
    if (!issueTeams.has(task.externalKey)) await syncWithConfig(config, { full: true });
    const teamId = issueTeams.get(task.externalKey);
    if (!teamId) {
      throw new ApiError(409, "LINEAR_ISSUE_NOT_FOUND", "Linear 中找不到此任务，请重新同步");
    }
    return teamId;
  }

  function resolveState(teamId, targetStatus) {
    const matches = workflowStates.filter((state) => (
      state?.team?.id === teamId
      && (targetStatus === "in_progress"
        ? state?.name === "In Progress"
        : taskStatusFromLinear(state) === targetStatus)
    ));
    if (matches.length === 0) {
      throw new ApiError(409, "LINEAR_STATE_UNAVAILABLE", "Linear 当前工作流没有对应的目标状态");
    }
    if (matches.length > 1) {
      throw new ApiError(
        409,
        "LINEAR_STATE_AMBIGUOUS",
        "Linear 有多个状态可映射到目标状态，请在 Linear 中调整工作流后重试",
        { availableStates: matches.map((state) => ({ id: state.id, name: state.name })) },
      );
    }
    return matches[0].id;
  }

  function resolveLabelIds(teamId, labels) {
    return labels.map((name) => {
      const normalized = name.toLowerCase();
      const match = labelCatalog.find((label) => (
        label?.team?.id === teamId && String(label.name).toLowerCase() === normalized
      )) ?? labelCatalog.find((label) => (
        label?.team == null && String(label.name).toLowerCase() === normalized
      ));
      if (!match) {
        throw new ApiError(409, "LINEAR_LABEL_UNAVAILABLE", `Linear 中找不到标签“${name}”`);
      }
      return match.id;
    });
  }

  function resolveMemberId(assigneeId) {
    const linearId = typeof assigneeId === "string" && assigneeId.startsWith("linear:")
      ? assigneeId.slice("linear:".length)
      : "";
    const member = memberCatalog.find((candidate) => candidate?.id === linearId);
    if (!member) {
      throw new ApiError(409, "LINEAR_ASSIGNEE_UNAVAILABLE", "所选负责人不属于当前 Linear Team");
    }
    return member.id;
  }

  return {
    async status() {
      const config = await configStore.read();
      if (!config) return safeConfig(null);
      if (memberCatalog.length === 0) await fetchMetadata(config);
      return safeConfig(config, lastSyncedAt, memberCatalog.map((member) => actorFromLinear(member, "Linear user")));
    },
    async configure(input) {
      const current = await configStore.read();
      const apiKey = input.apiKey || current?.apiKey;
      if (!apiKey) {
        throw new ApiError(400, "LINEAR_API_KEY_REQUIRED", "首次连接 Linear 时必须输入 API Key");
      }
      const candidate = configStore.validate({ ...input, apiKey });
      const { config, issues } = await validateConnection(candidate);
      database.syncLinearTasks(
        issues.map((issue, index) => normalizeIssue(issue, config, index)),
        {
          archiveMissing: false,
          projectName: `Linear · ${config.organizationName}`,
          projectLabels: labelCatalog.map((label) => label.name),
        },
      );
      const savedConfig = await configStore.save(config);
      lastSyncedAt = new Date().toISOString();
      return safeConfig(savedConfig, lastSyncedAt, memberCatalog.map((member) => actorFromLinear(member, "Linear user")));
    },
    sync,
    async reconcile() {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      return syncWithConfig(config, { full: true });
    },
    async getIssueDetail(id) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      const externalId = String(id).startsWith(`LINEAR:${config.organizationId.toUpperCase()}:`)
        ? String(id).slice(`LINEAR:${config.organizationId.toUpperCase()}:`.length)
        : String(id);
      const data = await request(config, ISSUE_DETAIL_QUERY, { id: externalId });
      if (!data?.issue?.id) {
        throw new ApiError(404, "LINEAR_ISSUE_NOT_FOUND", "Linear 中找不到此议题");
      }
      const detail = normalizeIssueDetail(data.issue, config);
      if (data.issue.identifier && data.issue.team?.id) issueTeams.set(data.issue.identifier, data.issue.team.id);
      const localTask = database.getTask(detail.id);
      if (localTask) {
        detail.developmentContext = localTask.developmentContext;
        detail.locallyTracked = true;
        detail.version = localTask.version;
      }
      if (detail.relations.parent) {
        const localParent = database.getTask(detail.relations.parent.id);
        if (localParent) detail.relations.parent = relationSummaryFromTask(localParent);
      }
      detail.relations.subIssues = detail.relations.subIssues.map((child) => {
        const localChild = database.getTask(child.id);
        return localChild ? relationSummaryFromTask(localChild) : child;
      });
      return detail;
    },
    async listComments(id) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      const externalId = String(id).startsWith(`LINEAR:${config.organizationId.toUpperCase()}:`)
        ? String(id).slice(`LINEAR:${config.organizationId.toUpperCase()}:`.length)
        : String(id);
      const data = await request(config, ISSUE_COMMENTS_QUERY, { id: externalId });
      if (!data?.issue?.id) throw new ApiError(404, "LINEAR_ISSUE_NOT_FOUND", "Linear 中找不到此议题");
      const nodes = Array.isArray(data.issue.comments?.nodes) ? data.issue.comments.nodes : [];
      return nodes.map((comment) => ({
        id: `LINEAR_COMMENT:${comment.id}`,
        taskId: id,
        body: typeof comment.body === "string" ? comment.body : "",
        authorType: "user",
        authorId: actorFromLinear(comment.user, "Linear user").id,
        authorName: actorFromLinear(comment.user, "Linear user").name,
        authorAvatarUrl: actorFromLinear(comment.user, "Linear user").avatarUrl,
        threadId: null,
        threadBinding: null,
        legacyLocalThreadId: null,
        attachments: [],
        version: 1,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      }));
    },
    async createComment(id, body) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      const externalId = String(id).startsWith(`LINEAR:${config.organizationId.toUpperCase()}:`)
        ? String(id).slice(`LINEAR:${config.organizationId.toUpperCase()}:`.length)
        : String(id);
      const data = await request(config, CREATE_COMMENT_MUTATION, {
        input: { issueId: externalId, body },
      });
      const comment = data?.commentCreate?.comment;
      if (data?.commentCreate?.success !== true || !comment?.id) {
        throw new ApiError(409, "LINEAR_COMMENT_FAILED", "Linear 未确认评论发布成功");
      }
      const author = actorFromLinear(comment.user, config.displayName);
      return {
        id: `LINEAR_COMMENT:${comment.id}`,
        taskId: id,
        body: typeof comment.body === "string" ? comment.body : body,
        authorType: author.type,
        authorId: author.id,
        authorName: author.name,
        authorAvatarUrl: author.avatarUrl,
        threadId: null,
        threadBinding: null,
        legacyLocalThreadId: null,
        attachments: [],
        version: 1,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      };
    },
    async getImage(url) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      return fetchImage(config, url);
    },
    async createTask(input) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      const metadata = await fetchMetadata(config);
      const teamIds = resolveFilterIds(config.teams, metadata.teams, ["id", "key", "name"], "Team");
      if (teamIds.length !== 1) {
        throw new ApiError(409, "LINEAR_CREATE_TEAM_REQUIRED", "创建 Linear Issue 时必须只配置一个 Team");
      }
      const projectIds = resolveFilterIds(config.projects, metadata.projects, ["id", "name"], "Project");
      if (projectIds.length > 1) {
        throw new ApiError(409, "LINEAR_CREATE_PROJECT_AMBIGUOUS", "创建 Linear Issue 时最多只能配置一个 Project");
      }
      const teamId = teamIds[0];
      const createInput = {
        teamId,
        assigneeId: input.assigneeId ? resolveMemberId(input.assigneeId) : metadata.viewer.id,
        title: input.title,
        description: input.description,
        priority: linearPriorityFromTask(input.priority),
        stateId: resolveState(teamId, input.status),
        ...(input.labels.length > 0 ? { labelIds: resolveLabelIds(teamId, input.labels) } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(projectIds.length === 1 ? { projectId: projectIds[0] } : {}),
      };
      const data = await request(config, CREATE_ISSUE_MUTATION, { input: createInput });
      if (data?.issueCreate?.success !== true || !data.issueCreate.issue?.id) {
        throw new ApiError(409, "LINEAR_CREATE_FAILED", "Linear 未确认 Issue 创建成功");
      }
      const issue = data.issueCreate.issue;
      if (issue.identifier && issue.team?.id) issueTeams.set(issue.identifier, issue.team.id);
      const normalized = {
        ...normalizeIssue(issue, config),
        developmentContext: input.developmentContext ?? null,
      };
      database.syncLinearTasks([normalized], {
        archiveMissing: false,
        projectName: `Linear · ${config.organizationName}`,
        projectLabels: labelCatalog.map((label) => label.name),
      });
      lastSyncedAt = new Date().toISOString();
      return database.getTask(normalized.id);
    },
    async updateTask(task, changes) {
      const config = await configStore.read();
      if (!config) throw new ApiError(409, "LINEAR_NOT_CONFIGURED", "Linear 尚未配置");
      if (task.externalOrigin !== config.organizationId || !task.externalKey) {
        throw new ApiError(409, "LINEAR_ORIGIN_MISMATCH", "此任务不属于当前 Linear 连接，请重新同步");
      }
      const teamId = await taskTeamId(config, task);
      const input = {};
      if (Object.hasOwn(changes, "title") && changes.title !== task.title) input.title = changes.title;
      if (Object.hasOwn(changes, "description") && changes.description !== task.description) {
        input.description = changes.description;
      }
      if (Object.hasOwn(changes, "priority") && changes.priority !== task.priority) {
        input.priority = linearPriorityFromTask(changes.priority);
      }
      if (Object.hasOwn(changes, "estimate") && changes.estimate !== task.estimate) {
        input.estimate = changes.estimate;
      }
      if (Object.hasOwn(changes, "labels") && JSON.stringify(changes.labels) !== JSON.stringify(task.labels)) {
        input.labelIds = resolveLabelIds(teamId, changes.labels);
      }
      if (Object.hasOwn(changes, "dueDate") && changes.dueDate !== task.dueDate) {
        input.dueDate = changes.dueDate;
      }
      if (Object.hasOwn(changes, "status") && changes.status !== task.status) {
        input.stateId = resolveState(teamId, changes.status);
      }
      if (Object.hasOwn(changes, "parentId")) {
        input.parentId = changes.parentId;
      }
      if (Object.hasOwn(changes, "assigneeId")) {
        input.assigneeId = resolveMemberId(changes.assigneeId);
      }
      if (Object.keys(input).length === 0) return false;
      const data = await request(config, UPDATE_ISSUE_MUTATION, { id: task.externalKey, input });
      if (data?.issueUpdate?.success !== true) {
        throw new ApiError(409, "LINEAR_UPDATE_FAILED", "Linear 未确认任务更新");
      }
      return true;
    },
    async moveTask(task, status) {
      if (status === task.status) return false;
      return this.updateTask(task, { status });
    },
  };
}
