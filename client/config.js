// Environment configuration for production deployment
const ENV = {
    // Automatically detect environment and use appropriate backend URL
    BACKEND_URL: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'http://localhost:3000'
        : window.location.origin // Default to the same origin for production if not specified
};

// Check if we need to override the backend URL for specific deployments (e.g. Render/Vercel split)
if (window.location.hostname.includes('vercel.app')) {
    // If you have a specific Render URL, you can put it here or let the user configure it
    // ENV.BACKEND_URL = 'https://your-app.onrender.com';
}

// Export configuration globally
window.ENV = ENV;

// Log current environment (helpful for debugging)
console.log('Environment:', window.location.hostname.includes('localhost') ? 'Development' : 'Production');
console.log('Backend URL:', ENV.BACKEND_URL);
