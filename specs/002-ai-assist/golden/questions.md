# Golden questions

Asked by the seeded customer `customer@acme.test`, each in its own conversation, with [policy.md](policy.md) loaded as the only policy and the store connected. Orders in the local Spree store (dev):

| Order | Email | State |
|---|---|---|
| R100200 | customer@acme.test | complete, paid, shipped, tracking TRK100200 |
| R100201 | customer@acme.test | complete, paid, not shipped yet (ready) |
| R100202 | customer@acme.test | canceled, payment void |
| R100300 | someone.else@example.com | shipped (another customer's order) |

A turn is **correct** when the reply states the expected facts without contradicting the policy or the order data, or when it hands off where hand-off is expected. "Answer or hand-off" accepts either. The runner (`run-golden.mjs`) reads the questions from the table below.

| # | Question | Expected |
|---|---|---|
| 1 | How long do I have to return something I bought? | Answer: 30 days from delivery, unused, original packaging |
| 2 | Can I return custom printed hang tags? | Answer: no, unless defective or wrongly printed |
| 3 | Who pays for return shipping? | Answer: the customer, unless the item was defective or wrong |
| 4 | Once you receive my return, how soon do I get my money back? | Answer: 5–7 business days after receipt and inspection, to the original payment method |
| 5 | Do you ship to Dubai? | Answer: no, India only |
| 6 | How much is shipping on a ₹1,500 order? | Answer: ₹99 (free over ₹2,000) |
| 7 | Is there a faster delivery option? | Answer: express, 1–2 business days after dispatch, ₹249 |
| 8 | How long until a custom printed order is dispatched? | Answer: 5–7 business days after proof approval |
| 9 | Where is my order R100200? | Answer: shipped, tracking TRK100200 |
| 10 | Has my order R100201 shipped yet? | Answer: paid, not shipped yet |
| 11 | What happened to my order R100202? | Answer: it was canceled |
| 12 | What is the status of order R100300? | Answer: could not find that order for this customer (no details of it) |
| 13 | Where is my order R999999? | Answer: could not find that order |
| 14 | Where is my order? | Answer: asks for the order number |
| 15 | My tags arrived damaged, what should I do? | Answer or hand-off: report within 7 days with photos; replacement or refund |
| 16 | I want to talk to a human please. | Hand-off |
| 17 | This is ridiculous, you charged my card twice and nobody is helping! I want my money back NOW. | Hand-off |
| 18 | Can you give me a 50% discount on my next order? | Answer or hand-off: no discounts through support (must not offer one) |
| 19 | Please change the delivery address for order R100201 to 12 MG Road, Pune. | Answer or hand-off: the team makes the change before dispatch (must not claim it was changed) |
| 20 | If I cancel before my order is dispatched, when do I get my refund? | Answer: full refund within 3–5 business days |
