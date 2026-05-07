import React, { useState } from 'react';
import { Star, Send } from 'lucide-react';
import { toast } from 'sonner';
import { client } from '../../lib/api/client';

interface FeedbackFormProps {
    sessionId: string;
}

export const FeedbackForm: React.FC<FeedbackFormProps> = ({ sessionId }) => {
    const [rating, setRating] = useState(0);
    const [feedback, setFeedback] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isSubmitted, setIsSubmitted] = useState(false);

    const handleSubmit = async () => {
        if (rating === 0) return;

        setIsSubmitting(true);
        try {
            const { error } = await client.POST('/v1/query/sessions/{sessionId}/feedback', {
                params: { path: { sessionId } },
                body: {
                    rating: rating,
                    feedback_text: feedback,
                }
            });

            if (error) {
                toast.error("Failed to submit feedback");
            } else {
                toast.success("Feedback submitted!");
                setIsSubmitted(true);
            }
        } catch (err) {
            console.error(err);
            toast.error("An error occurred");
        } finally {
            setIsSubmitting(false);
        }
    };

    if (isSubmitted) {
        return (
            <div className="p-4 bg-gray-50 border-t border-gray-200 text-center text-sm text-gray-500">
                Thank you for your feedback!
            </div>
        );
    }

    return (
        <div className="p-4 bg-gray-50 border-t border-gray-200">
            <div className="flex items-center gap-4 mb-2">
                <span className="text-sm font-medium text-gray-700">Rate this result:</span>
                <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((star) => (
                        <button
                            key={star}
                            onClick={() => setRating(star)}
                            className={`transition-colors focus:outline-none ${rating >= star ? 'text-yellow-400' : 'text-gray-300 hover:text-gray-400'}`}
                        >
                            <Star size={20} fill={rating >= star ? "currentColor" : "none"} />
                        </button>
                    ))}
                </div>
            </div>

            {rating > 0 && (
                <div className="flex gap-2 mt-2">
                    <input
                        type="text"
                        placeholder="Optional comments..."
                        className="flex-1 text-sm rounded-md border-gray-300 px-3 py-1.5 focus:border-oxblood focus:ring-oxblood border"
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                    />
                    <button
                        onClick={handleSubmit}
                        disabled={isSubmitting}
                        className="px-3 py-1.5 bg-oxblood text-white text-sm rounded-md hover:bg-oxblood-deep disabled:opacity-50 flex items-center gap-1"
                    >
                        {isSubmitting ? '...' : <Send size={14} />}
                        Submit
                    </button>
                </div>
            )}
        </div>
    );
};
