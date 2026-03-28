// Environment configuration for production deployment
const ENV = {
    // Automatically detect environment and use appropriate backend URL
    BACKEND_URL: window.location.hostname === 'localhost'
        ? 'http://localhost:3000'
        : 'https://YOUR-RENDER-URL.onrender.com' // TODO: Replace with your actual Render URL after deployment
};

// Export configuration globally
window.ENV = ENV;

// Log current environment (helpful for debugging)
console.log('Environment:', window.location.hostname === 'localhost' ? 'Development' : 'Production');
console.log('Backend URL:', ENV.BACKEND_URL);
