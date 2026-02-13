import React, { useState } from 'react';
import { X } from 'lucide-react';
import { client } from '../../lib/api/client';
import { toast } from 'sonner';

interface AddDataSourceDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

export const AddDataSourceDialog: React.FC<AddDataSourceDialogProps> = ({ isOpen, onClose, onSuccess }) => {
    const [name, setName] = useState('');
    const [dbType, setDbType] = useState<'postgres'>('postgres');
    const [connectionRef, setConnectionRef] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            const { response, error } = await client.POST('/v1/data-sources', {
                body: {
                    name,
                    db_type: dbType,
                    connection_ref: connectionRef,
                },
            });

            if (error) {
                // Error is handled by global interceptor, but we can stop loading here
                console.error("Form submission error", error);
            } else if (response.ok) {
                toast.success('Data source added successfully');
                onSuccess();
                onClose();
                // Reset form
                setName('');
                setConnectionRef('');
            }
        } catch (err) {
            console.error("Unexpected error", err);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden">
                <div className="flex justify-between items-center p-4 border-b">
                    <h2 className="text-lg font-semibold">Add Data Source</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                        <input
                            type="text"
                            required
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Production DB"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Database Type</label>
                        <select
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            value={dbType}
                            onChange={(e) => setDbType(e.target.value as 'postgres')}
                        >
                            <option value="postgres">PostgreSQL</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Connection String Reference</label>
                        <input
                            type="text"
                            required
                            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            value={connectionRef}
                            onChange={(e) => setConnectionRef(e.target.value)}
                            placeholder="env:DATABASE_URL"
                        />
                        <p className="text-xs text-gray-500 mt-1">Reference to an environment variable containing the connection string.</p>
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
                            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
                            disabled={isSubmitting}
                        >
                            {isSubmitting ? 'Adding...' : 'Add Data Source'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
