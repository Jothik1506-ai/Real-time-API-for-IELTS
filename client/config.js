// Environment configuration for Vercel Serverless
const ENV = {
    // Empty string defaults to making relative path requests starting with /api
    // so both localhost:3000 and the deployed Vercel app hit their own endpoints
    BACKEND_URL: ''
};

// Export configuration globally
window.ENV = ENV;

// Log current environment (helpful for debugging)
console.log('Environment:', window.location.hostname.includes('localhost') || window.location.hostname === '127.0.0.1' ? 'Development' : 'Production');
console.log('Backend URL: Vercel Serverless Functions (Relative)');
