import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./database.mjs";

const execFileAsync = promisify(execFile);

function slug(value, fallback) {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

async function git(repositoryPath, args, options = {}) {
  return execFileAsync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    ...options,
  });
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function refExists(repositoryPath, ref) {
  try {
    await git(repositoryPath, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function createWorktreeManager({ dataDirectory }) {
  const worktreesDirectory = path.join(dataDirectory, "worktrees");

  return {
    async prepare(task) {
      const binding = task.codeProjectBinding;
      if (!binding || task.codeProjectMode === "none") {
        throw new ApiError(409, "CODE_PROJECT_REQUIRED", "请先为任务绑定代码项目");
      }
      if (binding.codexProjectKind !== "local") {
        throw new ApiError(409, "LOCAL_WORKTREE_REQUIRED", "SSH 项目暂不支持由本机自动创建 Worktree");
      }
      if (task.managedWorktree && task.developmentContext?.type === "worktree" && await exists(task.developmentContext.path)) {
        return {
          path: task.developmentContext.path,
          branch: task.developmentContext.branch,
          repositoryPath: task.managedWorktree.repositoryPath,
          baseRef: task.managedWorktree.baseRef,
        };
      }
      let repositoryPath;
      try {
        repositoryPath = (await git(binding.workspacePath, ["rev-parse", "--show-toplevel"])).stdout.trim();
      } catch {
        throw new ApiError(409, "CODE_PROJECT_NOT_GIT", `代码项目不是可用的 Git 仓库：${binding.workspacePath}`);
      }
      const repoName = slug(path.basename(repositoryPath), "repository");
      const issueName = slug(task.externalKey ?? task.identifier ?? task.id, "task");
      const title = slug(task.title, "work");
      const branch = `codex/${issueName}-${title}`.slice(0, 120);
      const worktreePath = path.join(worktreesDirectory, repoName, issueName);
      await mkdir(path.dirname(worktreePath), { recursive: true });
      const baseRef = await refExists(repositoryPath, "refs/remotes/origin/main")
        ? "origin/main"
        : await refExists(repositoryPath, "refs/heads/main")
          ? "main"
          : "HEAD";
      if (!await exists(worktreePath)) {
        if (await refExists(repositoryPath, `refs/heads/${branch}`)) {
          await git(repositoryPath, ["worktree", "add", worktreePath, branch]);
        } else {
          await git(repositoryPath, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
        }
      }
      return { path: worktreePath, branch, repositoryPath, baseRef };
    },

    async release(task) {
      if (!task.managedWorktree || task.developmentContext?.type !== "worktree") {
        return { released: true, reason: null };
      }
      const repositoryPath = task.managedWorktree.repositoryPath;
      const worktreePath = task.developmentContext.path;
      const branch = task.developmentContext.branch;
      if (!await exists(worktreePath)) return { released: true, reason: null };
      const status = (await git(worktreePath, ["status", "--porcelain"])).stdout.trim();
      if (status) return { released: false, reason: "dirty" };
      const mergeTarget = await refExists(repositoryPath, "refs/remotes/origin/main") ? "origin/main" : "main";
      if (branch) {
        try {
          await git(repositoryPath, ["merge-base", "--is-ancestor", branch, mergeTarget]);
        } catch {
          return { released: false, reason: "unmerged" };
        }
      }
      await git(repositoryPath, ["worktree", "remove", worktreePath]);
      if (branch && await refExists(repositoryPath, `refs/heads/${branch}`)) {
        await git(repositoryPath, ["branch", "-d", branch]);
      }
      return { released: true, reason: null };
    },
  };
}
