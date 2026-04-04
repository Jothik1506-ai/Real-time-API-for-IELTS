import OpenAI from 'openai';
import { searchSimilar } from './vectorStore.js';

/**
 * Generate embedding for a query
 * @param {string} query - Query text
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<Array<number>>} Query embedding
 */
export async function generateQueryEmbedding(query, apiKey) {
    if (!apiKey) {
        throw new Error('API Key required for generating embeddings');
    }

    const openai = new OpenAI({ apiKey });

    try {
        const response = await openai.embeddings.create({
            model: 'text-embedding-3-small',
            input: query,
        });

        return response.data[0].embedding;
    } catch (error) {
        console.error('Error generating query embedding:', error);
        throw error;
    }
}

/**
 * Retrieve relevant context from materials based on query
 * @param {string} query - User query or conversation context
 * @param {number} topK - Number of results to retrieve (default: 3)
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<Object>} Retrieved context and sources
 */
export async function retrieveContext(query, topK = 3, apiKey) {
    try {
        // Check if vector store is available before spending API calls on embeddings
        const { getCollection } = await import('./vectorStore.js');
        try {
            const coll = await getCollection();
            const count = await coll.count();
            if (count === 0) {
                return { hasContext: false, context: '', sources: [] };
            }
        } catch (error) {
            // ChromaDB not running or unreachable
            console.warn('ℹ RAG fallback: Vector store unreachable, proceeding without context');
            return { hasContext: false, context: '', sources: [] };
        }

        // Generate embedding for query
        const queryEmbedding = await generateQueryEmbedding(query, apiKey);

        // Search for similar chunks
        const results = await searchSimilar(queryEmbedding, topK);

        if (results.length === 0) {
            return {
                hasContext: false,
                context: '',
                sources: []
            };
        }

        // Format context
        const contextParts = results.map((result, index) => {
            return `[Source ${index + 1}: ${result.metadata.fileName}]\n${result.text}`;
        });

        const context = contextParts.join('\n\n---\n\n');

        // Extract unique sources
        const sources = [...new Set(results.map(r => r.metadata.fileName))];

        return {
            hasContext: true,
            context,
            sources,
            results: results.map(r => ({
                text: r.text,
                fileName: r.metadata.fileName,
                chunkIndex: r.metadata.chunkIndex,
                relevanceScore: 1 - r.distance // Convert distance to similarity score
            }))
        };
    } catch (error) {
        console.error('Error retrieving context:', error);
        return {
            hasContext: false,
            context: '',
            sources: [],
            error: error.message
        };
    }
}

/**
 * Format context for injection into AI instructions
 * @param {Object} retrievedContext - Context from retrieveContext()
 * @returns {string} Formatted context string
 */
export function formatContextForAI(retrievedContext) {
    if (!retrievedContext.hasContext) {
        return '';
    }

    const header = `\n\n**AVAILABLE REFERENCE MATERIALS:**\n`;
    const sources = `Sources: ${retrievedContext.sources.join(', ')}\n\n`;
    const content = retrievedContext.context;
    const footer = `\n\n**INSTRUCTIONS FOR USING MATERIALS:**
- Use the above materials when relevant to the question
- Cite the source when using specific examples or information
- Combine material knowledge with general IELTS expertise
- Provide both material-based and general examples when appropriate\n`;

    return header + sources + content + footer;
}

/**
 * Check if a query is relevant to stored materials
 * @param {string} query - Query to check
 * @param {number} threshold - Relevance threshold (default: 0.7)
 * @param {string} apiKey - OpenAI API key
 * @returns {Promise<boolean>} Whether materials are relevant
 */
export async function hasRelevantMaterials(query, threshold = 0.7, apiKey) {
    try {
        const context = await retrieveContext(query, 1, apiKey);

        if (!context.hasContext || context.results.length === 0) {
            return false;
        }

        return context.results[0].relevanceScore >= threshold;
    } catch (error) {
        console.error('Error checking material relevance:', error);
        return false;
    }
}
