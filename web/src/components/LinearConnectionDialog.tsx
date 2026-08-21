import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { CodeProjectBinding, LinearConnection, LinearRoutingRule } from "../types";

type CodeProjectOption = {
  id: string;
  name: string;
  projectKind?: "local" | "remote";
  hostId?: string;
  workspacePath?: string;
};

interface LinearConnectionDialogProps {
  connection: LinearConnection | null;
  saving: boolean;
  error: string | null;
  codeProjects: CodeProjectOption[];
  onClose: () => void;
  onSave: (input: {
    apiKey: string;
    teams: string[];
    projects: string[];
    routes: LinearRoutingRule[];
  }) => Promise<void>;
}

function filtersFromText(value: string) {
  return value
    .split(/[,，\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function LinearConnectionDialog({
  connection,
  saving,
  error,
  codeProjects,
  onClose,
  onSave,
}: LinearConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [apiKey, setApiKey] = useState("");
  const [teamsText, setTeamsText] = useState(connection?.teams.join(", ") ?? "");
  const [projectsText, setProjectsText] = useState(connection?.projects.join(", ") ?? "");
  const [routes, setRoutes] = useState<LinearRoutingRule[]>(connection?.routes ?? []);
  const [matchType, setMatchType] = useState<LinearRoutingRule["matchType"]>("project");
  const [matchId, setMatchId] = useState("");
  const [targetProjectId, setTargetProjectId] = useState("");

  useEffect(() => {
    setApiKey("");
    setTeamsText(connection?.teams.join(", ") ?? "");
    setProjectsText(connection?.projects.join(", ") ?? "");
    setRoutes(connection?.routes ?? []);
  }, [connection]);

  const catalog = matchType === "project"
    ? connection?.availableProjects ?? []
    : matchType === "team"
      ? connection?.availableTeams ?? []
      : matchType === "label"
        ? connection?.availableLabels ?? []
        : [];

  function addRoute() {
    const project = codeProjects.find((candidate) => candidate.id === targetProjectId);
    const match = matchType === "default" ? { id: null, name: text("默认", "Default") } : catalog.find((item) => item.id === matchId);
    if (!project?.workspacePath || !match) return;
    const target: CodeProjectBinding = {
      codexProjectId: project.id,
      codexProjectKind: project.projectKind ?? "local",
      codexHostId: project.hostId ?? "local",
      workspacePath: project.workspacePath,
      name: project.name,
    };
    setRoutes((current) => [
      ...current.filter((route) => !(route.matchType === matchType && route.matchId === match.id)),
      { matchType, matchId: match.id, matchName: match.name, target },
    ]);
    setMatchId("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      apiKey,
      teams: filtersFromText(teamsText),
      projects: filtersFromText(projectsText),
      routes,
    });
  }

  return (
    <div
      className="delete-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        className="delete-dialog project-create-dialog linear-connection-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="linear-connection-title"
        onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <h2 id="linear-connection-title">
          {connection?.configured
            ? text("Linear 设置", "Linear settings")
            : text("连接 Linear", "Connect Linear")}
        </h2>
        <label>
          <span>{text("Linear API Key", "Linear API key")}</span>
          <input
            autoFocus
            required={!connection?.configured}
            type="password"
            autoComplete="off"
            maxLength={4096}
            placeholder={connection?.configured ? text("留空则保持不变", "Leave blank to keep unchanged") : "lin_api_…"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <section className="linear-routing-settings">
          <h3>{text("代码项目自动路由", "Automatic code-project routing")}</h3>
          <p>{text("按顺序匹配 Linear Project、Team 或标签；没有命中时使用默认规则。", "Match Linear project, team, or label in order; the default rule is used when none match.")}</p>
          {routes.length > 0 && <div className="linear-routing-rules">
            {routes.map((route, index) => <div className="linear-routing-rule" key={`${route.matchType}:${route.matchId}`}>
              <span>{route.matchType === "default" ? text("默认", "Default") : `${route.matchType} · ${route.matchName}`}</span>
              <span>→ {route.target.name}</span>
              <button type="button" aria-label={text("删除规则", "Remove rule")} onClick={() => setRoutes((current) => current.filter((_, routeIndex) => routeIndex !== index))}>×</button>
            </div>)}
          </div>}
          <div className="linear-routing-builder">
            <select value={matchType} onChange={(event) => { setMatchType(event.target.value as LinearRoutingRule["matchType"]); setMatchId(""); }}>
              <option value="project">Linear Project</option>
              <option value="team">Linear Team</option>
              <option value="label">Linear Label</option>
              <option value="default">{text("默认规则", "Default rule")}</option>
            </select>
            {matchType !== "default" && <select value={matchId} onChange={(event) => setMatchId(event.target.value)}>
              <option value="">{text("选择匹配项", "Choose match")}</option>
              {catalog.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>}
            <select value={targetProjectId} onChange={(event) => setTargetProjectId(event.target.value)}>
              <option value="">{text("选择代码项目", "Choose code project")}</option>
              {codeProjects.filter((project) => project.workspacePath).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button className="button secondary" type="button" disabled={!targetProjectId || (matchType !== "default" && !matchId)} onClick={addRoute}>
              {text("添加规则", "Add rule")}
            </button>
          </div>
        </section>
        <label>
          <span>{text("Team（名称或 Key，可多选）", "Teams (name or key, multiple allowed)")}</span>
          <input
            maxLength={2600}
            placeholder="MOB, Product"
            value={teamsText}
            onChange={(event) => setTeamsText(event.target.value)}
          />
        </label>
        <label>
          <span>{text("Project（名称，可多选）", "Projects (name, multiple allowed)")}</span>
          <input
            maxLength={2600}
            placeholder={text("留空则同步所有 Project", "Leave blank to sync all projects")}
            value={projectsText}
            onChange={(event) => setProjectsText(event.target.value)}
          />
        </label>
        {connection?.configured && (
          <p>
            {text("当前账号：", "Current account: ")}
            {connection.displayName}
            {connection.organizationName ? ` · ${connection.organizationName}` : ""}
          </p>
        )}
        {error && <p className="project-dialog-error" role="alert">{error}</p>}
        <div>
          <button className="button secondary" type="button" disabled={saving} onClick={onClose}>
            {text("取消", "Cancel")}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || (!apiKey && !connection?.configured)}
          >
            {saving
              ? text("连接中…", "Connecting…")
              : connection?.configured
                ? text("保存并同步", "Save and sync")
                : text("连接并同步", "Connect and sync")}
          </button>
        </div>
      </form>
    </div>
  );
}
