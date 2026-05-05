import React, { useState } from 'react';
import { X } from 'lucide-react';
import { client } from '../../lib/api/client';
import { toast } from 'sonner';

interface AddProviderDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

const PROVIDER_OPTIONS = [
    { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.2' },
    { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-1.5-pro' },
    { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat' },
    { id: 'openrouter', name: 'OpenRouter', defaultModel: 'google/gemma-4-31b-it' },
    { id: 'custom', name: 'Custom (OpenAI-compatible)', defaultModel: '' },
] as const;

export const AddProviderDialog: React.FC<AddProviderDialogProps> = ({ isOpen, onClose, onSuccess }) => {
    const [provider, setProvider] = useState<string>(PROVIDER_OPTIONS[0].id);
    const [customProviderId, setCustomProviderId] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [apiKeyRef, setApiKeyRef] = useState('');
    const [defaultModel, setDefaultModel] = useState<string>(PROVIDER_OPTIONS[0].defaultModel);
    const [enabled, setEnabled] = useState(true);
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!isOpen) return null;

    const handleProviderChange = (value: string) => {
        setProvider(value);
        const option = PROVIDER_OPTIONS.find(p => p.id === value);
        if (option) setDefaultModel(option.defaultModel);
    };

    const resetForm = () => {
        setProvider(PROVIDER_OPTIONS[0].id);
        setCustomProviderId('');
        setDisplayName('');
        setBaseUrl('');
        setApiKeyRef('');
        setDefaultModel(PROVIDER_OPTIONS[0].defaultModel);
        setEnabled(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            const isCustom = provider === 'custom';
            const submittedProvider = isCustom ? customProviderId.trim() : provider;
            const { response, error } = await client.POST('/v1/llm/providers', {
                body: {
                    provider: submittedProvider,
                    api_key_ref: apiKeyRef,
                    default_model: defaultModel,
                    base_url: isCustom ? baseUrl.trim() : undefined,
                    display_name: isCustom ? (displayName.trim() || undefined) : undefined,
                    enabled,
                },
            });

            if (error) {
                console.error("Form submission error", error);
                toast.error('Failed to add provider');
            } else if (response.ok) {
                toast.success('LLM provider added successfully');
                onSuccess();
                onClose();
                resetForm();
            }
        } catch (err) {
            console.error("Unexpected error", err);
            toast.error('An unexpected error occurred');
        } finally {
            setIsSubmitting(false);
        }
    };

    const isCustom = provider === 'custom';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
                <div className="flex justify-between items-center p-4 border-b">
                    <h2 className="text-lg font-semibold">Add LLM Provider</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                        <select
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            value={provider}
                            onChange={(e) => handleProviderChange(e.target.value)}
                        >
                            {PROVIDER_OPTIONS.map(p => (
                                <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">API Key Reference</label>
                        <input
                            type="password"
                            required
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            value={apiKeyRef}
                            onChange={(e) => setApiKeyRef(e.target.value)}
                            placeholder="sk-... or env:OPENAI_API_KEY"
                        />
                        <p className="text-xs text-gray-500 mt-1">API key or environment variable reference for this provider.</p>
                    </div>

                    {isCustom && (
                        <>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Provider ID</label>
                                <input
                                    type="text"
                                    required
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    value={customProviderId}
                                    onChange={(e) => setCustomProviderId(e.target.value)}
                                    placeholder="e.g. ollama-local"
                                />
                                <p className="text-xs text-gray-500 mt-1">Slug used as the provider identifier in API requests and routing rules.</p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
                                <input
                                    type="text"
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    value={displayName}
                                    onChange={(e) => setDisplayName(e.target.value)}
                                    placeholder="e.g. Ollama Local"
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
                                <input
                                    type="url"
                                    required
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                                    value={baseUrl}
                                    onChange={(e) => setBaseUrl(e.target.value)}
                                    placeholder="http://localhost:11434/v1"
                                />
                            </div>
                        </>
                    )}

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Default Model</label>
                        <input
                            type="text"
                            required
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-oxblood"
                            value={defaultModel}
                            onChange={(e) => setDefaultModel(e.target.value)}
                            placeholder="e.g. gpt-5.2"
                        />
                    </div>

                    <div className="flex items-center gap-2">
                        <input
                            type="checkbox"
                            id="provider-enabled"
                            checked={enabled}
                            onChange={(e) => setEnabled(e.target.checked)}
                            className="rounded"
                        />
                        <label htmlFor="provider-enabled" className="text-sm text-gray-700">Enable provider immediately</label>
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
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? 'Adding...' : 'Add Provider'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
