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
      "connect-src": ["'self'", "https://api.openai.com", "https://*.openai.com", "wss://*.openai.com"]
    }
  }
}));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // Limit each IP to 20 requests per windowMs
  message: 'Too many login attempts, please try again later'
});

// Session Configuration - Enhanced for production proxy
app.set('trust proxy', 1); // Enable trusting the proxy (e.g. Render/Heroku)
app.use(session({
  secret: process.env.SESSION_SECRET || 'ielts-bot-secret-key-' + Date.now(),
  resave: false,
  saveUninitialized: false,
  proxy: true, // Required for secure cookies behind proxy
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// CORS Configuration for production
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : ['http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200
};

// Standard Middleware
app.use(cors(corsOptions));
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

  const cleanKey = apiKey.trim();
  if (!cleanKey.startsWith('sk-')) {
    return res.status(400).json({ error: 'API key must start with "sk-"' });
  }

  // Store in session
  req.session.openaiKey = cleanKey;

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
  const apiKey = getApiKey(req);
  res.json({
    configured: !!apiKey,
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
const IELTS_INSTRUCTIONS = `You are Mona, an IELTS Speaking Examiner and Coach conducting a comprehensive 3-part IELTS speaking interview.

**CRITICAL RULE — ONE TURN AT A TIME:**
- You MUST ask only ONE question per response, then STOP and WAIT for the candidate to answer.
- NEVER script the candidate's reply. NEVER use placeholders like "[Candidate responds]" or "[Your name]".
- NEVER continue to the next question in the same response. Wait for the candidate to actually speak.
- Each of your responses must end with a single question or a single instruction, then silence.

**CRITICAL RULE — SESSION MEMORY:**
- You MUST remember EVERYTHING the candidate says throughout the entire conversation.
- When the candidate tells you their name, STORE IT and use it consistently for the rest of the session. Address them BY NAME in every response.
- Remember their hometown, job, hobbies, interests, and all other details they share. Reference these details naturally in follow-up questions and feedback.
- If the candidate said their name is "Rahul", you must call them "Rahul" in every subsequent response — NEVER forget it or ask again.
- Build on previous answers: "Earlier you mentioned you enjoy cooking — how does that connect to..."

**Your Role:**
- Introduce yourself as "Mona" at the beginning
- Conduct a structured IELTS speaking test (Part 1, Part 2, Part 3)
- **CRITICAL: Actively listen, REMEMBER, and USE the details the candidate shares (e.g., their name, hometown, job, hobbies). Acknowledge their specific answers naturally before moving to the next topic.**
- Provide constructive feedback after each answer
- Give a sample answer to demonstrate excellence
- Maintain an encouraging, professional tone

**Interview Structure:**

**Part 1 (4-5 minutes):** Introduction and familiar topics
- First, introduce yourself and ask for their full name. Then STOP and WAIT.
- After they reply with their name, greet them by name and ask where they are from or what they do. Then STOP and WAIT.
- Ask 2-3 questions per topic, covering 2-3 topics total
- Only ask the next question AFTER the candidate has answered the current one and you have given feedback

**Part 2 (3-4 minutes):** Individual long turn
- Give a task card with a topic and points to cover (incorporate their interests if known)
- Allow 1 minute preparation time (mention this)
- Ask candidate to speak for 1-2 minutes
- Ask 1-2 follow-up questions

**Part 3 (4-5 minutes):** Discussion of abstract ideas
- Ask questions related to Part 2 topic but more abstract/analytical
- Explore ideas, opinions, and speculation
- 4-5 questions with deeper discussion

**After Each Answer (except the name introduction):**
1. **Acknowledge & Feedback** (2-3 sentences):
   - Acknowledge their specific answer (e.g., "Hyderabad sounds like a vibrant city...").
   - Estimated band score (e.g., "This response shows Band 6-6.5 level")
   - Strengths/weaknesses: Fluency, Lexical Resource, Grammar, Pronunciation

2. **2-3 Specific Improvements:**
   - Point out specific areas to improve
   - Give concrete examples

3. **Strong Sample Answer:**
   - Provide a Band 8-9 level answer to the SAME question, tailored to their context if possible.

4. **Next Question:**
   - Ask ONE follow-up or next question logically connected to the conversation, then STOP.

**Important Guidelines:**
- Keep feedback CONCISE but highly personalized to their actual answer.
- Be encouraging and supportive
- Speak clearly and at natural pace
- ALWAYS wait for the candidate to respond before moving on
- End the interview gracefully after Part 3 is complete

Start by introducing yourself as Mona and asking for the candidate's full name. Say ONLY the introduction and the name question, nothing else.`;

// ============================================
// RAG SYSTEM API ENDPOINTS
// ============================================

// POST /api/upload-pdf - Upload and process PDF
app.post('/api/upload-pdf', upload.single('pdf'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const apiKey = getApiKey(req);
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required for PDF processing' });
    }

    console.log(`\n📄 Processing uploaded PDF: ${req.file.originalname}`);

    // Process PDF
    const result = await processPDF(req.file.path, req.file.originalname, apiKey);

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
    next(error);
  }
});

// GET /api/materials - List all uploaded materials
app.get('/api/materials', async (req, res, next) => {
  try {
    const documents = await listDocuments();
    res.json({
      success: true,
      count: documents.length,
      materials: documents
    });
  } catch (error) {
    next(error);
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
app.get('/api/materials/stats', async (req, res, next) => {
  try {
    const stats = await getStats();
    res.json({
      success: true,
      stats
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/search - Test semantic search
app.post('/api/search', async (req, res, next) => {
  try {
    const { query, topK = 3 } = req.body;
    const apiKey = getApiKey(req);

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }
    if (!apiKey) {
      return res.status(401).json({ error: 'API key required for search' });
    }

    const context = await retrieveContext(query, topK, apiKey);

    res.json({
      success: true,
      query,
      hasContext: context.hasContext,
      sources: context.sources,
      results: context.results
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// REALTIME API ENDPOINTS
// ============================================


// POST /api/realtime/call - Create WebRTC session with OpenAI
app.post('/api/realtime/call', async (req, res, next) => {
  try {
    const { config = {}, apiKey } = req.body;
    
    // 1. Validation & Fallback logic (BONUS)
    // Prefer user-provided API key, fallback to server session or process.env for paid users
    const resolvedApiKey = apiKey || getApiKey(req);

    if (!resolvedApiKey) {
      return res.status(400).json({ error: 'OpenAI API key is required' });
    }
    
    if (!resolvedApiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid API key format. Must start with "sk-"' });
    }

    // Retrieve context from materials if available
    let enhancedInstructions = config.instructions || IELTS_INSTRUCTIONS;
    let materialContext = null;

    try {
      // Get initial context (can be enhanced with conversation history later)
      const initialQuery = "IELTS speaking test questions and examples";
      materialContext = await retrieveContext(initialQuery, 3, resolvedApiKey);

      if (materialContext.hasContext) {
        const formattedContext = formatContextForAI(materialContext);
        enhancedInstructions = enhancedInstructions + formattedContext;
        console.log(`✓ Injected context from ${materialContext.sources.length} material(s)`);
      } else {
        console.log('ℹ No materials available or ChromaDB unreachable');
      }
    } catch (error) {
      console.warn('Warning: Could not retrieve context from materials:', error.message);
    }

    // Prepare session configuration
    const sessionConfig = {
      model: config.model || 'gpt-4o-realtime-preview-2024-12-17',
      voice: config.voice || 'alloy',
      instructions: enhancedInstructions,
      modalities: ['audio', 'text'],
      turn_detection: null, // Disabled — using manual push-to-talk instead
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'whisper-1'
      },
      temperature: 0.6,
      max_response_output_tokens: 4096
    };

    console.log(`Creating Realtime session for model: ${sessionConfig.model}`);

    // Call OpenAI Realtime API
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resolvedApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sessionConfig)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: { message: 'Unexpected response from OpenAI' } }));
      console.error('OpenAI API Error:', response.status, errorData);
      return res.status(response.status).json({
        error: 'Failed to create Realtime session',
        details: errorData.error?.message || 'Check your API key and quota'
      });
    }

    const data = await response.json();
    
    // Return essential data to client
    res.json({
      sessionId: data.id,
      clientSecret: data.client_secret,
      expiresAt: data.expires_at,
      model: data.model
    });

  } catch (error) {
    next(error);
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('SERVER ERROR:', err);
  res.status(err.status || 500).json({
    error: err.name || 'ServerError',
    message: err.message || 'An internal server error occurred',
    path: req.path
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 IELTS Realtime Server running on http://localhost:${PORT}`);
  console.log(`📝 OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✓ Configured' : '✗ Missing'}`);
  console.log(`\n💡 Open http://localhost:${PORT} in your browser to start\n`);
});
