/**
 * P2P Diffusion Application
 * Main application logic for distributed WebGPU image generation
 */

import { P2PNetwork, selfId } from './p2p-network.js';
import { WorkerCoordinator } from './worker-coordinator.js';

export class P2PDiffusion {
    constructor() {
        this.network = new P2PNetwork();
        this.coordinator = null;
        this.isConnected = false;
        this.deviceCapabilities = null;
        this.backendAvailable = false;
        
        // UI Elements
        this.elements = {};
        
        // Initialize
        this._init();
    }

    /**
     * Initialize the application
     */
    async _init() {
        this._cacheElements();
        await this._detectCapabilities();
        await this._checkBackend();
        this._generateDefaultRoomId();
        this._log('info', 'P2P Diffusion ready. Join a room to start collaborating!');
    }

    /**
     * Cache DOM elements
     */
    _cacheElements() {
        this.elements = {
            networkStatus: document.getElementById('networkStatus'),
            backendStatus: document.getElementById('backendStatus'),
            backendStatusText: document.getElementById('backendStatusText'),
            peerCount: document.getElementById('peerCount'),
            gpuWorkers: document.getElementById('gpuWorkers'),
            queueLength: document.getElementById('queueLength'),
            roomId: document.getElementById('roomId'),
            joinBtn: document.getElementById('joinBtn'),
            generateBtn: document.getElementById('generateBtn'),
            prompt: document.getElementById('prompt'),
            negativePrompt: document.getElementById('negativePrompt'),
            modelSelect: document.getElementById('modelSelect'),
            progressContainer: document.getElementById('progressContainer'),
            progressFill: document.getElementById('progressFill'),
            progressStage: document.getElementById('progressStage'),
            progressPercent: document.getElementById('progressPercent'),
            peersList: document.getElementById('peersList'),
            queueList: document.getElementById('queueList'),
            logContainer: document.getElementById('logContainer'),
            canvas: document.getElementById('canvas')
        };
    }

    /**
     * Detect device capabilities
     */
    async _detectCapabilities() {
        this.deviceCapabilities = {
            hasGPU: false,
            gpuName: 'Unknown',
            memory: navigator.deviceMemory || 4,
            cores: navigator.hardwareConcurrency || 4
        };

        // Check for WebGPU support
        if ('gpu' in navigator) {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (adapter) {
                    this.deviceCapabilities.hasGPU = true;
                    const info = adapter.info || {};
                    this.deviceCapabilities.gpuName = info.description || info.vendor || 'WebGPU Enabled';
                    this.deviceCapabilities.gpuArchitecture = info.architecture || 'unknown';
                }
            } catch (e) {
                console.warn('WebGPU not available:', e);
            }
        }

        this._log('info', `Device: ${this.deviceCapabilities.gpuName} (${this.deviceCapabilities.memory}GB RAM, ${this.deviceCapabilities.cores} cores)`);
    }

    /**
     * Check backend availability
     */
    async _checkBackend() {
        // Try to find the backend server
        const backendUrls = [
            'http://localhost:3000/api/health',
            '/api/health',
            window.location.origin + '/api/health'
        ];

        for (const url of backendUrls) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                
                const response = await fetch(url, { 
                    method: 'GET',
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    this.backendAvailable = true;
                    this.elements.backendStatus.classList.remove('unavailable');
                    this.elements.backendStatus.classList.add('available');
                    this.elements.backendStatusText.textContent = 'Connected';
                    this._log('success', 'Backend server connected');
                    return;
                }
            } catch (e) {
                // Continue trying other URLs
            }
        }

        this.backendAvailable = false;
        this.elements.backendStatus.classList.remove('available');
        this.elements.backendStatus.classList.add('unavailable');
        this.elements.backendStatusText.textContent = 'Not available (P2P only mode)';
    }

    /**
     * Generate a default room ID
     */
    _generateDefaultRoomId() {
        // Check URL for room ID
        const urlParams = new URLSearchParams(window.location.search);
        const roomFromUrl = urlParams.get('room');
        
        if (roomFromUrl) {
            this.elements.roomId.value = roomFromUrl;
        } else {
            this.generateRoomId();
        }
    }

    /**
     * Generate a random room ID
     */
    generateRoomId() {
        const adjectives = ['cosmic', 'neural', 'quantum', 'stellar', 'cyber', 'pixel', 'dream', 'neon'];
        const nouns = ['canvas', 'studio', 'forge', 'lab', 'hub', 'nexus', 'realm', 'space'];
        const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        const num = Math.floor(Math.random() * 1000);
        this.elements.roomId.value = `${adj}-${noun}-${num}`;
    }

    /**
     * Copy room ID to clipboard
     */
    async copyRoomId() {
        const roomId = this.elements.roomId.value;
        const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`;
        
        try {
            await navigator.clipboard.writeText(shareUrl);
            this._log('success', 'Room link copied to clipboard!');
        } catch (e) {
            this._log('error', 'Failed to copy room link');
        }
    }

    /**
     * Toggle network connection
     */
    async toggleConnection() {
        if (this.isConnected) {
            await this.disconnect();
        } else {
            await this.connect();
        }
    }

    /**
     * Connect to the P2P network
     */
    async connect() {
        const roomId = this.elements.roomId.value.trim();
        if (!roomId) {
            this._log('error', 'Please enter a room ID');
            return;
        }

        this.elements.joinBtn.disabled = true;
        this.elements.joinBtn.textContent = 'Connecting...';
        this.elements.networkStatus.className = 'status-indicator connecting';

        try {
            // Join the P2P network
            const peerId = await this.network.join(roomId, this.deviceCapabilities);
            
            // Initialize the coordinator
            this.coordinator = new WorkerCoordinator(this.network, peerId);
            this.coordinator.setLocalCapabilities(this.deviceCapabilities);
            
            // Set up coordinator callbacks
            this._setupCoordinatorCallbacks();

            // Check backend connection through coordinator
            if (this.backendAvailable) {
                await this.coordinator.checkBackend();
            }

            this.isConnected = true;
            this.elements.joinBtn.textContent = 'Leave Network';
            this.elements.joinBtn.disabled = false;
            this.elements.networkStatus.className = 'status-indicator connected';
            this.elements.generateBtn.disabled = false;

            // Update URL with room ID
            const url = new URL(window.location);
            url.searchParams.set('room', roomId);
            window.history.replaceState({}, '', url);

            this._log('success', `Connected to room "${roomId}"`);
            this._log('info', `Your peer ID: ${peerId.slice(0, 12)}...`);

            // Set up network callbacks
            this._setupNetworkCallbacks();
            
            // Update stats
            this._updateStats();

        } catch (e) {
            console.error('Connection error:', e);
            this._log('error', `Connection failed: ${e.message}`);
            this.elements.joinBtn.disabled = false;
            this.elements.joinBtn.textContent = 'Join Network';
            this.elements.networkStatus.className = 'status-indicator disconnected';
        }
    }

    /**
     * Disconnect from the P2P network
     */
    async disconnect() {
        await this.network.leave();
        this.isConnected = false;
        this.coordinator = null;
        
        this.elements.joinBtn.textContent = 'Join Network';
        this.elements.networkStatus.className = 'status-indicator disconnected';
        this.elements.generateBtn.disabled = true;
        
        this._updatePeersList([]);
        this._updateStats();
        
        this._log('info', 'Disconnected from network');
    }

    /**
     * Set up network event callbacks
     */
    _setupNetworkCallbacks() {
        this.network.onPeerJoin((peerId) => {
            this._log('info', `Peer ${peerId.slice(0, 8)}... joined`);
            this._updatePeersList(this.network.getPeers());
            this._updateStats();
        });

        this.network.onPeerLeave((peerId) => {
            this._log('warning', `Peer ${peerId.slice(0, 8)}... left`);
            this._updatePeersList(this.network.getPeers());
            this._updateStats();
        });

        this.network.onCapabilities((capabilities, peerId) => {
            this._updatePeersList(this.network.getPeers());
            this._updateStats();
        });
    }

    /**
     * Set up coordinator callbacks
     */
    _setupCoordinatorCallbacks() {
        this.coordinator.onProgress((progress) => {
            this._updateProgress(progress);
        });

        this.coordinator.onComplete((task) => {
            this._onGenerationComplete(task);
        });

        this.coordinator.onQueueChange((queue) => {
            this._updateQueueList(queue);
            this._updateStats();
        });

        this.coordinator.onLog((message) => {
            this._log('info', message);
        });
    }

    /**
     * Start image generation
     */
    async startGeneration() {
        if (!this.isConnected || !this.coordinator) {
            this._log('error', 'Please connect to a room first');
            return;
        }

        const prompt = this.elements.prompt.value.trim();
        if (!prompt) {
            this._log('error', 'Please enter a prompt');
            return;
        }

        const negativePrompt = this.elements.negativePrompt.value.trim();
        const model = this.elements.modelSelect.value;

        // Show progress container
        this.elements.progressContainer.style.display = 'block';
        this.elements.generateBtn.disabled = true;
        this._updateProgress({ progress: 0, stage: 'Initializing...' });

        try {
            const taskId = await this.coordinator.addTask(prompt, negativePrompt, { model });
            this._log('info', `Generation started (task: ${taskId.slice(0, 12)}...)`);
        } catch (e) {
            this._log('error', `Generation failed: ${e.message}`);
            this.elements.generateBtn.disabled = false;
            this.elements.progressContainer.style.display = 'none';
        }
    }

    /**
     * Update progress display
     */
    _updateProgress(progress) {
        const percent = Math.round(progress.progress * 100);
        this.elements.progressFill.style.width = `${percent}%`;
        this.elements.progressPercent.textContent = `${percent}%`;
        
        if (progress.stage) {
            this.elements.progressStage.textContent = progress.stage;
        } else if (progress.step && progress.totalSteps) {
            this.elements.progressStage.textContent = `Step ${progress.step}/${progress.totalSteps}`;
        }
    }

    /**
     * Handle generation completion
     */
    _onGenerationComplete(task) {
        this._log('success', `Generation complete!`);
        this.elements.generateBtn.disabled = false;
        this.elements.progressContainer.style.display = 'none';
        
        // For now, show a placeholder image
        this._drawPlaceholderImage(task.prompt);
    }

    /**
     * Draw a placeholder image on the canvas
     */
    _drawPlaceholderImage(prompt) {
        const canvas = this.elements.canvas;
        const ctx = canvas.getContext('2d');
        
        // Create gradient background
        const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        gradient.addColorStop(0, '#6366f1');
        gradient.addColorStop(0.5, '#a855f7');
        gradient.addColorStop(1, '#ec4899');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        // Add text
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.font = 'bold 32px -apple-system, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('P2P Generation Complete!', canvas.width / 2, canvas.height / 2 - 40);
        
        ctx.font = '18px -apple-system, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        
        // Wrap prompt text
        const words = prompt.split(' ');
        let line = '';
        let y = canvas.height / 2 + 20;
        
        for (const word of words) {
            const testLine = line + word + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > canvas.width - 100 && line) {
                ctx.fillText(line, canvas.width / 2, y);
                line = word + ' ';
                y += 25;
            } else {
                line = testLine;
            }
        }
        ctx.fillText(line, canvas.width / 2, y);
        
        // Add info
        ctx.font = '14px -apple-system, sans-serif';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.fillText('(Actual model integration requires WebGPU model runtime)', canvas.width / 2, canvas.height - 40);
    }

    /**
     * Update peers list display
     */
    _updatePeersList(peers) {
        if (peers.length === 0) {
            this.elements.peersList.innerHTML = `
                <p style="color: var(--text-muted); text-align: center; padding: 1rem;">
                    No peers connected yet. Share your room ID to collaborate!
                </p>
            `;
            return;
        }

        this.elements.peersList.innerHTML = peers.map(peer => `
            <div class="peer-item">
                <div class="peer-info">
                    <span class="status-indicator ${peer.status === 'connected' ? 'connected' : 'working'}"></span>
                    <span>${peer.id.slice(0, 12)}...</span>
                </div>
                <span class="peer-status ${peer.capabilities?.hasGPU ? '' : 'warning'}">
                    ${peer.capabilities?.hasGPU ? '🖥️ GPU' : '💻 CPU'}
                </span>
            </div>
        `).join('');
    }

    /**
     * Update queue list display
     */
    _updateQueueList(queue) {
        if (queue.length === 0) {
            this.elements.queueList.innerHTML = `
                <p style="color: var(--text-muted); text-align: center; padding: 1rem;">
                    Queue is empty. Submit a prompt to start generating!
                </p>
            `;
            return;
        }

        this.elements.queueList.innerHTML = queue.map((task, index) => `
            <div class="queue-item">
                <div class="queue-number">${index + 1}</div>
                <div class="queue-prompt" title="${task.prompt}">${task.prompt}</div>
                <div class="queue-status">${task.status}</div>
            </div>
        `).join('');
    }

    /**
     * Update stats display
     */
    _updateStats() {
        const peers = this.network.getPeers();
        const gpuPeers = peers.filter(p => p.capabilities?.hasGPU).length;
        
        this.elements.peerCount.textContent = peers.length;
        this.elements.gpuWorkers.textContent = gpuPeers + (this.deviceCapabilities?.hasGPU ? 1 : 0);
        this.elements.queueLength.textContent = this.coordinator?.getQueue().length || 0;
    }

    /**
     * Log message to UI
     */
    _log(type, message) {
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${timestamp}] ${message}`;
        
        this.elements.logContainer.appendChild(entry);
        this.elements.logContainer.scrollTop = this.elements.logContainer.scrollHeight;
        
        // Keep only last 100 entries
        while (this.elements.logContainer.children.length > 100) {
            this.elements.logContainer.removeChild(this.elements.logContainer.firstChild);
        }
    }

    /**
     * Download the generated image
     */
    downloadImage() {
        const canvas = this.elements.canvas;
        const link = document.createElement('a');
        link.download = `p2p-diffusion-${Date.now()}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();
    }

    /**
     * Share the generated image
     */
    async shareImage() {
        const canvas = this.elements.canvas;
        
        try {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            const file = new File([blob], 'p2p-diffusion.png', { type: 'image/png' });
            
            if (navigator.share && navigator.canShare({ files: [file] })) {
                await navigator.share({
                    files: [file],
                    title: 'P2P Diffusion Image',
                    text: 'Generated with P2P WebGPU Diffusion'
                });
            } else {
                // Fallback: download
                this.downloadImage();
            }
        } catch (e) {
            console.error('Share failed:', e);
            this.downloadImage();
        }
    }
}
