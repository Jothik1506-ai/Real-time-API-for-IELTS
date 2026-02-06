// ============================================
// IELTS Speaking Interview Bot - WebRTC Client
// ============================================

// Configuration
const CONFIG = {
    serverUrl: 'http://localhost:3000',
    model: 'gpt-4o-realtime-preview-2024-12-17',
    voice: 'alloy' // Options: alloy, echo, shimmer
};

// State Management
const state = {
    peerConnection: null,
    dataChannel: null,
    localStream: null,
    sessionId: null,
    currentPart: 1,
    turnCount: 0,
    isConnected: false,
    isTalking: false,
    isMuted: false,
    conversationHistory: []
};

// DOM Elements
const elements = {
    startButton: document.getElementById('startButton'),
    talkButton: document.getElementById('talkButton'),
    stopButton: document.getElementById('stopButton'),
    muteButton: document.getElementById('muteButton'),
    connectionStatus: document.getElementById('connectionStatus'),
    currentQuestion: document.getElementById('currentQuestion'),
    partBadge: document.getElementById('partBadge'),
    liveTranscript: document.getElementById('liveTranscript'),
    feedbackContent: document.getElementById('feedbackContent'),
    sampleAnswer: document.getElementById('sampleAnswer'),
    conversationLog: document.getElementById('conversationLog'),
    remoteAudio: document.getElementById('remoteAudio'),
    clearTranscript: document.getElementById('clearTranscript'),
    clearLog: document.getElementById('clearLog')
};

// ============================================
// Event Listeners
// ============================================

elements.startButton.addEventListener('click', startInterview);
elements.stopButton.addEventListener('click', stopInterview);
elements.muteButton.addEventListener('click', toggleMute);
elements.clearTranscript.addEventListener('click', () => {
    elements.liveTranscript.innerHTML = '<p class="placeholder-text">Your speech will appear here...</p>';
});
elements.clearLog.addEventListener('click', () => {
    elements.conversationLog.innerHTML = '';
    addLogEntry('system', 'Conversation log cleared');
});

// Push-to-talk: Press and hold
elements.talkButton.addEventListener('mousedown', startTalking);
elements.talkButton.addEventListener('mouseup', stopTalking);
elements.talkButton.addEventListener('mouseleave', stopTalking);

// Scroll listener for UI visibility
window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
        document.body.classList.add('scrolled');
    } else {
        document.body.classList.remove('scrolled');
    }
});

// Touch support for mobile
elements.talkButton.addEventListener('touchstart', (e) => {
    e.preventDefault();
    startTalking();
});
elements.talkButton.addEventListener('touchend', (e) => {
    e.preventDefault();
    stopTalking();
});

// ============================================
// Main Functions
// ============================================

async function startInterview() {
    try {
        updateStatus('Requesting microphone access...', 'connecting');

        // Request microphone permission
        state.localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        addLogEntry('system', 'Microphone access granted');
        updateStatus('Getting session credentials...', 'connecting');

        // Get ephemeral key from backend
        const response = await fetch(`${CONFIG.serverUrl}/api/realtime/call`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                config: {
                    model: CONFIG.model,
                    voice: CONFIG.voice
                }
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to create session');
        }

        const data = await response.json();
        state.sessionId = data.sessionId;
        const ephemeralKey = data.clientSecret.value;

        console.log('Session ID:', state.sessionId);
        console.log('Ephemeral key received');

        updateStatus('Connecting to OpenAI...', 'connecting');

        // Create RTCPeerConnection
        state.peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        // Add local audio track
        state.localStream.getTracks().forEach(track => {
            state.peerConnection.addTrack(track, state.localStream);
        });

        // Handle remote audio track
        state.peerConnection.ontrack = (event) => {
            console.log('Received remote track:', event.track.kind);
            if (event.track.kind === 'audio') {
                elements.remoteAudio.srcObject = event.streams[0];
                addLogEntry('system', 'Audio stream connected');
            }
        };

        // Create data channel for Realtime events
        state.dataChannel = state.peerConnection.createDataChannel('oai-events', {
            ordered: true
        });

        setupDataChannel();

        // Create SDP offer
        const offer = await state.peerConnection.createOffer();
        await state.peerConnection.setLocalDescription(offer);

        // Send offer to OpenAI with ephemeral key
        const sdpResponse = await fetch('https://api.openai.com/v1/realtime', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ephemeralKey}`,
                'Content-Type': 'application/sdp'
            },
            body: offer.sdp
        });

        if (!sdpResponse.ok) {
            const errorText = await sdpResponse.text();
            console.error('OpenAI SDP exchange error:', sdpResponse.status, errorText);
            throw new Error('Failed to exchange SDP with OpenAI');
        }

        const answerSdp = await sdpResponse.text();
        console.log('Received SDP answer from OpenAI');

        // Set remote description
        await state.peerConnection.setRemoteDescription({
            type: 'answer',
            sdp: answerSdp
        });

        updateStatus('Connected', 'connected');
        state.isConnected = true;

        // Update UI
        elements.startButton.disabled = true;
        elements.talkButton.disabled = false;
        elements.stopButton.disabled = false;
        elements.muteButton.disabled = false;

        addLogEntry('system', 'Connected to IELTS Examiner. The interview will begin shortly.');
        elements.currentQuestion.textContent = 'Waiting for examiner to start...';

    } catch (error) {
        console.error('Error starting interview:', error);
        updateStatus('Connection failed', 'error');
        addLogEntry('system', `Error: ${error.message}`);
        alert(`Failed to start interview: ${error.message}`);
        cleanup();
    }
}

function stopInterview() {
    addLogEntry('system', 'Interview ended by user');
    cleanup();
}

function cleanup() {
    // Close data channel
    if (state.dataChannel) {
        state.dataChannel.close();
        state.dataChannel = null;
    }

    // Close peer connection
    if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
    }

    // Stop local stream
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }

    // Reset state
    state.isConnected = false;
    state.isTalking = false;
    state.sessionId = null;

    // Update UI
    updateStatus('Not Connected', 'disconnected');
    elements.startButton.disabled = false;
    elements.talkButton.disabled = true;
    elements.stopButton.disabled = true;
    elements.muteButton.disabled = true;
    state.isMuted = false;
    updateMuteButtonUI();
    elements.currentQuestion.textContent = 'Click "Start Interview" to begin...';
}

// ============================================
// Data Channel Management
// ============================================

function setupDataChannel() {
    state.dataChannel.onopen = () => {
        console.log('Data channel opened');
        addLogEntry('system', 'Data channel established');

        // Send initial session update (already configured on server, but can override)
        // sendEvent({
        //     type: 'session.update',
        //     session: { /* additional config */ }
        // });

        // Trigger initial greeting from examiner
        sendEvent({
            type: 'response.create'
        });
    };

    state.dataChannel.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleRealtimeEvent(message);
        } catch (error) {
            console.error('Error parsing data channel message:', error);
        }
    };

    state.dataChannel.onerror = (error) => {
        console.error('Data channel error:', error);
        addLogEntry('system', 'Data channel error occurred');
    };

    state.dataChannel.onclose = () => {
        console.log('Data channel closed');
        addLogEntry('system', 'Data channel closed');
    };
}

function sendEvent(event) {
    if (state.dataChannel && state.dataChannel.readyState === 'open') {
        state.dataChannel.send(JSON.stringify(event));
        console.log('Sent event:', event.type);
    } else {
        console.warn('Data channel not ready, cannot send event');
    }
}

// ============================================
// Realtime Event Handlers
// ============================================

function handleRealtimeEvent(event) {
    console.log('Received event:', event.type, event);

    switch (event.type) {
        case 'session.created':
        case 'session.updated':
            console.log('Session configured:', event.session);
            break;

        case 'conversation.item.created':
            // New conversation item (question or response)
            handleConversationItem(event.item);
            break;

        case 'response.audio_transcript.delta':
            // Partial transcript from assistant (streaming)
            handleAssistantTranscriptDelta(event.delta);
            break;

        case 'response.audio_transcript.done':
            // Complete transcript from assistant
            handleAssistantTranscriptDone(event.transcript);
            break;

        case 'conversation.item.input_audio_transcription.completed':
            // User's speech transcription completed
            handleUserTranscript(event.transcript);
            break;

        case 'conversation.item.input_audio_transcription.failed':
            console.error('Transcription failed:', event.error);
            break;

        case 'response.done':
            // Response completed
            console.log('Response completed');
            state.turnCount++;
            break;

        case 'error':
            console.error('Realtime API error:', event.error);
            addLogEntry('system', `Error: ${event.error.message || 'Unknown error'}`);
            break;

        default:
            // Log other events for debugging
            console.log('Unhandled event type:', event.type);
    }
}

function handleConversationItem(item) {
    if (item.type === 'message' && item.role === 'assistant') {
        // This is a message from the examiner
        console.log('Assistant message:', item);
    }
}

let currentAssistantTranscript = '';

function handleAssistantTranscriptDelta(delta) {
    currentAssistantTranscript += delta;
    // Optionally update UI with partial transcript
}

function handleAssistantTranscriptDone(transcript) {
    console.log('Assistant said:', transcript);
    currentAssistantTranscript = '';

    // Update current question
    elements.currentQuestion.textContent = transcript;

    // Add to conversation log
    addLogEntry('examiner', transcript);

    // Parse for feedback and sample answer
    parseFeedback(transcript);
}

function handleUserTranscript(transcript) {
    console.log('User said:', transcript);

    // Update live transcript
    elements.liveTranscript.innerHTML = `
        <div class="transcript-item">
            <strong>You:</strong> ${escapeHtml(transcript)}
        </div>
    `;

    // Add to conversation log
    addLogEntry('user', transcript);
}

// ============================================
// Push-to-Talk Functions
// ============================================

function startTalking() {
    if (!state.isConnected || state.isTalking) return;

    state.isTalking = true;
    elements.talkButton.classList.add('talking');
    elements.talkButton.querySelector('.btn-text').textContent = 'Speaking...';

    console.log('User started talking');

    // Send event to interrupt/cancel any ongoing assistant response
    sendEvent({
        type: 'response.cancel'
    });

    // Mute remote audio while user is talking (optional)
    elements.remoteAudio.muted = true;

    // Enable microphone track
    if (state.localStream) {
        state.localStream.getAudioTracks().forEach(track => {
            track.enabled = true;
        });
    }

    // Send input_audio_buffer.commit to start capturing
    sendEvent({
        type: 'input_audio_buffer.commit'
    });
}

function stopTalking() {
    if (!state.isConnected || !state.isTalking) return;

    state.isTalking = false;
    elements.talkButton.classList.remove('talking');
    elements.talkButton.querySelector('.btn-text').textContent = 'Hold to Talk';

    console.log('User stopped talking');

    // Unmute remote audio
    elements.remoteAudio.muted = false;

    // Disable microphone track if muted, otherwise keep it disabled after talking
    if (state.localStream) {
        state.localStream.getAudioTracks().forEach(track => {
            track.enabled = state.isMuted ? false : false;
        });
    }

    // Trigger response generation
    sendEvent({
        type: 'response.create'
    });
}

// ============================================
// Mute/Unmute Functions
// ============================================

function toggleMute() {
    if (!state.isConnected) return;

    state.isMuted = !state.isMuted;

    // Update microphone track state (only when not actively talking)
    if (state.localStream && !state.isTalking) {
        state.localStream.getAudioTracks().forEach(track => {
            track.enabled = !state.isMuted;
        });
    }

    updateMuteButtonUI();

    const status = state.isMuted ? 'Microphone muted' : 'Microphone unmuted';
    addLogEntry('system', status);
    console.log(status);
}

function updateMuteButtonUI() {
    if (!elements.muteButton) return;

    const btnText = elements.muteButton.querySelector('.btn-text');
    const btnIcon = elements.muteButton.querySelector('.btn-icon svg');

    if (state.isMuted) {
        btnText.textContent = 'Unmute';
        elements.muteButton.classList.add('muted');
        // Update icon to microphone (unmuted icon)
        btnIcon.innerHTML = `
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
            <line x1="8" x2="16" y1="22" y2="22" />
        `;
    } else {
        btnText.textContent = 'Mute';
        elements.muteButton.classList.remove('muted');
        // Update icon to muted microphone icon
        btnIcon.innerHTML = `
            <line x1="1" x2="23" y1="1" y2="23" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
            <line x1="12" x2="12" y1="19" y2="22" />
        `;
    }
}

// ============================================
// UI Update Functions
// ============================================

function updateStatus(text, status) {
    elements.connectionStatus.querySelector('.status-text').textContent = text;
    elements.connectionStatus.className = 'status-indicator';

    if (status === 'connected') {
        elements.connectionStatus.classList.add('connected');
    } else if (status === 'error') {
        elements.connectionStatus.classList.add('error');
    }
}

function addLogEntry(role, content) {
    const time = new Date().toLocaleTimeString();
    const logItem = document.createElement('div');
    logItem.className = `log-item ${role}`;
    logItem.innerHTML = `
        <div class="log-header">
            <span class="log-role">${capitalizeFirst(role)}</span>
            <span class="log-time">${time}</span>
        </div>
        <div class="log-content">${escapeHtml(content)}</div>
    `;

    elements.conversationLog.appendChild(logItem);

    // Auto-scroll to bottom
    elements.conversationLog.scrollTop = elements.conversationLog.scrollHeight;

    // Store in history
    state.conversationHistory.push({ role, content, time });
}

function parseFeedback(text) {
    // Simple parsing logic to extract feedback and sample answer
    // This is a heuristic approach - adjust based on actual response format

    const lowerText = text.toLowerCase();

    // Check if this contains feedback
    if (lowerText.includes('band') || lowerText.includes('feedback')) {
        elements.feedbackContent.innerHTML = `
            <div class="feedback-item">
                ${escapeHtml(text)}
            </div>
        `;
    }

    // Check if this contains a sample answer
    if (lowerText.includes('sample') || lowerText.includes('example answer')) {
        // Extract the sample answer portion
        const sampleMatch = text.match(/sample answer[:\s]+(.*?)(?=\n\n|$)/is);
        if (sampleMatch) {
            elements.sampleAnswer.innerHTML = `
                <div class="sample-content">
                    ${escapeHtml(sampleMatch[1].trim())}
                </div>
            `;
        }
    }

    // Update part badge based on keywords
    if (lowerText.includes('part 2') || lowerText.includes('task card')) {
        state.currentPart = 2;
        elements.partBadge.textContent = 'Part 2';
    } else if (lowerText.includes('part 3')) {
        state.currentPart = 3;
        elements.partBadge.textContent = 'Part 3';
    }
}

// ============================================
// Utility Functions
// ============================================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ============================================
// Initialize
// ============================================

console.log('IELTS Speaking Interview Bot initialized');
console.log('Configuration:', CONFIG);

// Check for WebRTC support
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Your browser does not support WebRTC. Please use a modern browser like Chrome, Edge, or Firefox.');
    elements.startButton.disabled = true;
}

// ============================================
// Logo Intro Animation
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('logo-intro');

    setTimeout(() => {
        document.body.classList.remove('logo-intro');
    }, 2000);
});
