import { expect, test } from '@playwright/test';

const user = {
    id: '00000000-0000-4000-8000-000000000201',
    email: 'admin@example.com',
    display_name: 'Test Admin',
    roles: ['admin'],
    permissions: [],
};

test('auth provider admin surface only renders OIDC providers', async ({ page }) => {
    await page.route('**/v1/**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        const json = (body: unknown, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(body),
        });

        if (path === '/v1/auth/me') {
            return json({ user, expires_at: '2099-01-01T00:00:00.000Z' });
        }
        if (path === '/v1/data-sources') {
            return json({ items: [] });
        }
        if (path === '/v1/users/me/config') {
            return json({ config: {} });
        }
        if (path === '/v1/admin/auth-providers') {
            return json({
                items: [
                    {
                        id: '00000000-0000-4000-8000-000000000401',
                        type: 'oidc',
                        name: 'okta',
                        display_name: 'OIDC Production',
                        issuer: 'https://idp.example.com',
                        enabled: true,
                    },
                    {
                        id: '00000000-0000-4000-8000-000000000402',
                        type: 'ldap',
                        name: 'directory',
                        display_name: 'LDAP Directory',
                        issuer: null,
                        enabled: false,
                    },
                ],
            });
        }
        return json({ message: `Unhandled fixture request: ${path}` }, 501);
    });

    await page.goto('/admin/auth-providers');

    await expect(page.getByRole('heading', { name: 'Auth Providers' })).toBeVisible();
    await expect(page.getByText('OIDC Production')).toBeVisible();
    await expect(page.getByText('LDAP Directory')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(1);
});
