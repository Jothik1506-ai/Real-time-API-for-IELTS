import { ChromaClient } from 'chromadb';
// path and fileURLToPath imports removed as they are no longer needed


// __filename and __dirname definitions removed as they are no longer needed


// Initialize ChromaDB client
const client = new ChromaClient({
    path: process.env.CHROMA_DB_URL || 'http://localhost:8000'
});

let collection = null;

/**
 * Initialize or get the ChromaDB collection
 * @returns {Promise<Collection>} ChromaDB collection
 */
export async function getCollection() {
    if (collection) {
        return collection;
    }

    try {
        console.log(`Connecting to ChromaDB at ${process.env.CHROMA_DB_URL || 'http://localhost:8000'}...`);
        
        // Try to get existing collection with a short timeout check
        // ChromaClient doesn't have a built-in timeout, so we handle the error
        collection = await client.getOrCreateCollection({
            name: 'ielts_materials',
            metadata: { description: 'IELTS learning materials and examples' }
        });

        console.log('✓ ChromaDB collection initialized');
        return collection;
    } catch (error) {
        console.error('✗ ChromaDB Error:', error.message);
        collection = null; // Ensure we try again next time
        throw new Error(`Vector store unavailable: ${error.message}`);
    }
}

/**
 * Add documents to the vector store
 * @param {Array<string>} chunks - Text chunks
 * @param {Array<Array<number>>} embeddings - Embeddings for chunks
 * @param {string} documentId - Unique document identifier
 * @param {Object} metadata - Document metadata
 * @returns {Promise<void>}
 */
export async function addDocuments(chunks, embeddings, documentId, metadata = {}) {
    try {
        const coll = await getCollection();

        // Create unique IDs for each chunk
        const ids = chunks.map((_, index) => `${documentId}_chunk_${index}`);

        // Create metadata for each chunk
        const metadatas = chunks.map((chunk, index) => ({
            documentId,
            chunkIndex: index,
            totalChunks: chunks.length,
            fileName: metadata.fileName || 'unknown',
            uploadedAt: metadata.uploadedAt || new Date().toISOString(),
            text: chunk // Store the actual text in metadata for retrieval
        }));

        // Add to ChromaDB
        await coll.add({
            ids,
            embeddings,
            metadatas,
            documents: chunks
        });

        console.log(`✓ Added ${chunks.length} chunks from document ${documentId}`);
    } catch (error) {
        console.error('Error adding documents to vector store:', error);
        throw error;
    }
}

/**
 * Search for similar documents
 * @param {Array<number>} queryEmbedding - Query embedding vector
 * @param {number} nResults - Number of results to return (default: 5)
 * @returns {Promise<Object>} Search results
 */
export async function searchSimilar(queryEmbedding, nResults = 5) {
    try {
        const coll = await getCollection();

        const results = await coll.query({
            queryEmbeddings: [queryEmbedding],
            nResults
        });

        // Format results
        const formattedResults = [];
        if (results.ids && results.ids[0]) {
            for (let i = 0; i < results.ids[0].length; i++) {
                formattedResults.push({
                    id: results.ids[0][i],
                    text: results.documents[0][i],
                    metadata: results.metadatas[0][i],
                    distance: results.distances[0][i]
                });
            }
        }

        return formattedResults;
    } catch (error) {
        console.error('Error searching vector store:', error);
        throw error;
    }
}

/**
 * Delete a document and all its chunks
 * @param {string} documentId - Document ID to delete
 * @returns {Promise<void>}
 */
export async function deleteDocument(documentId) {
    try {
        const coll = await getCollection();

        // Get all chunk IDs for this document
        const results = await coll.get({
            where: { documentId }
        });

        if (results.ids && results.ids.length > 0) {
            await coll.delete({
                ids: results.ids
            });
            console.log(`✓ Deleted document ${documentId} (${results.ids.length} chunks)`);
        }
    } catch (error) {
        console.error('Error deleting document:', error);
        throw error;
    }
}

/**
 * List all documents in the collection
 * @returns {Promise<Array>} List of unique documents
 */
export async function listDocuments() {
    try {
        const coll = await getCollection();

        const results = await coll.get();

        // Group by documentId
        const documentsMap = new Map();

        if (results.metadatas) {
            results.metadatas.forEach(metadata => {
                if (!documentsMap.has(metadata.documentId)) {
                    documentsMap.set(metadata.documentId, {
                        documentId: metadata.documentId,
                        fileName: metadata.fileName,
                        uploadedAt: metadata.uploadedAt,
                        totalChunks: metadata.totalChunks
                    });
                }
            });
        }

        return Array.from(documentsMap.values());
    } catch (error) {
        console.error('Error listing documents:', error);
        throw error;
    }
}

/**
 * Get collection statistics
 * @returns {Promise<Object>} Collection stats
 */
export async function getStats() {
    try {
        const coll = await getCollection();
        const count = await coll.count();
        const documents = await listDocuments();

        return {
            totalChunks: count,
            totalDocuments: documents.length,
            documents
        };
    } catch (error) {
        console.error('Error getting stats:', error);
        throw error;
    }
}
