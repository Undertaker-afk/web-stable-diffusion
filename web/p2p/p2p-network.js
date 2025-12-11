/**
 * P2P Network Layer using Trystero
 * Handles peer-to-peer communication for distributed image generation
 */

// Import Trystero from CDN (using Nostr strategy by default for zero-setup)
import { joinRoom, selfId } from 'https://esm.run/trystero/nostr';

export class P2PNetwork {
    constructor(appId = 'p2p-webgpu-diffusion-v1') {
        this.appId = appId;
        this.room = null;
        this.peers = new Map();
        this.selfId = selfId;
        this.isConnected = false;
        
        // Event handlers
        this.onPeerJoinCallback = null;
        this.onPeerLeaveCallback = null;
        this.onTaskCallback = null;
        this.onResultCallback = null;
        this.onProgressCallback = null;
        this.onCapabilitiesCallback = null;
        this.onQueueUpdateCallback = null;
        
        // Actions
        this.sendTask = null;
        this.sendResult = null;
        this.sendProgress = null;
        this.sendCapabilities = null;
        this.sendQueueUpdate = null;
        this.sendChunk = null;
    }

    /**
     * Join a room and set up P2P communication
     * @param {string} roomId - The room identifier
     * @param {Object} capabilities - Local device capabilities
     */
    async join(roomId, capabilities = {}) {
        if (this.room) {
            await this.leave();
        }

        const config = {
            appId: this.appId,
            // Use TURN server for better connectivity
            rtcConfig: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        };

        this.room = joinRoom(config, roomId);
        this.isConnected = true;

        // Set up peer join/leave handlers
        this.room.onPeerJoin(peerId => {
            console.log(`Peer joined: ${peerId}`);
            this.peers.set(peerId, { id: peerId, capabilities: null, status: 'connected' });
            
            // Send our capabilities to the new peer
            if (this.sendCapabilities && capabilities) {
                this.sendCapabilities(capabilities, peerId);
            }
            
            if (this.onPeerJoinCallback) {
                this.onPeerJoinCallback(peerId);
            }
        });

        this.room.onPeerLeave(peerId => {
            console.log(`Peer left: ${peerId}`);
            this.peers.delete(peerId);
            
            if (this.onPeerLeaveCallback) {
                this.onPeerLeaveCallback(peerId);
            }
        });

        // Set up action handlers for distributed computing
        this._setupActions();

        // Broadcast our capabilities
        if (capabilities) {
            setTimeout(() => {
                if (this.sendCapabilities) {
                    this.sendCapabilities(capabilities);
                }
            }, 1000);
        }

        return this.selfId;
    }

    /**
     * Set up Trystero actions for P2P communication
     */
    _setupActions() {
        // Task distribution: Send work units to peers
        const [sendTask, getTask] = this.room.makeAction('task');
        this.sendTask = sendTask;
        getTask((task, peerId) => {
            console.log(`Received task from ${peerId}:`, task.type);
            if (this.onTaskCallback) {
                this.onTaskCallback(task, peerId);
            }
        });

        // Results: Receive computed results from peers
        const [sendResult, getResult] = this.room.makeAction('result');
        this.sendResult = sendResult;
        getResult((result, peerId) => {
            console.log(`Received result from ${peerId}`);
            if (this.onResultCallback) {
                this.onResultCallback(result, peerId);
            }
        });

        // Progress updates
        const [sendProgress, getProgress] = this.room.makeAction('progress');
        this.sendProgress = sendProgress;
        getProgress((progress, peerId) => {
            if (this.onProgressCallback) {
                this.onProgressCallback(progress, peerId);
            }
        });

        // Capabilities exchange
        const [sendCapabilities, getCapabilities] = this.room.makeAction('capabilities');
        this.sendCapabilities = sendCapabilities;
        getCapabilities((capabilities, peerId) => {
            const peer = this.peers.get(peerId);
            if (peer) {
                peer.capabilities = capabilities;
                this.peers.set(peerId, peer);
            }
            if (this.onCapabilitiesCallback) {
                this.onCapabilitiesCallback(capabilities, peerId);
            }
        });

        // Queue synchronization
        const [sendQueueUpdate, getQueueUpdate] = this.room.makeAction('queue');
        this.sendQueueUpdate = sendQueueUpdate;
        getQueueUpdate((queueData, peerId) => {
            if (this.onQueueUpdateCallback) {
                this.onQueueUpdateCallback(queueData, peerId);
            }
        });

        // Binary data chunks (for intermediate results)
        const [sendChunk, getChunk, onChunkProgress] = this.room.makeAction('chunk');
        this.sendChunk = sendChunk;
        getChunk((data, peerId, metadata) => {
            if (this.onChunkCallback) {
                this.onChunkCallback(data, peerId, metadata);
            }
        });
    }

    /**
     * Leave the current room
     */
    async leave() {
        if (this.room) {
            this.room.leave();
            this.room = null;
            this.peers.clear();
            this.isConnected = false;
        }
    }

    /**
     * Get list of connected peers
     */
    getPeers() {
        return Array.from(this.peers.values());
    }

    /**
     * Get peers with GPU capabilities
     */
    getGPUPeers() {
        return this.getPeers().filter(peer => 
            peer.capabilities && peer.capabilities.hasGPU
        );
    }

    /**
     * Broadcast a task to all peers or specific peers
     * @param {Object} task - The task to send
     * @param {Array} targetPeers - Optional array of peer IDs to target
     */
    broadcastTask(task, targetPeers = null) {
        if (!this.sendTask) return;
        
        if (targetPeers && targetPeers.length > 0) {
            this.sendTask(task, targetPeers);
        } else {
            this.sendTask(task);
        }
    }

    /**
     * Send result back to requesting peer
     * @param {Object} result - The result data
     * @param {string} peerId - Target peer ID
     */
    sendResultTo(result, peerId) {
        if (this.sendResult) {
            this.sendResult(result, peerId);
        }
    }

    /**
     * Broadcast progress update
     * @param {Object} progress - Progress information
     */
    broadcastProgress(progress) {
        if (this.sendProgress) {
            this.sendProgress(progress);
        }
    }

    /**
     * Send binary chunk data
     * @param {ArrayBuffer} data - Binary data
     * @param {string} peerId - Target peer
     * @param {Object} metadata - Metadata about the chunk
     */
    sendChunkTo(data, peerId, metadata) {
        if (this.sendChunk) {
            this.sendChunk(data, peerId, metadata);
        }
    }

    /**
     * Broadcast queue update to all peers
     * @param {Object} queueData - Queue state
     */
    broadcastQueueUpdate(queueData) {
        if (this.sendQueueUpdate) {
            this.sendQueueUpdate(queueData);
        }
    }

    // Event handler setters
    onPeerJoin(callback) { this.onPeerJoinCallback = callback; }
    onPeerLeave(callback) { this.onPeerLeaveCallback = callback; }
    onTask(callback) { this.onTaskCallback = callback; }
    onResult(callback) { this.onResultCallback = callback; }
    onProgress(callback) { this.onProgressCallback = callback; }
    onCapabilities(callback) { this.onCapabilitiesCallback = callback; }
    onQueueUpdate(callback) { this.onQueueUpdateCallback = callback; }
    onChunk(callback) { this.onChunkCallback = callback; }

    /**
     * Get ping to a specific peer
     * @param {string} peerId - Peer to ping
     */
    async ping(peerId) {
        if (this.room && this.room.ping) {
            return await this.room.ping(peerId);
        }
        return -1;
    }
}

export { selfId };
