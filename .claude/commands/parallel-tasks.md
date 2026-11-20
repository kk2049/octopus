You are given a set of tasks to execute in parallel. Follow this exact workflow:

## Phase 1: Task Analysis

1. Parse the user's task descriptions from the arguments below.
2. For each task, identify which files will be modified.
3. Build a dependency graph based on file overlap:
   - Two tasks **conflict** if they modify the same file → must be in different batches.
   - Two tasks with no shared files → can run in the same batch.
4. Group tasks into sequential batches, maximizing parallelism within each batch.
5. Present the execution plan as a diagram and ask the user to confirm.

## Phase 2: Parallel Execution

For each batch:
1. Launch all tasks in the batch simultaneously using the Agent tool with `isolation: "worktree"`.
2. Give each agent a clear, self-contained prompt describing exactly what to do.
3. Each agent should:
   - Read relevant files first to understand context
   - Make the requested changes
   - Run the project's build/type-check command to verify
   - Commit with a descriptive message
4. Wait for all agents in the batch to complete.
5. Merge all worktree branches into main, resolve conflicts if any, verify build.
6. Proceed to the next batch.

## Phase 3: Summary

After all batches complete:
1. Run a final build/compilation check.
2. Present a summary table: task → status → commit hash → files changed.

## Rules

- Always use `isolation: "worktree"` for parallel agents.
- Never start a batch before the previous batch is fully merged and verified.
- Keep each agent's scope focused — one task per agent.
- If a task is ambiguous, ask the user to clarify before launching agents.
- Report progress after each batch.

$ARGUMENTS
