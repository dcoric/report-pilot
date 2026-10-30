import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const DATA_SOURCE_ID = '00000000-0000-4000-8000-000000000101';
const USER_ID = '00000000-0000-4000-8000-000000000201';
const SESSION_ID = '00000000-0000-4000-8000-000000000301';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000401';
const REFINEMENT_BASE_UNAVAILABLE = 'The selected result has no validated SQL to refine.';

type SessionCreateBody = {
    data_source_id?: string;
    question?: string;
    parent_session_id?: string;
};

function sessionIdFor(index: number) {
    return `00000000-0000-4000-8000-${String(301 + index).padStart(12, '0')}`;
}

function runResultFor(question: string) {
    if (/past 3 months/i.test(question)) {
        return {
            sql: "SELECT region, SUM(revenue) AS total_revenue FROM sales WHERE sold_at >= now() - interval '3 months' GROUP BY region",
            rows: [{ region: 'South', total_revenue: 98000 }],
        };
    }
    return {
        sql: 'SELECT region, SUM(revenue) AS total_revenue FROM sales GROUP BY region',
        rows: [{ region: 'North', total_revenue: 125000 }],
    };
}

const user = {
    id: USER_ID,
    email: 'analyst@example.com',
    display_name: 'Test Analyst',
    roles: ['admin'],
    permissions: [
        'query.run',
        'saved_queries.read',
        'saved_queries.write',
        'data_sources.read',
        'users.read_self',
    ],
};

async function installApiFixture(page: Page) {
    let authenticated = false;
    let createdQuestion: string | null = null;
    let runSessionId: string | null = null;
    const sessionBodies: SessionCreateBody[] = [];
    const sessionQuestions = new Map<string, string>();
    let nextCreateFailure: { status: number; body: unknown } | null = null;

    await page.route('**/v1/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        const json = (body: unknown, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(body),
        });

        if (path === '/v1/auth/me') {
            return authenticated
                ? json({ user, expires_at: '2099-01-01T00:00:00.000Z' })
                : json({ message: 'Authentication required' }, 401);
        }
        if (path === '/v1/auth/oidc/providers') {
            return json({ items: [] });
        }
        if (path === '/v1/auth/login' && method === 'POST') {
            authenticated = true;
            return json({ user, expires_at: '2099-01-01T00:00:00.000Z' });
        }
        if (path === '/v1/data-sources') {
            return json({
                items: [{
                    id: DATA_SOURCE_ID,
                    name: 'Sales Warehouse',
                    db_type: 'postgres',
                    connection_ref: 'fixture:sales',
                    status: 'active',
                    created_at: '2026-01-01T00:00:00.000Z',
                }],
            });
        }
        if (path === '/v1/users/me/config') {
            return json({ config: { default_data_source_id: DATA_SOURCE_ID } });
        }
        if (path === '/v1/llm/providers') {
            return json({
                items: [{
                    id: '00000000-0000-4000-8000-000000000501',
                    provider: 'openai',
                    display_name: 'OpenAI',
                    default_model: 'gpt-4.1-mini',
                    enabled: true,
                }],
            });
        }
        if (path === '/v1/saved-queries') {
            return json({ items: [] });
        }
        if (path === '/v1/query/prompts/history') {
            return json({ items: [] });
        }
        if (path === '/v1/query/sessions' && method === 'POST') {
            const body = request.postDataJSON() as SessionCreateBody;
            sessionBodies.push(body);
            createdQuestion = body.question ?? null;
            if (nextCreateFailure) {
                const failure = nextCreateFailure;
                nextCreateFailure = null;
                return json(failure.body, failure.status);
            }
            const sessionId = sessionIdFor(sessionQuestions.size);
            sessionQuestions.set(sessionId, body.question ?? '');
            return json({ session_id: sessionId, status: 'created', parent_session_id: body.parent_session_id ?? null });
        }
        const runMatch = /^\/v1\/query\/sessions\/([^/]+)\/run$/.exec(path);
        if (runMatch && method === 'POST' && sessionQuestions.has(runMatch[1])) {
            runSessionId = runMatch[1];
            const result = runResultFor(sessionQuestions.get(runMatch[1]) ?? '');
            return json({
                attempt_id: ATTEMPT_ID,
                sql: result.sql,
                columns: ['region', 'total_revenue'],
                rows: result.rows,
                row_count: 1,
                duration_ms: 24,
                confidence: 0.95,
                preview: false,
                diagnostics: {
                    schema_linking: null,
                    prompts: { linker_chars: 120, generation_chars: 480, repair_chars: 0, total_chars: 600 },
                    retrieval: { rag_document_count: 2, example_count: 1 },
                    repair_count: 0,
                },
                provider: { name: 'openai', model: 'gpt-4.1-mini' },
                citations: { schema_objects: [] },
            });
        }

        return json({ message: `Unhandled fixture request: ${method} ${path}` }, 501);
    });

    return {
        getCreatedQuestion: () => createdQuestion,
        getRunSessionId: () => runSessionId,
        getSessionBodies: () => [...sessionBodies],
        failNextSessionCreate: (status: number, body: unknown) => {
            nextCreateFailure = { status, body };
        },
    };
}

async function expectNoWcagViolations(page: Page) {
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
    expect(results.violations).toEqual([]);
}

test('signs in and completes the natural-language query flow', async ({ page }) => {
    const api = await installApiFixture(page);

    await page.goto('/query');
    await expect(page).toHaveURL(/\/login$/);

    const emailInput = page.getByLabel('Email');
    const passwordInput = page.getByLabel('Password');
    const signInButton = page.getByRole('button', { name: 'Sign in' });
    await emailInput.focus();
    await expect(emailInput).toBeFocused();
    await emailInput.fill('analyst@example.com');
    await page.keyboard.press('Tab');
    await expect(passwordInput).toBeFocused();
    await passwordInput.fill('Password123');
    await page.keyboard.press('Tab');
    await expect(signInButton).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/query$/);
    await expect(page.getByText('Sales Warehouse').first()).toBeVisible();
    await expectNoWcagViolations(page);

    const question = 'Show total revenue by region';
    const questionInput = page.getByPlaceholder(/Adjust this query/);
    await questionInput.focus();
    await expect(questionInput).toBeFocused();
    await questionInput.fill(question);
    await page.keyboard.press('Enter');

    await expect(page.getByText('1 Rows')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'North' })).toBeVisible();
    await expect(page.getByRole('cell', { name: '125000' })).toBeVisible();
    await expect(page.getByText('95.0%')).toBeVisible();
    await expectNoWcagViolations(page);
    expect(api.getCreatedQuestion()).toBe(question);
    expect(api.getRunSessionId()).toBe(SESSION_ID);
});

test('refines the displayed result with follow-up prompts', async ({ page }) => {
    const api = await installApiFixture(page);

    await page.goto('/query');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill('analyst@example.com');
    await page.getByLabel('Password').fill('Password123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/query$/);

    const firstPrompt = 'generate report for affiliates that ended contract with us';
    const askInput = page.getByRole('textbox', { name: 'Ask a question' });
    await askInput.fill(firstPrompt);
    await askInput.press('Enter');

    await expect(page.getByRole('cell', { name: 'North' })).toBeVisible();
    const refineInput = page.getByRole('textbox', { name: 'Refine the current result' });
    await expect(refineInput).toHaveValue('');
    await expect(refineInput).toHaveAttribute('placeholder', /Refine this result/);
    const refinementHistory = page.getByRole('list', { name: 'Refining:' });
    await expect(refinementHistory.getByRole('listitem')).toHaveText([firstPrompt]);
    expect(api.getSessionBodies()[0]).not.toHaveProperty('parent_session_id');

    const secondPrompt = 'limit this to past 3 months';
    await refineInput.fill(secondPrompt);
    await refineInput.press('Enter');

    await expect(page.getByRole('cell', { name: 'South' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'North' })).toHaveCount(0);
    await expect(refineInput).toHaveValue('');
    await expect(refinementHistory.getByRole('listitem')).toHaveText([firstPrompt, secondPrompt]);
    expect(api.getSessionBodies()[1]).toMatchObject({ question: secondPrompt, parent_session_id: SESSION_ID });
    expect(api.getRunSessionId()).toBe(sessionIdFor(1));
    await expectNoWcagViolations(page);

    api.failNextSessionCreate(409, { error: 'refinement_base_unavailable', message: REFINEMENT_BASE_UNAVAILABLE });
    const failedPrompt = 'only include partners from Europe';
    await refineInput.fill(failedPrompt);
    await page.getByRole('button', { name: 'Refine', exact: true }).click();

    await expect(page.getByText(REFINEMENT_BASE_UNAVAILABLE)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'South' })).toBeVisible();
    await expect(refineInput).toHaveValue(failedPrompt);
    await expect(refinementHistory.getByRole('listitem')).toHaveText([firstPrompt, secondPrompt]);
    expect(api.getSessionBodies()[2]).toMatchObject({ question: failedPrompt, parent_session_id: sessionIdFor(1) });

    await page.getByRole('button', { name: 'New query', exact: true }).click();

    await expect(page.getByRole('cell', { name: 'South' })).toHaveCount(0);
    await expect(refinementHistory).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New query', exact: true })).toHaveCount(0);
    await expect(askInput).toHaveValue('');

    await askInput.fill('Show total revenue by region');
    await askInput.press('Enter');

    await expect(page.getByRole('cell', { name: 'North' })).toBeVisible();
    expect(api.getSessionBodies()).toHaveLength(4);
    expect(api.getSessionBodies()[3]).not.toHaveProperty('parent_session_id');

    // The sidebar button also starts over when the workspace is already open.
    await expect(refinementHistory.getByRole('listitem')).toHaveText(['Show total revenue by region']);
    await page.getByRole('button', { name: 'New Query', exact: true }).click();
    await expect(refinementHistory).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'North' })).toHaveCount(0);
    await expect(askInput).toHaveValue('');
});
