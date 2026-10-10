---
title: Build and share custom views
description: How to build a view with conditions, sort order and columns, share it with your team, and edit it later, including what sharing does and does not reveal.
---

A custom view is a saved list of tickets that match conditions you choose. This guide walks through
building one, sharing it, and changing it later. For the views every team starts with, see
[Views and notifications](/guides/views-and-notifications/).

## Build a view

This example builds a view of urgent tickets nobody owns that have waited more than a day for a
reply.

1. On the view rail, choose **New view**. This needs the **view.create** permission. The builder
   opens in a side panel.
2. Under **Details**, enter a **Name** (up to **80 characters**). The **Description** is optional
   (up to **300 characters**) and is shown to the people the view is shared with.
3. Under **Conditions**, a new view starts with one condition, **State is not Closed**. Change it,
   or keep it, and choose the add controls to add more. For this example the view has three:
   - **Priority is** Urgent
   - **Owner is** Unassigned
   - **Last customer message is before** a time, or **is within the last** a number of minutes,
     hours, days or weeks
4. Under **Sort order**, choose **Add a sort field**. You can sort by up to **3 fields**, and
   earlier ones win. Set each to **Ascending** or **Descending**, and use the move controls to
   change the order.
5. Under **Columns**, choose **Add a column** for anything missing and remove what you don't need.
   The columns appear in the ticket list in the order you set. A view needs at least **1 column**.
6. Watch the count at the bottom of the panel. It reads "N tickets match now" and updates shortly
   after you stop editing. It waits until every condition has a value.
7. Choose **Create view**.

### How conditions combine

Conditions sit in blocks. A block matches when **all** of its conditions match (AND) or when
**any** of them match (OR), and you can nest blocks inside blocks, up to **3 levels** deep and
**20 conditions** in total. For example, "Priority is Urgent AND (Owner is Unassigned OR Tags has any
of Escalation)" is one block containing a nested block.

You can filter on state, priority, group, owner, tags, waiting on, created, updated, last customer
message, pending until and SLA status. Group can be **Ungrouped**, and owner can be **Me** or
**Unassigned**. Filtering on customer isn't offered yet.

## Share a view

Under **Sharing**, choose who can use the view:

| Choice | Who sees it |
|--------|-------------|
| **Only me** | Just you. Nobody else can see it. This is the default. |
| **All staff** | Everyone on your team. |
| **Specific roles** | People who hold one of the roles you pick. |
| **Specific groups** | People with access to one of the groups you pick. |

For roles and groups, you must pick at least one. Sharing requires the **view.share** permission.
Without it, the only choice is **Only me** and the panel tells you so.

You always see a view you created, even when you share it only with roles or groups you don't
belong to. You still see only the tickets in groups you can access.

### What sharing does and does not reveal

Sharing shares the view, meaning its name, description, conditions, sort order and columns. It
never shares ticket access. Whoever opens the view sees only the tickets that match and that sit in
groups they can already access, and counts follow the same rule. A person with no access to the
Support group will see a shared view of Support tickets with those tickets missing, even though the
view itself is shared with them. To change who can see which tickets, see
[Roles and groups](/admin/roles-and-groups/).

The count in the builder is likewise limited to what you can access.

## Edit a view

1. On the view rail, choose **Edit** next to the view. It appears only for views you can change.
   The panel opens with the view's current settings. After a save, the view is selected.
2. Change what you need and choose **Save changes**.

If you close the panel with unsaved changes, it asks **Discard your changes?**. Choose **Keep
editing** to go back or **Discard changes** to leave.

Who can edit:

- A personal view: only its owner.
- A shared view: people with the **view.edit** permission. Changing who it is shared with also needs
  **view.share**. Changes reach everyone the view is shared with.

If someone with **view.edit** changes a shared view to **Only me**, which also needs
**view.create**, they become its owner and the person who created it no longer sees it.

Personal views are not visible to anyone else.

## Default views

The default views are shared with everyone who can use them, and their sharing can't change. You
can edit their conditions, sort order and columns only with **view.edit**. They can be hidden, but
they can't be deleted. Needs Triage appears only for people with access to Ungrouped. To hide or
reorder views, choose **Arrange views** on the view rail.
