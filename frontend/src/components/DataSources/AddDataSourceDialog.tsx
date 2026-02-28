import React, { useState, useRef } from 'react';
import { X, Upload } from 'lucide-react';
import { client } from '../../lib/api/client';
import { readSqlFile } from '../../lib/readSqlFile';
import { toast } from 'sonner';

interface AddDataSourceDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onSuccess: () => void;
}

type SchemaMethod = 'introspect' | 'import';

export const AddDataSourceDialog: React.FC<AddDataSourceDialogProps> = ({ isOpen, onClose, onSuccess }) => {
    const [name, setName] = useState('');
    const [dbType, setDbType] = useState<'postgres' | 'mssql'>('postgres');
    const [connectionRef, setConnectionRef] = useState('');
    const [schemaMethod, setSchemaMethod] = useState<SchemaMethod>('introspect');
    const [schemaFile, setSchemaFile] = useState<File | null>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);

        try {
            const { data, error } = await client.POST('/v1/data-sources', {
                body: {
                    name,
                    db_type: dbType,
                    connection_ref: connectionRef,
                },
            });

            if (error) {
                console.error("Form submission error", error);
                return;
            }

            const dataSourceId = data?.id;

            if (schemaMethod === 'import' && schemaFile && dataSourceId) {
                const ddlText = await readSqlFile(schemaFile);
                const { error: importError } = await client.POST(
                    '/v1/data-sources/{dataSourceId}/import-schema',
                    {
                        params: { path: { dataSourceId } },
                        body: { ddl: ddlText },
                    }
                );

                if (importError) {
                    toast.warning('Data source created, but schema import failed. You can retry from the data sources page.');
                } else {
                    toast.success('Data source added and schema imported successfully');
                }
            } else {
                toast.success('Data source added successfully');
            }

            onSuccess();
            onClose();
            setName('');
            setConnectionRef('');
            setSchemaMethod('introspect');
            setSchemaFile(null);
        } catch (err) {
            console.error("Unexpected error", err);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0] || null;
        setSchemaFile(file);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col">
                <div className="flex justify-between items-center p-4 border-b">
                    <h2 className="text-lg font-semibold">Add Data Source</h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>

                <div className="p-4 overflow-y-auto flex-1">
                    <form id="add-data-source-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                                onChange={(e) => {
                                    setDbType(e.target.value as 'postgres' | 'mssql');
                                    if (e.target.value !== 'mssql') {
                                        setSchemaMethod('introspect');
                                        setSchemaFile(null);
                                    }
                                }}
                            >
                                <option value="postgres">PostgreSQL</option>
                                <option value="mssql">MS SQL Server</option>
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
                                placeholder={
                                    dbType === 'mssql'
                                        ? 'Server=172.28.64.1,1433;Database=AdventureWorks2022;User Id=report_pilot;Password=...;Encrypt=True;TrustServerCertificate=True;'
                                        : 'postgresql://user:password@host:5432/database'
                                }
                            />
                            <p className="text-xs text-gray-500 mt-1">Paste a full database connection string for the selected engine.</p>
                        </div>

                        {dbType === 'mssql' && (
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">Schema Method</label>
                                <div className="flex flex-col gap-2">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="schemaMethod"
                                            value="introspect"
                                            checked={schemaMethod === 'introspect'}
                                            onChange={() => {
                                                setSchemaMethod('introspect');
                                                setSchemaFile(null);
                                            }}
                                            className="text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700">Auto-introspect (extract from database)</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input
                                            type="radio"
                                            name="schemaMethod"
                                            value="import"
                                            checked={schemaMethod === 'import'}
                                            onChange={() => setSchemaMethod('import')}
                                            className="text-blue-600"
                                        />
                                        <span className="text-sm text-gray-700">Import schema (upload DDL file)</span>
                                    </label>
                                </div>

                                {schemaMethod === 'import' && (
                                    <div className="mt-3">
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".sql,.txt"
                                            onChange={handleFileChange}
                                            className="hidden"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => fileInputRef.current?.click()}
                                            className="flex items-center gap-2 w-full rounded-md border border-dashed border-gray-300 px-3 py-3 text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 transition"
                                        >
                                            <Upload size={16} />
                                            {schemaFile ? schemaFile.name : 'Choose .sql file from SSMS Generate Scripts...'}
                                        </button>
                                        <p className="text-xs text-gray-500 mt-1">
                                            Export schema from SSMS: right-click database &rarr; Tasks &rarr; Generate Scripts &rarr; Schema Only.
                                        </p>
                                    </div>
                                )}
                            </div>
                        )}
                    </form>
                </div>

                <div className="border-t p-4 bg-gray-50 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
                        disabled={isSubmitting}
                    >
                        Cancel
                    </button>
                    <button
                        form="add-data-source-form"
                        type="submit"
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50"
                        disabled={isSubmitting || (schemaMethod === 'import' && dbType === 'mssql' && !schemaFile)}
                    >
                        {isSubmitting ? 'Adding...' : 'Add Data Source'}
                    </button>
                </div>
            </div>
        </div>
    );
};
