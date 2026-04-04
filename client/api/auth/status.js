export default function handler(req, res) {
  // Add CORS headers for local dev parity
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  res.status(200).json({
    configured: !!process.env.OPENAI_API_KEY,
    usingEnv: !!process.env.OPENAI_API_KEY
  });
}
