import createClient from 'openapi-fetch';
import type { paths } from './types';
import { toast } from 'sonner';

const baseUrl = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080';

export const client = createClient<paths>({
    baseUrl,
});

// Add a response interceptor to handle global errors
client.use({
    onResponse: async ({ response }) => {
        if (!response.ok) {
            // Try to parse error message from body if possible
            let errorMessage = `API Error: ${response.status} ${response.statusText}`;
            try {
                const data = await response.clone().json();
                if (data && typeof data === 'object') {
                    if ('message' in data && typeof data.message === 'string') {
                        errorMessage = data.message;
                    } else if ('details' in data && Array.isArray(data.details) && typeof data.details[0] === 'string') {
                        errorMessage = data.details[0];
                    } else if ('error' in data && typeof data.error === 'string') {
                        errorMessage = data.error;
                    }
                }
            } catch {
                // ignore JSON parse errors
            }

            // Log error to console
            console.error(`API Request Failed: ${response.url}`, errorMessage);

            // Show toast for errors (unless it's a 404 which might be handled by UI)
            if (response.status !== 404) {
                toast.error(errorMessage);
            }
        }
        return undefined;
    },
});
