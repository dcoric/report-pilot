import createClient from 'openapi-fetch';
import type { paths } from './types';
import { toast } from 'sonner';

const baseUrl = import.meta.env.VITE_API_BASE_URL || '';

export const client = createClient<paths>({
    baseUrl,
    credentials: 'include',
});

// Add a response interceptor to handle global errors
client.use({
    onResponse: async ({ response }) => {
        if (!response.ok) {
            // Try to parse error message from body if possible
            let errorMessage = `API Error: ${response.status} ${response.statusText}`;
            try {
                const data = await response.clone().json();
                if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') {
                    errorMessage = data.message;
                }
            } catch {
                // ignore JSON parse errors
            }

            // Log error to console
            console.error(`API Request Failed: ${response.url}`, errorMessage);

            // 401 is surfaced via the auth flow (redirect to /login). 404 is usually
            // handled inline by the UI. Skip global toasts for both.
            if (response.status !== 404 && response.status !== 401) {
                toast.error(errorMessage);
            }
        }
        return undefined;
    },
});
