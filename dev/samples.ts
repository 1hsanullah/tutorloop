/** Example exercises, in exactly the shape the model is asked to produce. Dev harness only. */
export interface Sample {
  language: "python" | "javascript" | "typescript" | "sql";
  title: string;
  lesson_md: string;
  task_md: string;
  starter_code: string;
  seed?: string;
  tests: string;
  hints: string[];
  solution: string;
}

export const SAMPLES: Sample[] = [
  {
    language: "python",
    title: "f-strings: formatting numbers",
    lesson_md: `An f-string is a string literal prefixed with \`f\`. Anything inside \`{}\` is evaluated
and inserted.

A colon after the expression starts a *format spec*. \`:.2f\` means "fixed point, two decimal
places" — it rounds, and it always shows both digits.

\`\`\`python
price = 3.14159
print(f"{price:.2f}")   # 3.14
print(f"{10:.2f}")      # 10.00
\`\`\`

Note the second line: \`10\` is an int, but \`.2f\` still prints \`10.00\`. The format spec does the
padding for you, so you never need to special-case whole numbers.`,
    task_md: `Write \`format_price(x)\`. It takes a number and returns it as a price string: a
dollar sign, then the number to exactly two decimal places.

\`format_price(3.14159)\` → \`"$3.14"\`, and \`format_price(10)\` → \`"$10.00"\`.`,
    starter_code: `def format_price(x):
    # your code here
    pass
`,
    tests: `assert format_price(3.14159) == "$3.14"
assert format_price(10) == "$10.00"
assert format_price(0) == "$0.00"
assert format_price(2.005) == "$2.00" or format_price(2.005) == "$2.01"
assert format_price(1234.5) == "$1234.50"
`,
    hints: [
      "You want an f-string with a format spec after a colon.",
      "The spec for two decimal places is `.2f`.",
      'The whole body is one line: `return f"${x:.2f}"`.',
    ],
    solution: `def format_price(x):
    return f"\${x:.2f}"
`,
  },
  {
    language: "python",
    title: "List comprehensions: filter and transform",
    lesson_md: `A list comprehension builds a list in one expression:

\`\`\`python
squares = [n * n for n in range(5)]      # [0, 1, 4, 9, 16]
evens   = [n for n in range(10) if n % 2 == 0]
\`\`\`

The shape is \`[expression for item in iterable if condition]\`. The condition is optional, and it
is applied *before* the expression.`,
    task_md: `Write \`even_squares(numbers)\`. It takes a list of integers and returns a list with
the squares of just the even ones, in the original order.

\`even_squares([1, 2, 3, 4])\` → \`[4, 16]\`.`,
    starter_code: `def even_squares(numbers):
    # your code here
    pass
`,
    tests: `assert even_squares([1, 2, 3, 4]) == [4, 16]
assert even_squares([]) == []
assert even_squares([1, 3, 5]) == []
assert even_squares([-2, -1, 0]) == [4, 0]
`,
    hints: [
      "Both the filter and the transform go in one comprehension.",
      "A number is even when `n % 2 == 0`.",
      "`return [n * n for n in numbers if n % 2 == 0]`.",
    ],
    solution: `def even_squares(numbers):
    return [n * n for n in numbers if n % 2 == 0]
`,
  },
  {
    language: "javascript",
    title: "Array.reduce: summing objects",
    lesson_md: `\`reduce\` folds an array into one value. It takes a callback and a starting value:

\`\`\`js
const total = [1, 2, 3].reduce((sum, n) => sum + n, 0);   // 6
\`\`\`

The callback gets the accumulator so far and the current item, and returns the next accumulator.
Passing the starting value explicitly is what makes it safe on an empty array.`,
    task_md: `Write \`totalPrice(items)\`. Each item looks like \`{ name, price, quantity }\`.
Return the total cost — price times quantity, summed across all items. An empty array totals \`0\`.`,
    starter_code: `function totalPrice(items) {
  // your code here
}
`,
    tests: `assertEquals(totalPrice([]), 0);
assertEquals(totalPrice([{ name: "pen", price: 2, quantity: 3 }]), 6);
assertEquals(
  totalPrice([
    { name: "pen", price: 2, quantity: 3 },
    { name: "pad", price: 5.5, quantity: 2 },
  ]),
  17,
);
`,
    hints: [
      "Start the accumulator at 0 so an empty array works without a special case.",
      "Each step adds `item.price * item.quantity`.",
      "`return items.reduce((sum, item) => sum + item.price * item.quantity, 0);`",
    ],
    solution: `function totalPrice(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
`,
  },
  {
    language: "typescript",
    title: "Narrowing a union type",
    lesson_md: `A union says a value is one of several shapes. TypeScript will not let you touch a
member until it knows *which* shape you have, and the usual way to tell it is a check on a shared
literal field — a discriminant.

\`\`\`ts
type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "square"; side: number };

function area(shape: Shape): number {
  if (shape.kind === "circle") {
    return Math.PI * shape.radius ** 2;   // here, shape is the circle
  }
  return shape.side ** 2;                 // and here it can only be the square
}
\`\`\`

The types are erased before the code runs, so they never affect the answer — but the narrowing
still tells you which branch is which.`,
    task_md: `A \`Payment\` is either \`{ kind: "cash"; amount: number }\` or
\`{ kind: "card"; amount: number; fee: number }\`.

Write \`settle(payment: Payment): number\` returning what actually leaves the account: the amount
for cash, and the amount plus the fee for a card.`,
    starter_code: `type Payment =
  | { kind: "cash"; amount: number }
  | { kind: "card"; amount: number; fee: number };

function settle(payment: Payment): number {
  // your code here
  return 0;
}
`,
    tests: `assertEquals(settle({ kind: "cash", amount: 20 }), 20);
assertEquals(settle({ kind: "card", amount: 20, fee: 0.5 }), 20.5);
assertEquals(settle({ kind: "cash", amount: 0 }), 0);
assertEquals(settle({ kind: "card", amount: 100, fee: 0 }), 100);
`,
    hints: [
      "Check `payment.kind` first — that is what tells the two apart.",
      "Only the card branch may read `fee`; the cash branch has no such field.",
      '`if (payment.kind === "cash") return payment.amount; return payment.amount + payment.fee;`',
    ],
    solution: `function settle(payment: Payment): number {
  if (payment.kind === "cash") return payment.amount;
  return payment.amount + payment.fee;
}
`,
  },
  {
    language: "sql",
    title: "GROUP BY with HAVING",
    lesson_md: `\`GROUP BY\` collapses rows that share a value into one row per group, and aggregates
like \`SUM\` and \`COUNT\` then describe each group.

\`\`\`sql
SELECT customer, SUM(total) AS spend
FROM orders
GROUP BY customer;
\`\`\`

\`WHERE\` filters rows *before* grouping. To filter the groups themselves you need \`HAVING\`,
which runs after the aggregate is known:

\`\`\`sql
HAVING SUM(total) > 100
\`\`\`

That difference is the whole lesson: \`WHERE SUM(total) > 100\` is an error, because no sum exists
yet when \`WHERE\` runs.`,
    task_md: `Return one row per customer who has spent **more than 100** in total, with two
columns: \`customer\`, and their total spend as \`spend\` rounded to 2 decimal places.

Order by \`spend\`, highest first.`,
    starter_code: `SELECT customer, ...
FROM orders
-- your code here
`,
    seed: `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer TEXT NOT NULL,
  total REAL NOT NULL,
  placed_on TEXT
);
INSERT INTO orders (customer, total, placed_on) VALUES
  ('ada',   120.50, '2026-01-04'),
  ('ada',    80.00, '2026-02-11'),
  ('grace',  42.25, '2026-01-19'),
  ('alan',   15.00, '2026-03-02'),
  ('alan',  300.75, '2026-03-08'),
  ('edsger', 99.99, '2026-02-27');
`,
    tests: `SELECT customer, ROUND(SUM(total), 2) AS spend
FROM orders
GROUP BY customer
HAVING SUM(total) > 100
ORDER BY spend DESC
`,
    hints: [
      "One row per customer means `GROUP BY customer`.",
      "Filtering on a total means `HAVING`, not `WHERE` — the sum does not exist yet when `WHERE` runs.",
      "`ROUND(SUM(total), 2) AS spend`, then `HAVING SUM(total) > 100`, then `ORDER BY spend DESC`.",
    ],
    solution: `SELECT customer, ROUND(SUM(total), 2) AS spend
FROM orders
GROUP BY customer
HAVING SUM(total) > 100
ORDER BY spend DESC;
`,
  },
];
