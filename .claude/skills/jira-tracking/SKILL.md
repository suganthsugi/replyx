---
name: jira-tracking
description: Track implementation work in Jira project RX (board 67) as it happens, not in advance. Use when starting or finishing any Spec Kit user story, phase, or task.
---

# jira-tracking

Board: https://ontodi.atlassian.net/jira/software/projects/RX/boards/67 (project key `RX`). Applies to the orchestrator and any agent that starts or finishes tracked work (a Spec Kit user story, phase, or task).

## Rules

1. **Just-in-time creation only. Never bulk-create.** Create a Jira issue only at the moment work on it actually begins — one issue per story/phase/task, created right before or right after starting it. Do not pre-create issues for a whole `tasks.md` up front, and do not create issues for future phases speculatively.
   Wrong: looping over all of `tasks.md` and calling `createJiraIssue` for every task before implementation starts.

2. **Hierarchy levels only: Story → Task → Sub-task.** No Epics, no other issue types, unless the user explicitly asks for one.
   - A Spec Kit user story (`US1`, `US2`, ...) maps to a Jira **Story**.
   - A Spec Kit phase or a standalone `tasks.md` task (`T012`) maps to a Jira **Task** under that Story.
   - A sub-step of a task that another agent hands off separately (e.g. a backend task and its paired frontend-connector task) maps to a Jira **Sub-task** under the Task.

3. **Create when work starts, not before.** When the orchestrator picks a task to delegate (see `.claude/agents/orchestrator.md` § "Per task"), first check whether its Story exists in RX; create it if not. Then create the Task (or Sub-task) for the specific work item about to be delegated, with:
   - Summary: the task ID and exact task text from `tasks.md` (e.g. `T012: Add ticket assignment endpoint`).
   - Description: what the task covers, the feature/spec path (`specs/<feature>/`), the acceptance criteria from `spec.md`, and which skills/agent are doing the work.
   - Link or reference back to `specs/<feature>/tasks.md`.

4. **Update when work finishes.** When the orchestrator ticks a task's checkbox (after the committer returns a commit hash), on the matching Jira issue:
   - Transition it to Done (`transitionJiraIssue`).
   - Add a comment with what was done: the commit hash, the summary, and any notable decisions (`addOrEditJiraIssueComment`).
   - Attach a screenshot of the completed work when the task produced anything visual (a UI change, a passing test run, a dashboard) or otherwise observable. Use `discover` to find the attachment operation (`executeWrite`) if it isn't in the primary Atlassian toolset yet — screenshots come from Claude in Chrome or from a terminal/test-output capture saved to the scratchpad and uploaded as the attachment.

5. **End of story.** When a story finishes (orchestrator § "End of story"), transition the Story issue to Done and add a comment summarizing the story: tasks completed, test/coverage results, reviewer verdict — mirroring what goes in the run log.

6. **Statuses.** RX's team-managed workflow is: **To Do → In Progress → In Review → Done**, with **Blocked** reachable from In Progress or In Review. Use them as:
   - Create an issue already **In Progress** (work has started by definition — rule 1) rather than leaving it in To Do.
   - Move a Task to **In Review** while `reviewer` is running against the story diff (orchestrator § "End of story") or while a task's affected tests are being verified.
   - Move to **Blocked**, with a comment explaining why, when a non-parallel task fails and execution halts, or after 2 failed fix attempts (orchestrator § "On failure").
   - Move to **Done** only once the commit lands and (for a Story) the reviewer verdict is PASS.
   - Look up the transition by the status it leads to via `listJiraIssueTransitions`, never a hardcoded transition ID — IDs differ per issue/workflow instance.

7. **Tool usage.** Use the primary Atlassian MCP tools directly: `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `getJiraIssue`, `searchJiraIssuesUsingJql`. Use `discover` + the matching `execute*` tool only for operations not covered by a primary tool (e.g. attachments, issue linking). Always pass `cloudId` at the top level on `execute*` calls, never inside `inputs`.

## Checklist (before reporting a task or story done)
- [ ] The Story issue exists in RX before its first Task is created.
- [ ] No issue was created before its work started.
- [ ] The issue type is Story, Task, or Sub-task — nothing else.
- [ ] The issue description names the task/spec it covers.
- [ ] A finished issue is transitioned to Done and has a comment with the outcome.
- [ ] A finished issue with visible output has a screenshot attached.
