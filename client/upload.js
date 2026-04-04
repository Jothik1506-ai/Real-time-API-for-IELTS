const API_BASE = window.ENV?.BACKEND_URL || window.location.origin;

// Load materials on page load
document.addEventListener('DOMContentLoaded', () => {
    // Logo Intro Animation
    document.body.classList.add('logo-intro');
    setTimeout(() => {
        document.body.classList.remove('logo-intro');
    }, 2000);

    loadMaterials();
    loadStats();
});

// Upload Form Handler
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const fileInput = document.getElementById('pdfFile');
    const uploadBtn = document.getElementById('uploadBtn');
    const statusDiv = document.getElementById('uploadStatus');

    if (!fileInput.files[0]) {
        showStatus('Please select a PDF file', 'error');
        return;
    }

    const formData = new FormData();
    formData.append('pdf', fileInput.files[0]);

    try {
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<span class="btn-icon">⏳</span> Processing...';
        statusDiv.innerHTML = '<p class="processing">Uploading and processing PDF...</p>';

        const response = await fetch(`${API_BASE}/api/upload-pdf`, {
            method: 'POST',
            credentials: 'include',
            body: formData
        });

        const data = await response.json();

        if (response.ok) {
            showStatus(`✓ Successfully processed ${data.fileName} (${data.chunks} chunks)`, 'success');
            fileInput.value = '';
            loadMaterials();
            loadStats();
        } else {
            showStatus(`✗ Error: ${data.error || data.message}`, 'error');
        }
    } catch (error) {
        showStatus(`✗ Upload failed: ${error.message}`, 'error');
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.innerHTML = '<span class="btn-icon">📄</span> Upload & Process';
    }
});

// Search Form Handler
document.getElementById('searchForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const query = document.getElementById('searchQuery').value;
    const resultsDiv = document.getElementById('searchResults');

    try {
        resultsDiv.innerHTML = '<p class="processing">Searching...</p>';

        const response = await fetch(`${API_BASE}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ query, topK: 3 })
        });

        const data = await response.json();

        if (response.ok) {
            displaySearchResults(data);
        } else {
            resultsDiv.innerHTML = `<p class="error">Search failed: ${data.error}</p>`;
        }
    } catch (error) {
        resultsDiv.innerHTML = `<p class="error">Search failed: ${error.message}</p>`;
    }
});

// Refresh Button
document.getElementById('refreshBtn').addEventListener('click', () => {
    loadMaterials();
    loadStats();
});

// Load Materials List
async function loadMaterials() {
    const listDiv = document.getElementById('materialsList');

    try {
        listDiv.innerHTML = '<p class="processing">Loading...</p>';

        const response = await fetch(`${API_BASE}/api/materials`, {
            credentials: 'include'
        });
        const data = await response.json();

        if (response.ok && data.materials.length > 0) {
            listDiv.innerHTML = data.materials.map(material => `
                <div class="material-item">
                    <div class="material-info">
                        <div class="material-name">📄 ${material.fileName}</div>
                        <div class="material-meta">
                            ${material.totalChunks} chunks • 
                            ${new Date(material.uploadedAt).toLocaleString()}
                        </div>
                    </div>
                    <button class="btn-icon-small delete-btn" onclick="deleteMaterial('${material.documentId}')">
                        🗑️
                    </button>
                </div>
            `).join('');
        } else {
            listDiv.innerHTML = '<p class="placeholder-text">No materials uploaded yet</p>';
        }
    } catch (error) {
        listDiv.innerHTML = `<p class="error">Failed to load materials: ${error.message}</p>`;
    }
}

// Load Stats
async function loadStats() {
    const statsDiv = document.getElementById('statsInfo');

    try {
        const response = await fetch(`${API_BASE}/api/materials/stats`, {
            credentials: 'include'
        });
        const data = await response.json();

        if (response.ok) {
            statsDiv.innerHTML = `
                <div class="stats-grid">
                    <div class="stat-item">
                        <div class="stat-value">${data.stats.totalDocuments}</div>
                        <div class="stat-label">Documents</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${data.stats.totalChunks}</div>
                        <div class="stat-label">Total Chunks</div>
                    </div>
                </div>
            `;
        }
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// Delete Material
async function deleteMaterial(documentId) {
    if (!confirm('Are you sure you want to delete this material?')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/materials/${documentId}`, {
            method: 'DELETE',
            credentials: 'include'
        });

        const data = await response.json();

        if (response.ok) {
            showStatus('✓ Material deleted successfully', 'success');
            loadMaterials();
            loadStats();
        } else {
            showStatus(`✗ Delete failed: ${data.error}`, 'error');
        }
    } catch (error) {
        showStatus(`✗ Delete failed: ${error.message}`, 'error');
    }
}

// Display Search Results
function displaySearchResults(data) {
    const resultsDiv = document.getElementById('searchResults');

    if (!data.hasContext || data.results.length === 0) {
        resultsDiv.innerHTML = '<p class="placeholder-text">No relevant results found</p>';
        return;
    }

    resultsDiv.innerHTML = `
        <div class="search-info">
            <strong>Found ${data.results.length} results from:</strong> ${data.sources.join(', ')}
        </div>
        ${data.results.map((result, index) => `
            <div class="search-result-item">
                <div class="result-header">
                    <span class="result-index">#${index + 1}</span>
                    <span class="result-source">${result.fileName}</span>
                    <span class="result-score">${(result.relevanceScore * 100).toFixed(1)}%</span>
                </div>
                <div class="result-text">${result.text.substring(0, 300)}${result.text.length > 300 ? '...' : ''}</div>
            </div>
        `).join('')}
    `;
}

// Show Status Message
function showStatus(message, type) {
    const statusDiv = document.getElementById('uploadStatus');
    statusDiv.innerHTML = `<p class="${type}">${message}</p>`;

    setTimeout(() => {
        statusDiv.innerHTML = '';
    }, 5000);
}
