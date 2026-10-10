---
title: AI Assist
description: How to connect your own OpenRouter account, teach the assistant your policies, let it answer or draft replies, take a conversation over from it, and route and size tickets with AI.
---

AI Assist adds an assistant to your helpdesk. It can answer customers in the chat, or write drafts
that your agents review. It works from your policies and your store's orders. When a conversation
needs a person, it hands the conversation to your team. Your organization brings its own OpenRouter
account and pays OpenRouter directly for what the assistant uses.

The admin pages are under **Admin → AI**. **AI settings**, **Complexity** and the group AI
descriptions need the **AI settings** permission. **Policies** needs **AI knowledge**, and **Usage**
needs **AI usage**. The Admin role has all three. See [Roles and groups](/admin/roles-and-groups/)
to give them to other roles.

## Connect OpenRouter

1. In OpenRouter, create a key under **Keys**. Give the key a **credit limit**: it caps what the
   assistant can spend.
2. In ReplyX, open **Admin → AI → AI settings** and choose **Add key**. Paste the key and choose
   **Save key**.
3. Choose **Test connection**. The result says whether the key works and how much credit it has left.

The key is stored encrypted. After you save it, ReplyX only shows its last four characters
(**•••• AB12**). To change it, choose **Replace key**. To stop all AI, choose **Remove key**.

If OpenRouter rejects the key or the account runs out of credit, AI **pauses** for your whole
organization. Admins get a notification, and AI settings shows an **AI paused** banner. While AI is
paused, every conversation goes to your team as if AI were off. To resume, replace the key or add
credit, then choose **Test connection**.

## Choose how the assistant replies

Under **Assistant → Replies** in AI settings:

| Mode | What happens |
|------|--------------|
| **Off** | The assistant does not answer. |
| **Drafts for agents** | The assistant writes a draft reply on each ticket. Customers never see it until an agent sends it. |
| **Auto-reply** | The assistant answers customers directly in the chat, and hands over to your team when it is unsure. |

Under **Models** you pick the model for each level (**Fast**, **Standard**, **Advanced**). Each
model shows its price per million tokens. Most conversations use Fast. See
[Complexity](#complexity-which-model-answers) for how the level is chosen.

## Add your policies

The assistant answers only from your policies and your orders. It never makes up rules, and it never
promises refunds, discounts or exceptions.

1. Open **Admin → AI → Policies** and choose **Add policy**.
2. Give it a **Title**, then either **Type text** or **Upload file** (a text, Markdown or PDF file up
   to **10 MB**).
3. Choose **Add policy**. The policy shows **Processing**, then **Ready** once the assistant can use
   it. If it shows **Failed**, the file had no readable text or could not be checked.

To change a policy, open it and choose **Edit policy**. The assistant keeps using the old text until
the new one is **Ready**, so customers never get half an answer. Deleting a policy removes it from
the assistant's answers immediately.

Short policies with clear headings work best: one heading per topic (returns, refunds, shipping,
warranty).

## Connect your Spree store

With a store connection, the assistant can look up an order's status and tracking when a customer
gives an order number.

1. In the Spree admin, create a **read-only** API key that can read orders.
2. In **AI settings → Store (Spree)**, choose **Connect your store**. Enter the **Store address** (the
   public **https://** address of your store) and the **Store key (read-only)**.
3. Choose **Test connection**.

The assistant only shares an order with the customer whose email address is on that order. Any
other order number gets the same answer as a number that does not exist. Private-network and
non-https addresses are refused.

## Hand-off, take over and hand back

The assistant **hands off** to your team when:

- the customer asks for a person
- the customer asks for a refund, compensation or an exception
- the customer is angry
- it is not confident in its answer
- the conversation stays unresolved for **two turns in a row**

On a hand-off it stops answering on that ticket, tags the ticket **AI hand-off** and puts it back in
your team's queue. In Auto-reply it also tells the customer: "I've passed this to our team; a person
will reply here soon."

When an agent sends a reply on a ticket, the assistant stops answering on it. On a ticket where the
assistant is answering, you can also:

- choose **Take over** to answer the customer yourself. You become the ticket's owner and the
  assistant stops.
- choose **Hand back to AI** to let the assistant answer again from the customer's next message.
  This is only available in Auto-reply, and not while AI is paused.

## The "Now replying" badge

At the top of the ticket, and in the customer's chat header, a badge says who is answering:
**Assistant · AI**, the agent's name, or **Support team**. It changes live when someone takes over or
hands back. Messages the assistant wrote show **Assistant · AI** as their author, for your team and
for the customer.

## Drafts

In **Drafts for agents** mode, an **AI draft** bar appears above the reply box when a draft is
ready. Choose **Use** to put the draft in the reply box, edit it, and send it like any reply. Choose
**Discard** to throw it away. A ticket has at most one draft. A newer customer message replaces it.

## Routing new tickets with AI

Your [routing rules](/admin/routing-rules/) always run first. When no rule matches a new customer
ticket, AI routing can choose a group for it:

1. On **Admin → Groups**, edit each group that should receive AI-routed tickets. Fill in its **AI
   description**, for example "Invoices, charges, payments and refunds". Groups without a
   description, and inactive groups, are never chosen.
2. In **AI settings → Routing**, turn on **Route new tickets with AI** and set **Confidence needed**
   (**70%** by default). Choose **Save routing**.

If the assistant is less sure than the confidence you set, or no group fits, the ticket stays in
**Needs Triage**. If someone sorts the ticket by hand first, their choice stands. The ticket's history
records each AI routing decision and how confident it was.

## Complexity: which model answers

**Admin → AI → Complexity** decides which conversations need a more capable model. Each factor gives
a conversation a value from 0 to 1. Factors with more **Weight** count more. Their weighted average
is the conversation's **complexity score**:

| Factor type | Worth 1 when… |
|-------------|---------------|
| Yes or no question | the AI answers yes |
| Scale | the highest level fits (lower levels are worth less) |
| Multiple choice | the option you valued at 1 fits |
| Customer has a tag | the customer has the tag |
| Times reopened | the ticket was reopened **3** times or more |
| SLA breached | the ticket has missed an SLA target |

The two sliders under **Levels** set where **Standard** and **Advanced** start. The preview below
them shows the score range of each level. The default settings start Standard at **45%** and
Advanced at **80%**, so most conversations stay on the cheaper Fast model. When you first turn AI
on, a starter set of factors is added: customer frustration, several issues in one message, and a
technical problem, plus a VIP factor if you have a tag named "VIP".

## Usage

**Admin → AI → Usage** lists every AI call: when it ran, what it was for, the model and level, the
tokens, the cost and the outcome. You can filter by date and purpose, and the totals follow your
filters. A cost marked **≈** is an estimate. No message content is stored with these records.
