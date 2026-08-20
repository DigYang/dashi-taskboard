import { useEffect, useState, type FormEvent } from "react";

import { useTaskboardI18n } from "../i18n";
import type { LinearConnection } from "../types";

interface LinearConnectionDialogProps {
  connection: LinearConnection | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: {
    apiKey: string;
    teams: string[];
    projects: string[];
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
  onClose,
  onSave,
}: LinearConnectionDialogProps) {
  const { text } = useTaskboardI18n();
  const [apiKey, setApiKey] = useState("");
  const [teamsText, setTeamsText] = useState(connection?.teams.join(", ") ?? "");
  const [projectsText, setProjectsText] = useState(connection?.projects.join(", ") ?? "");

  useEffect(() => {
    setApiKey("");
    setTeamsText(connection?.teams.join(", ") ?? "");
    setProjectsText(connection?.projects.join(", ") ?? "");
  }, [connection]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave({
      apiKey,
      teams: filtersFromText(teamsText),
      projects: filtersFromText(projectsText),
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
