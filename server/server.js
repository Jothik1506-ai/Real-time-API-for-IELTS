import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import fs from 'fs/promises';
import session from 'express-session';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// RAG System utilities
import { processPDF } from './utils/pdfProcessor.js';
import { addDocuments, deleteDocument, listDocuments, getStats } from './utils/vectorStore.js';
import { retrieveContext, formatContextForAI } from './utils/retriever.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"], // Allow inline scripts for now (e.g. upload.js)
      "img-src": ["'self'", "data:", "blob:"],
      "media-src": ["'self'", "data:", "blob:"],
      "connect-src": ["'self'", "https://api.openai.com"]
    }
  }
}));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per windowMs
  message: 'Too many login attempts, please try again later'
});

// Session Configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'ielts-bot-secret-key-' + Date.now(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true in production
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Standard Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Helper function to get API Key
function getApiKey(req) {
  return req.session.openaiKey || process.env.OPENAI_API_KEY;
}

// Authentication Middleware
function requireApiKey(req, res, next) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    return res.status(401).json({
      error: 'API key not configured',
      message: 'Please provide your OpenAI API key to continue'
    });
  }
  next();
}

// ============================================
// AUTHENTICATION ENDPOINTS
// ============================================

// POST /api/auth/key - Validate and store API key
app.post('/api/auth/key', authLimiter, (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'Invalid API key format' });
  }

  if (!apiKey.startsWith('sk-')) {
    return res.status(400).json({ error: 'API key must start with "sk-"' });
  }

  // Store in session
  req.session.openaiKey = apiKey;

  res.json({
    success: true,
    message: 'API key validated and stored in session'
  });
});

// POST /api/auth/clear - Clear API key from session
app.post('/api/auth/clear', (req, res) => {
  req.session.openaiKey = null;
  res.json({
    success: true,
    message: 'API key cleared from session'
  });
});

// GET /api/auth/status - Check if key is configured
app.get('/api/auth/status', (req, res) => {
  res.json({
    configured: !!getApiKey(req),
    usingEnv: !req.session.openaiKey && !!process.env.OPENAI_API_KEY
  });
});

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Serve static files from client directory
app.use(express.static(path.join(__dirname, '../client')));

// IELTS Examiner Instructions
const IELTS_INSTRUCTIONS = `You are an IELTS Speaking Examiner and Coach conducting a comprehensive 3-part IELTS speaking interview.

**Your Role:**
- Conduct a structured IELTS speaking test (Part 1, Part 2, Part 3)
- Ask ONE question at a time
- Listen carefully to the candidate's answer
- Provide constructive feedback after each answer
- Give a sample answer to demonstrate excellence
- Maintain an encouraging, professional tone

**Interview Structure:**

**Part 1 (4-5 minutes):** Introduction and familiar topics
- Introduce yourself briefly
- Ask about familiar topics: home, family, work, studies, hobbies, interests
- Ask 2-3 questions per topic, covering 2-3 topics total

**Part 2 (3-4 minutes):** Individual long turn
- Give a task card with a topic and points to cover
- Allow 1 minute preparation time (mention this)
- Ask candidate to speak for 1-2 minutes
- Ask 1-2 follow-up questions

**Part 3 (4-5 minutes):** Discussion of abstract ideas
- Ask questions related to Part 2 topic but more abstract/analytical
- Explore ideas, opinions, and speculation
- 4-5 questions with deeper discussion

**After Each Answer:**
1. **Brief Feedback** (2-3 sentences):
   - Estimated band score (e.g., "This response shows Band 6-6.5 level")
   - Strengths in: Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, Pronunciation
   
2. **2-3 Specific Improvements:**
   - Point out specific areas to improve
   - Give concrete examples

3. **Strong Sample Answer:**
   - Provide a Band 8-9 level answer to the same question
   - Demonstrate advanced vocabulary and structures

4. **Next Question:**
   - Move to the next question in the current part
   - Transition smoothly between parts

**Important Guidelines:**
- Keep feedback CONCISE but valuable
- Be encouraging and supportive
- Speak clearly and at natural pace
- Use the candidate's name if provided
- Track which part you're in and progress accordingly
- End the interview after Part 3 is complete

Start by introducing yourself and beginning Part 1.`;

// ============================================
// RAG SYSTEM API ENDPOINTS
// ============================================

// POST /api/upload-pdf - Upload and process PDF
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    console.log(`\n📄 Processing uploaded PDF: ${req.file.originalname}`);

    // Process PDF
    const result = await processPDF(req.file.path, req.file.originalname, getApiKey(req));

    // Generate unique document ID
    const documentId = `doc_${Date.now()}`;

    // Add to vector store
    await addDocuments(
      result.chunks,
      result.embeddings,
      documentId,
      {
        fileName: req.file.originalname,
        uploadedAt: new Date().toISOString()
      }
    );

    console.log(`✓ Successfully processed and stored ${req.file.originalname}`);

    res.json({
      success: true,
      documentId,
      fileName: req.file.originalname,
      chunks: result.chunks.length,
      message: 'PDF processed and added to knowledge base'
    });

  } catch (error) {
    console.error('Error uploading PDF:', error);
    res.status(500).json({
      error: 'Failed to process PDF',
      message: error.message
    });
  }
});

// GET /api/materials - List all uploaded materials
app.get('/api/materials', async (req, res) => {
  try {
    const documents = await listDocuments();
    res.json({
      success: true,
      count: documents.length,
      materials: documents
    });
  } catch (error) {
    console.error('Error listing materials:', error);
    res.status(500).json({
      error: 'Failed to list materials',
      message: error.message
    });
  }
});

// DELETE /api/materials/:id - Delete a material
app.delete('/api/materials/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await deleteDocument(id);

    res.json({
      success: true,
      message: `Material ${id} deleted successfully`
    });
  } catch (error) {
    console.error('Error deleting material:', error);
    res.status(500).json({
      error: 'Failed to delete material',
      message: error.message
    });
  }
});

// GET /api/materials/stats - Get statistics
app.get('/api/materials/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({
      error: 'Failed to get stats',
      message: error.message
    });
  }
});

// POST /api/search - Test semantic search
app.post('/api/search', async (req, res) => {
  try {
    const { query, topK = 3 } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const context = await retrieveContext(query, topK, getApiKey(req));

    res.json({
      success: true,
      query,
      hasContext: context.hasContext,
      sources: context.sources,
      results: context.results
    });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

// ============================================
// REALTIME API ENDPOINTS
// ============================================


// POST /api/realtime/call - Create WebRTC session with OpenAI
app.post('/api/realtime/call', requireApiKey, async (req, res) => {
  try {
    const { config = {} } = req.body;
    const apiKey = getApiKey(req);

    // Retrieve context from materials if available
    let enhancedInstructions = config.instructions || IELTS_INSTRUCTIONS;
    let materialContext = null;

    try {
      // Get initial context (can be enhanced with conversation history later)
      const initialQuery = "IELTS speaking test questions and examples";
      materialContext = await retrieveContext(initialQuery, 3, apiKey);

      if (materialContext.hasContext) {
        const formattedContext = formatContextForAI(materialContext);
        enhancedInstructions = enhancedInstructions + formattedContext;
        console.log(`✓ Injected context from ${materialContext.sources.length} material(s)`);
      } else {
        console.log('ℹ No materials available, using base instructions');
      }
    } catch (error) {
      console.warn('Warning: Could not retrieve context from materials:', error.message);
      // Continue without materials
    }

    // Prepare session configuration
    const sessionConfig = {
      model: config.model || 'gpt-4o-mini-realtime-preview-2024-12-17',
      voice: config.voice || 'alloy',
      instructions: enhancedInstructions,
      modalities: ['audio', 'text'],
      turn_detection: {
        type: 'server_vad',
        threshold: 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 500
      },
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'whisper-1'
      },
      temperature: 0.8,
      max_response_output_tokens: 4096
    };

    console.log('Creating Realtime session with OpenAI...');
    console.log('Model:', sessionConfig.model);
    console.log('Voice:', sessionConfig.voice);

    // Call OpenAI Realtime API with JSON body
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sessionConfig)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API Error:', response.status, errorText);
      return res.status(response.status).json({
        error: 'Failed to create Realtime session',
        details: errorText
      });
    }

    const data = await response.json();
    console.log('Session created successfully');
    console.log('Session ID:', data.id);

    // Return session data to client
    res.json({
      sessionId: data.id,
      clientSecret: data.client_secret,
      expiresAt: data.expires_at
    });

  } catch (error) {
    console.error('Error creating Realtime session:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    openaiConfigured: !!process.env.OPENAI_API_KEY
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 IELTS Realtime Server running on http://localhost:${PORT}`);
  console.log(`📝 OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`\n💡 Open http://localhost:${PORT} in your browser to start\n`);
});
