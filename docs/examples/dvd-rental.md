# DVD Rental: from a question to a saved report

These examples were run against the bundled DVD Rental sample on **26 October 2026**. They demonstrate live generation, execution, business context, saved queries, and CSV export. The records are sample data, not production customer data.

## Run conditions

| Setting | Value |
| --- | --- |
| Source database | PostgreSQL 16, restored from `test-data/dvdrental.tar` |
| Source access | Separate SELECT-only role with `default_transaction_read_only = on` |
| Schema | 22 discovered tables and views |
| SQL generation | OpenAI `gpt-6.1-sol`, reasoning effort `low` |
| Embeddings | `RAG_EMBED_PROVIDER=local`, `local-hash-v1` |
| Business context | Three active RAG notes, listed below |
| Rule-based fallback | Disabled |
| Debug prompt logging | Disabled |
| Date handling | The fixture initialization script shifted dates so the latest payment was 25 October 2026 |

The run used the README branch based on `ed559b75ede0499a37d46f62fa01f3e88b2c9a13`, including two fixes found during this walkthrough: compatible request parameters for Sol, and explicit UUID/text parameter casts in saved-query listing. The captured UI is the running application, not a mockup.

The [official OpenAI migration guide](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra#migration-quickstart) documents Sol's reasoning and sampling parameter requirements. The adapter uses `max_completion_tokens`, `reasoning_effort: low`, and omits `temperature` for this model. Existing GPT-5 and older model request behavior is preserved.

Follow [Getting started](../getting-started.md) to load the fixture and sign in. A fresh fixture initialized on another date will have different month labels and date-filtered totals.

## Add the business context

In **Datasets → RAG Notes**, create these active notes:

| Title | Content |
| --- | --- |
| Revenue definition | Revenue means collected payments: `SUM(public.payment.amount)`, grouped by `public.payment.payment_date`. Use `payment_date` for revenue periods. Film `rental_rate` is a catalog price, not collected revenue. |
| Film category revenue | Join `payment.rental_id` to `rental.rental_id`, `rental.inventory_id` to `inventory.inventory_id`, `inventory.film_id` to `film_category.film_id`, and `film_category.category_id` to `category.category_id`. Group by `category.name`. |
| Reporting conventions | DVD Rental is a sample database. For monthly reporting, use calendar months and label them YYYY-MM. Round revenue and average payment amounts to two decimal places. If the question gives no date range, use all available payment history. |

Saving notes triggers reindexing. The initial index contained 22 schema documents and three policy documents. The monthly run returned citations for the payment schema and all three notes.

![Business context used in the example queries](../images/rag-notes.png)

## Example 1: monthly collected revenue

Open **New Query** and ask:

```text
Show monthly collected revenue, payment count and average payment amount
across all payment history, ordered by month.
```

The model generated and executed:

```sql
SELECT
    TO_CHAR(DATE_TRUNC('month', payment_date), 'YYYY-MM') AS month,
    ROUND(SUM(amount), 2) AS collected_revenue,
    COUNT(*) AS payment_count,
    ROUND(AVG(amount), 2) AS average_payment_amount
FROM public.payment
GROUP BY DATE_TRUNC('month', payment_date)
ORDER BY DATE_TRUNC('month', payment_date)
LIMIT 1000;
```

| Month | Collected revenue | Payment count | Average payment |
| --- | ---: | ---: | ---: |
| 2026-07 | 3,387.58 | 842 | 4.02 |
| 2026-08 | 20,587.43 | 4,857 | 4.24 |
| 2026-09 | 22,737.85 | 5,415 | 4.20 |
| 2026-10 | 14,599.18 | 3,482 | 4.19 |

All four rows matched this independently written query, executed directly in PostgreSQL:

```sql
SELECT
    to_char(payment_date, 'YYYY-MM') AS month,
    sum(amount) AS revenue,
    count(*) AS payments,
    round(sum(amount) / count(*), 2) AS average_payment
FROM payment
GROUP BY 1
ORDER BY 1;
```

Choose **Save**, name it **Monthly collected revenue**, and add the `finance` tag. The saved-query list successfully returned the report. CSV export returned the same four rows and headers shown in the workspace.

![Saved monthly revenue query with SQL, results, and execution metadata](../images/query-workspace.png)

The screenshot's 10 ms is database execution time, not total generation latency. The displayed 75% confidence is a heuristic, not a measured correctness probability.

## Example 2: top film categories

Ask:

```text
Which five film categories generated the most collected payment revenue
across all payment history?
```

The model selected the fixture's existing reporting view:

```sql
SELECT category, ROUND(total_sales, 2) AS collected_payment_revenue
FROM public.sales_by_film_category
ORDER BY total_sales DESC NULLS LAST, category ASC
LIMIT 5;
```

| Category | Collected payment revenue |
| --- | ---: |
| Sports | 4,892.19 |
| Sci-Fi | 4,336.01 |
| Animation | 4,245.31 |
| Drama | 4,118.46 |
| Comedy | 4,002.48 |

To verify the view-based answer independently, join the underlying tables:

```sql
SELECT c.name AS category, sum(p.amount) AS revenue
FROM payment p
JOIN rental r USING (rental_id)
JOIN inventory i USING (inventory_id)
JOIN film_category fc USING (film_id)
JOIN category c USING (category_id)
GROUP BY c.name
ORDER BY revenue DESC
LIMIT 5;
```

All five category names, amounts, and positions matched. The report was saved as **Top film categories by collected revenue** with `finance` and `sample` tags. This example demonstrates selection of an existing reporting view; it does not demonstrate generated five-table SQL.

## Connect the join path

An additional question asked for category revenue and payment counts specifically in September 2026. It exposed an important setup detail: the read-only role saw zero foreign keys through the current adapter's `information_schema` query, even though the source database had 18 foreign-key constraints. The first run stopped with `schema_linking_disconnected`.

Using **Schema Explorer → Join Policies**, add these approved `INNER` joins when the relationships are absent:

| Left table | Right table | ON clause |
| --- | --- | --- |
| `public.payment` | `public.rental` | `public.payment.rental_id = public.rental.rental_id` |
| `public.rental` | `public.inventory` | `public.rental.inventory_id = public.inventory.inventory_id` |
| `public.inventory` | `public.film_category` | `public.inventory.film_id = public.film_category.film_id` |
| `public.film_category` | `public.category` | `public.film_category.category_id = public.category.category_id` |

These were configured through the authenticated `POST /v1/join-policies` API during this run. Each request included `data_source_id`, `left_ref`, `right_ref`, `on_clause`, `join_type: "INNER"`, and `approved: true`. The index then contained 22 schema documents and seven policy documents. No database permissions were broadened.

After adding the policies, the September question executed a four-table join and returned category IDs with the correct amounts and counts:

| Category ID | Name checked separately | Revenue | Payments |
| --- | --- | ---: | ---: |
| 15 | Sports | 1,779.09 | 391 |
| 14 | Sci-Fi | 1,647.22 | 378 |
| 2 | Animation | 1,621.02 | 398 |
| 7 | Drama | 1,537.39 | 361 |
| 9 | Foreign | 1,481.49 | 351 |

The names in this table were looked up separately, not returned by that generated query. An explicit follow-up requesting category names still stopped at `schema_linking_disconnected`: the selected payment-to-category path required three intermediate tables, exceeding the current default of two. This is an observed limitation, not a successful end-to-end example. Prose notes do not replace graph edges, and adding join policies does not remove the path-length budget.

## What this verification establishes

- Live OpenAI generation and PostgreSQL execution produced the two main reports above, and all returned values matched separate reference queries.
- The monthly report was saved through the UI and exported to CSV. Both saved reports were returned by the authenticated list endpoint.
- RAG notes and approved join policies were indexed and used by the query context workflow.
- The exploration also exposed read-only constraint discovery and join-path limits, documented above.

This was a small, manually checked demonstration. It is not the full 60-question benchmark, a model comparison, or an overall accuracy measurement. See [Development and evaluation](../development.md) for the test suites and the benchmark runner's authentication gap.
