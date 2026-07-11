import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const DATA_SOURCE_ID = '00000000-0000-4000-8000-000000000101';
const USER_ID = '00000000-0000-4000-8000-000000000201';
const SESSION_ID = '00000000-0000-4000-8000-000000000301';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000401';

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
            createdQuestion = (request.postDataJSON() as { question?: string }).question ?? null;
            return json({ session_id: SESSION_ID, status: 'created' });
        }
        if (path === `/v1/query/sessions/${SESSION_ID}/run` && method === 'POST') {
            runSessionId = SESSION_ID;
            return json({
                attempt_id: ATTEMPT_ID,
                sql: 'SELECT region, SUM(revenue) AS total_revenue FROM sales GROUP BY region',
                columns: ['region', 'total_revenue'],
                rows: [{ region: 'North', total_revenue: 125000 }],
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
