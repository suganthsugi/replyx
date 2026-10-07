---
title: Search tickets and customers
description: How to find a ticket by number, customer, title, message text or tag from the command bar or the search results page, and why you only see tickets you have access to.
---

Search finds tickets and customers across your whole workspace in one box. You only ever see
results you are allowed to open, so two people can run the same search and get different results.

## What you can search

| Search for | Example | Matches |
|------------|---------|---------|
| Ticket number | `4471` or `44` | Tickets whose number starts with what you typed |
| Customer name | `mar` | Tickets and customers whose name contains what you typed |
| Customer email | `@acme.com` | Tickets and customers whose email contains what you typed |
| Ticket title | `refund` | Words in the ticket title |
| Message content | `invoice 4471` | Words in any message on the ticket, including your team's replies |
| Tags | `billing` | Tickets carrying a tag with exactly that name |

## Search from the command bar

1. Press **Ctrl+K** (**Cmd+K** on a Mac) from any page.
2. Type your search. Matching views and tickets appear as you type.
3. Use the arrow keys to move through the list and press **Enter** to open the highlighted result.
4. To see every match, choose the full search option or press **Enter** with no result highlighted. This opens the search results page.

## The search results page

The results page lists matching tickets and customers, each with a short snippet that shows
where your words were found. Use the filter at the top to show **Tickets**, **Customers** or
**All**. Results load in pages; scroll to the end of the list to load more. Select a ticket to open
it, or a customer to see their tickets.

## Matching behaviour

- **Accents are ignored.** Searching `jose` finds `José`, and searching `müller` finds `Muller`.
- **Capitalisation does not matter.**
- **Names, emails and ticket numbers match partial text.** You do not need to type the whole value.
- **Titles and messages match whole words.** `refund` finds "refund", but not "refunded".
- **Tags must match exactly.** `billing` finds the tag **billing**, not **billing-eu**.

## Who sees what

- **Only tickets in groups you can access.** Search applies the same rules as your ticket lists. If your role lacks **View** on a group, its tickets never appear in results, and nothing hints that they exist. See [Roles and groups](/admin/roles-and-groups/).
- **Internal notes are searchable only by staff with access.** If a phrase appears only in an internal note, you find that ticket only when you can already see the note. Customers cannot search at all.
- **Only your workspace.** Search never returns anything from another organisation.

## When you cannot find something

- Check spelling of tags, which must match exactly.
- Search for a shorter part of a name or email.
- Ask an admin whether you have access to the group the ticket belongs to.

For working with a ticket once you have found it, see [Working tickets](/guides/working-tickets/).
