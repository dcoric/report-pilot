import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';

interface EditableProvider {
    provider: string;
    default_model: string;
    base_url?: string;
    display_name?: string;
    enabled: boolean;
}

interface EditProviderApiKeyDialogProps {
    isOpen: boolean;
    provider: EditableProvider | null;
    providerLabel: string;
    onClose: () => void;
    onSuccess: () => Promise<void> | void;
}

function getApiErrorMessage(error: unknown): string | null {
    if (!error || typeof error !== 'object') {
        return null;
    }
    if ('message' in error && typeof error.message === 'string' && error.message.trim()) {
        return error.message;
    }
    return null;
}

export const EditProviderApiKeyDialog: React.FC<EditProviderApiKeyDialogProps> = ({
    isOpen,
    provider,
    providerLabel,
    onClose,
    onSuccess,
}) => {
    const [apiKeyRef, setApiKeyRef] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!isOpen) {
            setApiKeyRef('');
            setIsSubmitting(false);
        }
    }, [isOpen, provider?.provider]);

    if (!isOpen || !provider) return null;

    const trimmedApiKeyRef = apiKeyRef.trim();

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!trimmedApiKeyRef) return;

        setIsSubmitting(true);
        try {
            const { response, error } = await client.POST('/v1/llm/providers', {
                body: {
                    provider: provider.provider,
                    api_key_ref: trimmedApiKeyRef,
                    default_model: provider.default_model,
                    base_url: provider.base_url,
                    display_name: provider.display_name,
                    enabled: provider.enabled,
                },
            });

            if (error) {
                if (!getApiErrorMessage(error)) {
                    toast.error(`Failed to update ${providerLabel} API key`);
                }
                return;
            }

            if (response.ok) {
                toast.success(`${providerLabel} API key updated`);
                onClose();
                setApiKeyRef('');
                await onSuccess();
            }
        } catch (error) {
            console.error('Failed to update provider API key', error);
            toast.error(`Failed to update ${providerLabel} API key`);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
                <div className="flex justify-between items-center p-4 border-b">
                    <div>
                        <h2 className="text-lg font-semibold">Edit API Key</h2>
                        <p className="text-sm text-gray-500 mt-1">{providerLabel}</p>
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700" disabled={isSubmitting}>
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
                    <div className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2">
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">Current status</p>
                        <p className="text-sm text-gray-800 mt-1">API key configured. Existing values are never shown.</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">New API Key or Reference</label>
                        <input
                            type="password"
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            value={apiKeyRef}
                            onChange={(e) => setApiKeyRef(e.target.value)}
                            placeholder="sk-... or env:OPENAI_API_KEY"
                            autoComplete="new-password"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                            Enter a new API key or reference, for example <code>sk-...</code> or <code>env:OPENAI_API_KEY</code>.
                        </p>
                    </div>

                    <div className="flex justify-end gap-2 mt-4">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200"
                            disabled={isSubmitting}
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="px-4 py-2 text-sm font-medium text-white bg-oxblood rounded-md hover:bg-oxblood-deep disabled:opacity-50"
                            disabled={isSubmitting || !trimmedApiKeyRef}
                        >
                            {isSubmitting ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
