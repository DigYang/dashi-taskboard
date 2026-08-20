import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_VERSION = 1;

export class LinearConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LinearConfigError";
    this.code = code;
  }
}

function validateApiKey(apiKey) {
  if (typeof apiKey !== "string" || !apiKey || apiKey.length > 4096) {
    throw new LinearConfigError(
      "INVALID_LINEAR_API_KEY",
      "Linear API Key 不能为空且不能超过 4096 个字符",
    );
  }
  return apiKey;
}

function validateFilters(value, field, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new LinearConfigError(`INVALID_LINEAR_${field.toUpperCase()}`, `${label}必须是最多 20 项的数组`);
  }
  const filters = value.map((item) => {
    if (
      typeof item !== "string"
      || !item.trim()
      || item.length > 128
      || /[\u0000-\u001f\u007f]/.test(item)
    ) {
      throw new LinearConfigError(
        `INVALID_LINEAR_${field.toUpperCase()}`,
        `${label}不能为空、不能包含控制字符，且不能超过 128 个字符`,
      );
    }
    return item.trim();
  });
  return [...new Set(filters)];
}

function parseConfig(value) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== CONFIG_VERSION
  ) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置文件无效");
  }
  const allowedKeys = new Set([
    "version",
    "apiKey",
    "organizationId",
    "organizationName",
    "displayName",
    "teams",
    "projects",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置文件包含未知字段");
  }
  if (typeof value.organizationId !== "string" || !value.organizationId.trim()) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置缺少稳定工作区身份");
  }
  if (typeof value.organizationName !== "string" || !value.organizationName.trim()) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置缺少工作区名称");
  }
  if (typeof value.displayName !== "string" || !value.displayName.trim()) {
    throw new LinearConfigError("INVALID_LINEAR_CONFIG", "Linear 配置缺少用户显示名称");
  }
  return {
    version: CONFIG_VERSION,
    apiKey: validateApiKey(value.apiKey),
    organizationId: value.organizationId.trim().slice(0, 128),
    organizationName: value.organizationName.trim().slice(0, 254),
    displayName: value.displayName.trim().slice(0, 254),
    teams: validateFilters(value.teams, "teams", "Linear Team 筛选"),
    projects: validateFilters(value.projects, "projects", "Linear Project 筛选"),
  };
}

export function createLinearConfigStore({ configPath }) {
  if (!configPath) throw new Error("configPath is required");
  let pendingWrite = Promise.resolve();

  async function readFromDisk() {
    try {
      return parseConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async function writeAtomically(config) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  }

  return {
    async read() {
      await pendingWrite;
      return readFromDisk();
    },
    async save(input) {
      const config = parseConfig({ ...input, version: CONFIG_VERSION });
      const operation = pendingWrite.catch(() => {}).then(async () => {
        await writeAtomically(config);
        return config;
      });
      pendingWrite = operation.catch(() => {});
      return operation;
    },
    async clear() {
      await pendingWrite;
      try {
        await unlink(configPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    },
    validate({ apiKey, teams, projects }) {
      return {
        apiKey: validateApiKey(apiKey),
        teams: validateFilters(teams, "teams", "Linear Team 筛选"),
        projects: validateFilters(projects, "projects", "Linear Project 筛选"),
      };
    },
  };
}
