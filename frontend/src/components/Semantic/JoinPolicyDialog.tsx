import React, { useState } from 'react';
import { X, Save, Link as LinkIcon } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';


type JoinType = 'inner' | 'left' | 'right' | 'full';

interface JoinPolicyDialogProps {
    isOpen: boolean;
    onClose: () => void;
    dataSourceId: string;
}

export const JoinPolicyDialog: React.FC<JoinPolicyDialogProps> = ({
    isOpen,
    onClose,
    dataSourceId,
}) => {
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Form State
    const [leftRef, setLeftRef] = useState('');
    const [rightRef, setRightRef] = useState('');
    const [joinType, setJoinType] = useState<JoinType>('inner');
    const [onClause, setOnClause] = useState('');
    const [approved, setApproved] = useState(true);

    if (!isOpen) return null;

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsSubmitting(true);
        try {
            const { data, error } = await client.POST('/v1/join-policies', {
                body: {
                    data_source_id: dataSourceId,
                    left_ref: leftRef,
                    right_ref: rightRef,
                    join_type: joinType,
                    on_clause: onClause,
                    approved: approved,
                }
            });

            if (error) {
                console.error("Join policy save failed", error);
            } else if (data) {
                toast.success("Join policy saved");
                onClose();
                // Reset form
                setLeftRef('');
                setRightRef('');
                setJoinType('inner');
                setOnClause('');
            }
        } catch (err) {
            console.error("Unexpected error", err);
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-lg overflow-hidden flex flex-col">
                {/* Header */}
                <div className="flex justify-between items-center p-4 border-b">
                    <h2 className="text-lg font-semibold flex items-center gap-2">
                        <LinkIcon size={20} className="text-gray-500" />
                        Define Join Policy
                    </h2>
                    <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 overflow-y-auto">
                    <form id="join-form" onSubmit={handleSubmit} className="flex flex-col gap-4">

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Left Table Ref</label>
                                <input
                                    type="text"
                                    required
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    value={leftRef}
                                    onChange={(e) => setLeftRef(e.target.value)}
                                    placeholder="schema.table_a"
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Right Table Ref</label>
                                <input
                                    type="text"
                                    required
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    value={rightRef}
                                    onChange={(e) => setRightRef(e.target.value)}
                                    placeholder="schema.table_b"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-1">Join Type</label>
                                <select
                                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    value={joinType}
                                    onChange={(e) => setJoinType(e.target.value as JoinType)}
                                >
                                    <option value="inner">INNER JOIN</option>
                                    <option value="left">LEFT JOIN</option>
                                    <option value="right">RIGHT JOIN</option>
                                    <option value="full">FULL JOIN</option>
                                </select>
                            </div>
                            <div className="flex items-center pt-6">
                                <label className="flex items-center gap-2 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={approved}
                                        onChange={(e) => setApproved(e.target.checked)}
                                        className="rounded text-blue-600 focus:ring-blue-500"
                                    />
                                    <span className="text-sm font-medium text-gray-700">Approved</span>
                                </label>
                            </div>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">On Clause</label>
                            <textarea
                                required
                                rows={3}
                                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                                value={onClause}
                                onChange={(e) => setOnClause(e.target.value)}
                                placeholder="table_a.id = table_b.a_id"
                            />
                            <p className="text-xs text-gray-500 mt-1">SQL condition for the join.</p>
                        </div>
                    </form>
                </div>

                {/* Footer */}
                <div className="p-4 border-t bg-gray-50 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
                    >
                        Close
                    </button>
                    <button
                        type="submit"
                        form="join-form"
                        className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 flex items-center gap-2"
                        disabled={isSubmitting}
                    >
                        <Save size={16} />
                        {isSubmitting ? 'Saving...' : 'Save Policy'}
                    </button>
                </div>
            </div>
        </div>
    );
};
